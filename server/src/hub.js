import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { metrics } from './metrics.js';
import { channels } from './store.js';

const MAX_BUFFERED_BYTES = 1 << 20;
const PRESENCE_SNAPSHOT_LIMIT = 200;

export class Hub {
  constructor(store) {
    this.store = store;
    this.conns = new Map();
    this.byUser = new Map();
    this.byGame = new Map();
    this.presenceTotal = 0;
    this.pendingPresence = { joined: new Map(), left: new Set(), changed: new Map() };
    this.presenceTimer = null;
    store.sub.subscribe(channels.presence);
    store.sub.on('message', (channel, raw) => this.onBroker(channel, raw));
    store.sub.on('ready', () => this.resubscribe());
  }

  // Après une coupure Redis, ioredis rétablit seul les abonnements, mais on journalise.
  resubscribe() {
    log.info('broker.ready', { games: this.byGame.size, users: this.byUser.size });
  }

  onBroker(channel, raw) {
    if (channel === channels.presence) {
      this.mergePresence(JSON.parse(raw));
    } else if (channel.startsWith('bn:ch:game:')) {
      const gameId = channel.slice('bn:ch:game:'.length);
      const conns = this.byGame.get(gameId);
      if (!conns) return;
      const { ts, type } = JSON.parse(raw);
      for (const conn of conns) this.sendRaw(conn, raw, type);
      if (conns.size) metrics.latency.observe((Date.now() - ts) / 1000);
    } else {
      const userId = channel.slice('bn:ch:user:'.length);
      const conns = this.byUser.get(userId);
      if (!conns) return;
      const { type } = JSON.parse(raw);
      for (const conn of conns) this.sendRaw(conn, raw, type);
    }
  }

  sendRaw(conn, raw, type) {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    // Client trop lent : on coupe plutôt que de laisser la mémoire de l'instance gonfler.
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      metrics.errors.inc({ code: 'SLOW_CONSUMER' });
      conn.ws.close(1013, 'slow consumer');
      return;
    }
    conn.ws.send(raw);
    metrics.messages.inc({ direction: 'out', type });
    metrics.bytes.inc({ direction: 'out' }, raw.length);
  }

  send(conn, type, payload = {}) {
    this.sendRaw(conn, JSON.stringify({ id: randomUUID(), type, ts: Date.now(), payload }), type);
  }

  sendError(conn, ref, code, message) {
    metrics.errors.inc({ code });
    this.send(conn, 'sys.error', { ref, code, message });
  }

  sendToUser(userId, type, payload = {}) {
    return this.store.publish(channels.user(userId), { id: randomUUID(), type, ts: Date.now(), payload });
  }

  async register(conn) {
    this.conns.set(conn.id, conn);
    let userConns = this.byUser.get(conn.user.id);
    if (!userConns) {
      userConns = new Set();
      this.byUser.set(conn.user.id, userConns);
      await this.store.sub.subscribe(channels.user(conn.user.id));
    }
    userConns.add(conn);
    metrics.connections.set(this.conns.size);
    const activeGame = await this.store.getActive(conn.user.id);
    const user = { ...conn.user, status: activeGame ? 'playing' : 'lobby' };
    const isFirstConnection = await this.store.presenceAdd(conn.id, user, Date.now());
    if (isFirstConnection) await this.store.publish(channels.presence, { joined: [user] });
    const presence = await this.store.presenceSnapshot(PRESENCE_SNAPSHOT_LIMIT);
    this.presenceTotal = presence.total;
    return { activeGame, presence };
  }

  async unregister(conn) {
    if (!this.conns.delete(conn.id)) return [];
    metrics.connections.set(this.conns.size);
    const leftGames = [];
    for (const gameId of conn.games) {
      const remaining = this.detachGame(conn, gameId);
      if (!remaining) leftGames.push(gameId);
    }
    const userConns = this.byUser.get(conn.user.id);
    userConns?.delete(conn);
    if (userConns?.size === 0) {
      this.byUser.delete(conn.user.id);
      await this.store.sub.unsubscribe(channels.user(conn.user.id));
    }
    const gone = await this.store.presenceRemove(conn.id);
    if (gone) await this.store.publish(channels.presence, { left: [gone] });
    return leftGames;
  }

  async attachGame(conn, gameId) {
    conn.games.add(gameId);
    let conns = this.byGame.get(gameId);
    if (!conns) {
      conns = new Set();
      this.byGame.set(gameId, conns);
      // On s'abonne AVANT de lire le journal : aucun événement ne tombe dans l'intervalle.
      // Un événement peut donc arriver deux fois ; le client le dédoublonne par seq.
      await this.store.sub.subscribe(channels.game(gameId));
    }
    conns.add(conn);
  }

  /** @returns le nombre de connexions de CET utilisateur encore attachées à la partie ici. */
  detachGame(conn, gameId) {
    conn.games.delete(gameId);
    const conns = this.byGame.get(gameId);
    if (!conns) return 0;
    conns.delete(conn);
    if (conns.size === 0) {
      this.byGame.delete(gameId);
      this.store.sub.unsubscribe(channels.game(gameId)).catch(() => {});
      return 0;
    }
    return [...conns].filter((c) => c.user.id === conn.user.id).length;
  }

  mergePresence(delta) {
    const p = this.pendingPresence;
    for (const u of delta.joined ?? []) {
      if (p.left.delete(u.id)) p.changed.set(u.id, u);
      else p.joined.set(u.id, u);
    }
    for (const id of delta.left ?? []) {
      p.changed.delete(id);
      if (!p.joined.delete(id)) p.left.add(id);
    }
    for (const u of delta.changed ?? []) {
      if (p.joined.has(u.id)) p.joined.set(u.id, u);
      else p.changed.set(u.id, u);
    }
    if (config.presenceBatchMs === 0) this.flushPresence();
    else this.presenceTimer ??= setTimeout(() => this.flushPresence(), config.presenceBatchMs);
  }

  flushPresence() {
    this.presenceTimer = null;
    const p = this.pendingPresence;
    if (!p.joined.size && !p.left.size && !p.changed.size) return;
    this.presenceTotal += p.joined.size - p.left.size;
    const raw = JSON.stringify({
      id: randomUUID(),
      type: 'presence.delta',
      ts: Date.now(),
      payload: {
        joined: [...p.joined.values()], left: [...p.left], changed: [...p.changed.values()],
        total: Math.max(0, this.presenceTotal),
      },
    });
    this.pendingPresence = { joined: new Map(), left: new Set(), changed: new Map() };
    for (const conn of this.conns.values()) this.sendRaw(conn, raw, 'presence.delta');
  }

  async setStatus(user, status) {
    const next = { id: user.id, name: user.name, status };
    if (await this.store.presenceSetStatus(next)) {
      await this.store.publish(channels.presence, { changed: [next] });
    }
  }

  /** Ping protocolaire + rafraîchissement de la présence : une connexion muette tombe en ≤ 2 périodes. */
  heartbeat() {
    for (const conn of this.conns.values()) {
      if (!conn.alive) {
        conn.closeReason = 'heartbeat_timeout';
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
    return this.store.presenceTouch([...this.conns.keys()], Date.now());
  }

  /** Rattrape les connexions d'une instance morte sans fermeture propre. */
  async sweepPresence() {
    const expired = await this.store.presenceExpired(Date.now() - config.presenceTtlMs);
    for (const connId of expired) {
      const gone = await this.store.presenceRemove(connId);
      if (gone) await this.store.publish(channels.presence, { left: [gone] });
    }
  }

  shutdown() {
    this.flushPresence();
    for (const conn of this.conns.values()) {
      this.send(conn, 'sys.shutdown', { reconnectInMs: 250 });
      conn.closeReason = 'server_shutdown';
      conn.ws.close(1012, 'instance stopping');
    }
  }
}
