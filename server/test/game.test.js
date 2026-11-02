import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expire, fire, forfeit, MAX_TIMEOUTS, newGame, place, randomFleet, shipCells, validateFleet, viewFor,
} from '../../shared/game.js';

const ctx = { now: 1000, turnMs: 100, rng: () => 0.1 };
const fleetA = [
  { type: 'carrier', x: 0, y: 0, dir: 'h' }, { type: 'battleship', x: 0, y: 2, dir: 'h' },
  { type: 'cruiser', x: 0, y: 3, dir: 'h' }, { type: 'submarine', x: 0, y: 4, dir: 'h' },
  { type: 'destroyer', x: 0, y: 5, dir: 'h' },
];
const started = () => {
  let g = newGame({ id: 'g', p1: { id: 'a', name: 'A' }, p2: { id: 'b', name: 'B' }, now: 0, placementMs: 500 });
  g = place(g, 'p1', fleetA, ctx).game;
  return place(g, 'p2', fleetA, ctx).game;
};

test('une flotte aléatoire est toujours valide', () => {
  for (let i = 0; i < 500; i++) assert.equal(validateFleet(randomFleet()), null);
});

test('le porte-avions occupe 5 × 2 cases, dans les deux orientations', () => {
  const h = shipCells({ type: 'carrier', x: 2, y: 3, dir: 'h' });
  const v = shipCells({ type: 'carrier', x: 2, y: 3, dir: 'v' });
  assert.equal(h.length, 10);
  assert.deepEqual([h[0], h.at(-1)], [{ x: 2, y: 3 }, { x: 6, y: 4 }]);
  assert.deepEqual([v[0], v.at(-1)], [{ x: 2, y: 3 }, { x: 3, y: 7 }]);
  assert.equal(shipCells({ type: 'destroyer', x: 0, y: 0, dir: 'v' }).length, 2);
});

test('refuse chevauchement, débordement et flotte incomplète', () => {
  assert.match(validateFleet([{ ...fleetA[0] }, { ...fleetA[1], y: 1 }, ...fleetA.slice(2)]), /chevauchent/);
  assert.match(validateFleet([{ ...fleetA[0], x: 8 }, ...fleetA.slice(1)]), /sort de la grille/);
  // Largeur : un porte-avions horizontal sur la dernière ligne déborde.
  assert.match(validateFleet([{ ...fleetA[0], y: 9 }, ...fleetA.slice(1)]), /sort de la grille/);
  assert.ok(validateFleet(fleetA.slice(1)));
  assert.ok(validateFleet([fleetA[0], fleetA[0], ...fleetA.slice(2)]));
});

test('la bataille commence quand les deux flottes sont prêtes', () => {
  const g = started();
  assert.equal(g.phase, 'battle');
  assert.equal(g.turn, 'p1');
  assert.equal(place(g, 'p1', fleetA, ctx).error, 'WRONG_PHASE');
});

test('tour, tir répété et alternance', () => {
  let g = started();
  assert.equal(fire(g, 'p2', 0, 0, ctx).error, 'NOT_YOUR_TURN');
  const first = fire(g, 'p1', 9, 9, ctx);
  assert.equal(first.events[0].payload.result, 'miss');
  g = first.game;
  assert.equal(g.turn, 'p2');
  g = fire(g, 'p2', 9, 9, ctx).game;
  assert.equal(fire(g, 'p1', 9, 9, ctx).error, 'ALREADY_FIRED');
});

test('touché ou coulé : le tireur rejoue ; à l\'eau : le tour passe', () => {
  let g = started();
  const hit = fire(g, 'p1', 0, 0, ctx);
  assert.equal(hit.events[0].payload.result, 'hit');
  assert.equal(hit.events[0].payload.nextTurn, 'p1');
  g = hit.game;
  assert.equal(g.turn, 'p1');
  g = fire(g, 'p1', 0, 5, ctx).game;
  const sunk = fire(g, 'p1', 1, 5, ctx);
  assert.equal(sunk.events[0].payload.result, 'sunk');
  assert.equal(sunk.game.turn, 'p1');
  const miss = fire(sunk.game, 'p1', 9, 9, ctx);
  assert.equal(miss.events[0].payload.nextTurn, 'p2');
  assert.equal(fire(miss.game, 'p1', 8, 8, ctx).error, 'NOT_YOUR_TURN');
});

test('le naufrage révèle le navire et le dernier naufrage termine la partie', () => {
  let g = started();
  const targets = fleetA.flatMap(shipCells);
  let events = [];
  // Toutes les cases visées sont des touches : p1 garde la main jusqu'au bout.
  for (const c of targets) {
    const r = fire(g, 'p1', c.x, c.y, ctx);
    assert.ok(r.game, r.error);
    events = r.events;
    g = r.game;
  }
  assert.equal(g.phase, 'finished');
  assert.equal(g.winner, 'p1');
  assert.equal(events[0].payload.result, 'sunk');
  assert.equal(events[1].type, 'game.finished');
});

test('la vue d\'un joueur ne fuit jamais la flotte adverse à flot', () => {
  const g = started();
  const view = viewFor(g, 'p1');
  assert.equal(view.foe.fleet, null);
  assert.deepEqual(view.foe.sunk, []);
  assert.deepEqual(view.me.fleet, fleetA);
});

test('expiration : tour sauté puis défaite au troisième dépassement', () => {
  let g = started();
  for (let i = 1; i < MAX_TIMEOUTS * 2 - 1; i++) {
    g = expire(g, { ...ctx, now: g.deadline }).game;
    assert.equal(g.phase, 'battle');
  }
  const last = expire(g, { ...ctx, now: g.deadline });
  assert.equal(last.game.phase, 'finished');
  assert.equal(last.game.reason, 'timeout');
  assert.equal(expire(started(), { ...ctx, now: 0 }).error, 'NOT_EXPIRED');
});

test('placement expiré : flotte aléatoire puis bataille', () => {
  const g = newGame({ id: 'g', p1: { id: 'a', name: 'A' }, p2: { id: 'b', name: 'B' }, now: 0, placementMs: 500 });
  const { game, events } = expire(g, { ...ctx, now: 500, rng: Math.random });
  assert.equal(game.phase, 'battle');
  assert.equal(events.filter((e) => e.payload.auto).length, 2);
});

test('forfait et absence de mutation de l\'état reçu', () => {
  const g = started();
  const before = JSON.stringify(g);
  fire(g, 'p1', 0, 0, ctx);
  assert.equal(JSON.stringify(g), before);
  assert.equal(forfeit(g, 'p1').game.winner, 'p2');
});
