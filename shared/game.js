// Règles pures de la bataille navale : aucune E/S ici. Le serveur (autorité) et le
// client (retour immédiat au placement) partagent ce module.

export const BOARD_SIZE = 10;
export const FLEET = Object.freeze([
  // `size` : longueur, `width` : largeur. Le porte-avions occupe 5 × 2 cases.
  { type: 'carrier', name: 'Porte-avions', size: 5, width: 2 },
  { type: 'battleship', name: 'Cuirassé', size: 4, width: 1 },
  { type: 'cruiser', name: 'Croiseur', size: 3, width: 1 },
  { type: 'submarine', name: 'Sous-marin', size: 3, width: 1 },
  { type: 'destroyer', name: 'Torpilleur', size: 2, width: 1 },
]);
export const MAX_TIMEOUTS = 3;

const SHAPE_BY_TYPE = Object.fromEntries(FLEET.map((s) => [s.type, s]));
export const key = (x, y) => `${x},${y}`;
export const other = (p) => (p === 'p1' ? 'p2' : 'p1');

/** Cases couvertes, la première et la dernière étant deux coins opposés. (x, y) est le coin haut-gauche. */
export function shipCells({ type, x, y, dir }) {
  const { size, width } = SHAPE_BY_TYPE[type];
  const cells = [];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < width; j++) cells.push(dir === 'h' ? { x: x + i, y: y + j } : { x: x + j, y: y + i });
  }
  return cells;
}

/** Retourne null si la flotte est valide, sinon le motif du refus. */
export function validateFleet(fleet) {
  if (!Array.isArray(fleet) || fleet.length !== FLEET.length) return 'La flotte doit compter 5 navires';
  const types = new Set(fleet.map((s) => s.type));
  if (types.size !== FLEET.length || FLEET.some((s) => !types.has(s.type))) return 'Types de navires incorrects';
  const seen = new Set();
  for (const ship of fleet) {
    for (const c of shipCells(ship)) {
      if (c.x < 0 || c.y < 0 || c.x >= BOARD_SIZE || c.y >= BOARD_SIZE) return `${ship.type} sort de la grille`;
      if (seen.has(key(c.x, c.y))) return 'Deux navires se chevauchent';
      seen.add(key(c.x, c.y));
    }
  }
  return null;
}

export function randomFleet(rng = Math.random) {
  for (;;) {
    const fleet = [];
    const seen = new Set();
    for (const { type, size, width } of FLEET) {
      for (let tries = 0; tries < 200; tries++) {
        const dir = rng() < 0.5 ? 'h' : 'v';
        const x = Math.floor(rng() * (BOARD_SIZE - (dir === 'h' ? size : width) + 1));
        const y = Math.floor(rng() * (BOARD_SIZE - (dir === 'v' ? size : width) + 1));
        const ship = { type, x, y, dir };
        const cells = shipCells(ship);
        if (cells.every((c) => !seen.has(key(c.x, c.y)))) {
          cells.forEach((c) => seen.add(key(c.x, c.y)));
          fleet.push(ship);
          break;
        }
      }
    }
    if (fleet.length === FLEET.length) return fleet;
  }
}

export function newGame({ id, p1, p2, now, placementMs }) {
  const mk = (u) => ({ id: u.id, name: u.name, fleet: null, ready: false, shots: [], timeouts: 0 });
  return {
    id, seq: 0, phase: 'placement', createdAt: now, turn: null, deadline: now + placementMs,
    winner: null, reason: null, rematch: [], players: { p1: mk(p1), p2: mk(p2) },
  };
}

export const playerOf = (game, userId) => {
  if (game.players.p1.id === userId) return 'p1';
  return game.players.p2.id === userId ? 'p2' : null;
};

function startBattle(g, now, turnMs, rng, events) {
  g.phase = 'battle';
  g.turn = rng() < 0.5 ? 'p1' : 'p2';
  g.deadline = now + turnMs;
  events.push({ type: 'game.battle_started', payload: { firstTurn: g.turn, deadline: g.deadline } });
}

function finish(g, winner, reason, events) {
  g.phase = 'finished';
  g.winner = winner;
  g.reason = reason;
  g.turn = null;
  g.deadline = null;
  events.push({
    type: 'game.finished',
    payload: { winner, reason, fleets: { p1: g.players.p1.fleet ?? [], p2: g.players.p2.fleet ?? [] } },
  });
}

/** Place la flotte. Retourne { game, events } ou { error }. Ne mute jamais l'état reçu. */
export function place(game, player, fleet, { now, turnMs, rng = Math.random }) {
  if (game.phase !== 'placement') return { error: 'WRONG_PHASE' };
  if (game.players[player].ready) return { error: 'ALREADY_READY' };
  const invalid = validateFleet(fleet);
  if (invalid) return { error: 'INVALID_FLEET', message: invalid };
  const g = structuredClone(game);
  g.players[player].fleet = fleet;
  g.players[player].ready = true;
  const events = [{ type: 'game.player_ready', payload: { player } }];
  if (g.players[other(player)].ready) startBattle(g, now, turnMs, rng, events);
  return { game: g, events };
}

export function fire(game, player, x, y, { now, turnMs, clientTs = null }) {
  if (game.phase !== 'battle') return { error: 'WRONG_PHASE' };
  if (game.turn !== player) return { error: 'NOT_YOUR_TURN' };
  if (game.players[player].shots.some((s) => s.x === x && s.y === y)) return { error: 'ALREADY_FIRED' };
  const g = structuredClone(game);
  const attacker = g.players[player];
  const defender = g.players[other(player)];
  attacker.timeouts = 0;
  const target = defender.fleet.find((s) => shipCells(s).some((c) => c.x === x && c.y === y));
  const shot = { x, y, result: 'miss' };
  let sunk = null;
  if (target) {
    const cells = shipCells(target);
    const previous = attacker.shots.filter((s) => cells.some((c) => c.x === s.x && c.y === s.y)).length;
    // Un navire n'est coulé qu'une fois toutes ses cases touchées (10 pour le porte-avions).
    shot.result = previous + 1 === cells.length ? 'sunk' : 'hit';
    if (shot.result === 'sunk') {
      sunk = target;
      shot.ship = target;
    }
  }
  attacker.shots.push(shot);
  const allSunk = defender.fleet.every((s) =>
    shipCells(s).every((c) => attacker.shots.some((t) => t.x === c.x && t.y === c.y)));
  const events = [];
  const payload = { by: player, x, y, result: shot.result, ship: sunk, clientTs };
  if (allSunk) {
    events.push({ type: 'game.shot', payload: { ...payload, nextTurn: null, deadline: null } });
    finish(g, player, 'fleet_destroyed', events);
  } else {
    // Touché ou coulé : le tireur rejoue. Le tour ne passe qu'après un tir à l'eau.
    g.turn = shot.result === 'miss' ? other(player) : player;
    g.deadline = now + turnMs;
    events.push({ type: 'game.shot', payload: { ...payload, nextTurn: g.turn, deadline: g.deadline } });
  }
  return { game: g, events };
}

export function forfeit(game, player) {
  if (game.phase === 'finished') return { error: 'WRONG_PHASE' };
  const g = structuredClone(game);
  const events = [];
  finish(g, other(player), 'forfeit', events);
  return { game: g, events };
}

/** Échéance dépassée : flotte aléatoire au placement, tour perdu en bataille, défaite après MAX_TIMEOUTS. */
export function expire(game, { now, turnMs, rng = Math.random }) {
  if (!game.deadline || now < game.deadline) return { error: 'NOT_EXPIRED' };
  const g = structuredClone(game);
  const events = [];
  if (g.phase === 'placement') {
    for (const p of ['p1', 'p2']) {
      if (!g.players[p].ready) {
        g.players[p].fleet = randomFleet(rng);
        g.players[p].ready = true;
        events.push({ type: 'game.player_ready', payload: { player: p, auto: true } });
      }
    }
    startBattle(g, now, turnMs, rng, events);
    return { game: g, events };
  }
  if (g.phase === 'battle') {
    const p = g.turn;
    g.players[p].timeouts += 1;
    if (g.players[p].timeouts >= MAX_TIMEOUTS) {
      finish(g, other(p), 'timeout', events);
    } else {
      g.turn = other(p);
      g.deadline = now + turnMs;
      events.push({
        type: 'game.turn_skipped',
        payload: { player: p, timeouts: g.players[p].timeouts, nextTurn: g.turn, deadline: g.deadline },
      });
    }
    return { game: g, events };
  }
  return { error: 'WRONG_PHASE' };
}

/** Vue personnalisée : ne contient jamais la position d'un navire adverse encore à flot. */
export function viewFor(game, player) {
  const foe = other(player);
  const me = game.players[player];
  const them = game.players[foe];
  return {
    gameId: game.id,
    seq: game.seq,
    phase: game.phase,
    you: player,
    turn: game.turn,
    deadline: game.deadline,
    winner: game.winner,
    reason: game.reason,
    me: { name: me.name, ready: me.ready, fleet: me.fleet, shots: me.shots },
    foe: {
      name: them.name,
      ready: them.ready,
      shots: them.shots,
      sunk: me.shots.filter((s) => s.ship).map((s) => s.ship),
      fleet: game.phase === 'finished' ? them.fleet : null,
    },
  };
}
