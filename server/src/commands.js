import { randomBytes, randomUUID } from 'node:crypto';
import { expire, fire, forfeit, newGame, place, playerOf, viewFor } from '../../shared/game.js';
import { config } from './config.js';
import { log } from './log.js';
import { metrics } from './metrics.js';

const ROOM_TTL_SECONDS = 600;
const MAX_CAS_RETRIES = 8;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode = () => [...randomBytes(6)].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
const publicUser = ({ id, name }) => ({ id, name });

class CommandError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export class Commands {
  constructor(store, hub) {
    this.store = store;
    this.hub = hub;
    this.handlers = {
      'sys.ping': this.ping,
      'match.queue': this.queue,
      'match.cancel': this.cancel,
      'room.create': this.createRoom,
      'room.join': this.joinRoom,
      'game.resume': this.resume,
      'game.place': this.place,
      'game.fire': this.fire,
      'game.forfeit': this.forfeit,
      'game.rematch': this.rematch,
      'chat.send': this.chat,
    };
  }

  /** Aucune exception ne remonte à la boucle d'événements : le serveur survit à toute commande. */
  async dispatch(conn, msg, rx) {
    try {
      const duplicate = await this.handlers[msg.type].call(this, conn, msg.payload, msg.id, rx);
      if (msg.type !== 'sys.ping') this.hub.send(conn, 'sys.ack', { ref: msg.id, duplicate: duplicate === true });
    } catch (err) {
      if (err instanceof CommandError) {
        this.hub.sendError(conn, msg.id, err.code, err.message);
      } else {
        log.error('command.failed', { type: msg.type, error: err.message });
        this.hub.sendError(conn, msg.id, 'INTERNAL', 'Erreur interne');
      }
    }
  }

  ping(conn, { clientTs }) {
    this.hub.send(conn, 'sys.pong', { clientTs, instance: config.instance });
  }

  async queue(conn) {
    const me = publicUser(conn.user);
    if (await this.store.getActive(me.id)) throw new CommandError('WRONG_PHASE', 'Partie déjà en cours');
    const opponent = await this.store.queueOrMatch(me);
    if (opponent) await this.createGame(JSON.parse(opponent), me);
    else {
      this.hub.send(conn, 'match.queued');
      await this.hub.setStatus(me, 'queue');
    }
  }

  async cancel(conn) {
    await this.store.leaveQueue(publicUser(conn.user));
    this.hub.send(conn, 'match.cancelled');
    await this.hub.setStatus(conn.user, 'lobby');
  }

  async createRoom(conn, { invite }) {
    let code;
    do code = roomCode();
    while (!(await this.store.createRoom(code, publicUser(conn.user), ROOM_TTL_SECONDS)));
    this.hub.send(conn, 'room.created', { code, expiresInMs: ROOM_TTL_SECONDS * 1000 });
    if (invite) await this.hub.sendToUser(invite, 'room.invited', { code, from: publicUser(conn.user) });
  }

  async joinRoom(conn, { code }) {
    const host = await this.store.takeRoom(code);
    if (!host) throw new CommandError('NOT_FOUND', 'Salon introuvable ou expiré');
    if (host.id === conn.user.id) {
      await this.store.createRoom(code, host, ROOM_TTL_SECONDS);
      throw new CommandError('FORBIDDEN', 'Vous êtes déjà l\'hôte de ce salon');
    }
    await this.createGame(host, publicUser(conn.user));
  }

  async createGame(a, b) {
    const [p1, p2] = Math.random() < 0.5 ? [a, b] : [b, a];
    const game = newGame({ id: randomUUID(), p1, p2, now: Date.now(), placementMs: config.placementMs });
    await this.store.applyGame(game, 0, []);
    await Promise.all([this.store.setActive(p1.id, game.id), this.store.setActive(p2.id, game.id)]);
    metrics.games.inc({ state: 'created' });
    await Promise.all([
      this.hub.sendToUser(p1.id, 'match.found', { gameId: game.id, you: 'p1', opponent: p2 }),
      this.hub.sendToUser(p2.id, 'match.found', { gameId: game.id, you: 'p2', opponent: p1 }),
      this.hub.setStatus(p1, 'playing'),
      this.hub.setStatus(p2, 'playing'),
    ]);
    log.info('game.created', { gameId: game.id, p1: p1.name, p2: p2.name });
    return game;
  }

  /**
   * Boucle de concurrence optimiste : relire, décider, écrire si personne n'a écrit entre-temps.
   * Le décideur est pur, il peut être rejoué sans effet de bord.
   */
  async mutate(gameId, decide, { commandKey, rx = Date.now() } = {}) {
    if (commandKey && (await this.store.redis.exists(commandKey))) {
      metrics.duplicates.inc();
      return { duplicate: true };
    }
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const game = await this.store.loadGame(gameId);
      if (!game) throw new CommandError('NOT_FOUND', 'Partie introuvable');
      const result = decide(game);
      if (result.error) throw new CommandError(result.error, result.message ?? result.error);
      const envelopes = result.events.map((e, i) => ({
        id: randomUUID(), type: e.type, ts: rx, gameId, seq: game.seq + i + 1, payload: e.payload,
      }));
      const next = { ...result.game, seq: game.seq + envelopes.length };
      const status = await this.store.applyGame(next, game.seq, envelopes, commandKey);
      if (status === 'ok') {
        if (next.phase === 'finished' && game.phase !== 'finished') await this.onFinished(next);
        return { game: next };
      }
      if (status === 'duplicate') {
        metrics.duplicates.inc();
        return { duplicate: true };
      }
      metrics.casConflicts.inc();
    }
    throw new CommandError('CONFLICT', 'Trop d\'écritures concurrentes');
  }

  async onFinished(game) {
    metrics.games.inc({ state: 'finished' });
    await Promise.all(['p1', 'p2'].flatMap((p) => {
      const { id, name } = game.players[p];
      return [this.store.clearActive(id, game.id), this.hub.setStatus({ id, name }, 'lobby')];
    }));
    log.info('game.finished', { gameId: game.id, winner: game.winner, reason: game.reason });
  }

  playerIn(game, conn) {
    const player = playerOf(game, conn.user.id);
    if (!player) throw new CommandError('FORBIDDEN', 'Vous ne participez pas à cette partie');
    return player;
  }

  async resume(conn, { gameId, lastSeq }, _id, rx) {
    const initial = await this.store.loadGame(gameId);
    if (!initial) throw new CommandError('NOT_FOUND', 'Partie introuvable');
    this.playerIn(initial, conn);
    await this.hub.attachGame(conn, gameId);
    const events = lastSeq > 0 ? await this.store.eventsAfter(gameId, lastSeq) : null;
    if (events) {
      for (const e of events) this.hub.sendRaw(conn, JSON.stringify(e), e.type);
      metrics.replayed.inc(events.length);
      log.info('game.replayed', { gameId, lastSeq, events: events.length, user: conn.user.name });
    } else {
      const game = await this.store.loadGame(gameId);
      this.hub.send(conn, 'game.snapshot', viewFor(game, playerOf(game, conn.user.id)));
    }
    if (initial.phase !== 'finished') await this.announceConnection(gameId, conn.user.id, true, rx);
  }

  async announceConnection(gameId, userId, online, rx) {
    await this.mutate(gameId, (game) => {
      const player = playerOf(game, userId);
      if (!player || game.phase === 'finished') return { game, events: [] };
      return { game, events: [{ type: 'game.player_connection', payload: { player, online } }] };
    }, { rx });
  }

  place(conn, { gameId, fleet }, id, rx) {
    return this.command(conn, gameId, id, rx, (game, player) =>
      place(game, player, fleet, { now: rx, turnMs: config.turnMs }));
  }

  fire(conn, { gameId, x, y, clientTs }, id, rx) {
    return this.command(conn, gameId, id, rx, (game, player) =>
      fire(game, player, x, y, { now: rx, turnMs: config.turnMs, clientTs: clientTs ?? null }));
  }

  forfeit(conn, { gameId }, id, rx) {
    return this.command(conn, gameId, id, rx, (game, player) => forfeit(game, player));
  }

  chat(conn, { gameId, text }, id, rx) {
    return this.command(conn, gameId, id, rx, (game, player) => ({
      game,
      events: [{ type: 'chat.message', payload: { player, name: game.players[player].name, text: text.trim() } }],
    }));
  }

  async rematch(conn, { gameId }, id, rx) {
    let launch = null;
    const duplicate = await this.command(conn, gameId, id, rx, (game, player) => {
      if (game.phase !== 'finished') return { error: 'WRONG_PHASE' };
      if (game.rematch.includes(player)) return { game, events: [] };
      const next = structuredClone(game);
      next.rematch.push(player);
      launch = next.rematch.length === 2 ? next : null;
      return { game: next, events: [{ type: 'game.rematch_offered', payload: { by: player } }] };
    });
    if (launch) await this.createGame(publicUser(launch.players.p1), publicUser(launch.players.p2));
    return duplicate;
  }

  async command(conn, gameId, id, rx, decide) {
    const { duplicate } = await this.mutate(
      gameId,
      (game) => decide(game, this.playerIn(game, conn)),
      { commandKey: this.store.commandKey(conn.user.id, id), rx },
    );
    return duplicate;
  }

  /** Échéances : chaque instance balaie, le compare-and-set garantit un seul gagnant. */
  async sweepDeadlines() {
    const now = Date.now();
    for (const gameId of await this.store.dueGames(now)) {
      try {
        const res = await this.mutate(gameId, (game) => {
          const r = expire(game, { now, turnMs: config.turnMs });
          return r.error ? { game, events: [], skip: true } : r;
        }, { rx: now });
        if (res.game?.deadline === null) await this.store.redis.zrem('bn:deadlines', gameId);
      } catch (err) {
        if (err.code === 'NOT_FOUND') await this.store.redis.zrem('bn:deadlines', gameId);
        else log.warn('deadline.failed', { gameId, error: err.message });
      }
    }
  }
}
