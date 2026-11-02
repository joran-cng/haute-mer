import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';
import { FLEET, key, other, randomFleet, shipCells, validateFleet } from '../../shared/game.js';
import { SequencedInbox } from '../../shared/sequenced-inbox.js';
import { Audio } from './audio.js';
import { Connection } from './net/connection.js';
import { World } from './scene/world.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'bn.session';   // sessionStorage : la session de cet onglet
const SESSIONS_KEY = 'bn.sessions'; // localStorage : les sessions de ce navigateur
const COLUMN = 'ABCDEFGHIJ';
const coordLabel = (x, y) => `${COLUMN[x]}${y + 1}`;
const shipName = (type) => FLEET.find((s) => s.type === type).name;
const RED = [190, 44, 28];
const AMBER = [240, 166, 59];
const GREEN = [100, 210, 160];

const audio = new Audio();
const world = new World($('stage'));

const state = {
  session: null, conn: null, presence: new Map(), presenceTotal: 0, queued: false,
  room: null, game: null, inbox: null, draft: [], selected: 0, dir: 'h', hover: null,
  view: 'enemy', firing: false, earlyEvents: [],
};

/* ---------- Écrans ---------- */

function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${name}`;
  $('scrim').classList.toggle('on', name === 'login' || name === 'lobby');
  state.screen = name;
}

function toast(text, kind) {
  const el = $('toast');
  el.textContent = text;
  el.className = `impact-toast ${kind}`;
  void el.offsetWidth;
  el.classList.add('show');
}

function log(text, cls = '') {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.append(time, text);
  li.className = cls;
  const list = $('log');
  list.append(li);
  list.scrollTop = list.scrollHeight;
}

/* ---------- Session et réseau ---------- */

// Les sessions de ce navigateur vivent dans localStorage : fermer l'onglet ne les perd pas.
// Chaque onglet ouvert détient un verrou sur la sienne, si bien que deux onglets restent deux
// joueurs distincts et qu'un onglet rouvert reprend une session qu'aucun autre onglet n'utilise.
const STORED_SESSIONS_MAX = 5;

function readJson(storage, keyName, fallback) {
  try {
    const raw = storage.getItem(keyName);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback; // stockage bloqué ou navigation privée
  }
}

function writeJson(storage, keyName, value) {
  try { storage.setItem(keyName, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}

const isValid = (s) => s?.token && s.user?.id && s.expiresAt > Date.now();
const storedSessions = () => readJson(localStorage, SESSIONS_KEY, []).filter(isValid);

/** Verrou d'onglet : résout true si cet onglet obtient la session, et la garde jusqu'à sa fermeture. */
function claimSession(userId, { waitMs = 0 } = {}) {
  if (!navigator.locks) return Promise.resolve(true); // contexte non sécurisé : pas d'exclusion
  return new Promise((resolve) => {
    const opts = waitMs ? { signal: AbortSignal.timeout(waitMs) } : { ifAvailable: true };
    navigator.locks.request(`bn.session.${userId}`, opts, (lock) => {
      resolve(Boolean(lock));
      return lock ? new Promise((release) => { state.releaseSession = release; }) : undefined;
    }).catch(() => resolve(false));
  });
}

async function loadSession() {
  // L'onglet rechargé reprend la sienne, en laissant le temps à l'ancienne page de libérer le verrou.
  const own = readJson(sessionStorage, SESSION_KEY, null);
  if (isValid(own) && await claimSession(own.user.id, { waitMs: 2000 })) return own;
  for (const session of storedSessions()) {
    if (session.user.id !== own?.user.id && await claimSession(session.user.id)) {
      writeJson(sessionStorage, SESSION_KEY, session);
      return session;
    }
  }
  return null;
}

async function saveSession(session) {
  await claimSession(session.user.id);
  writeJson(sessionStorage, SESSION_KEY, session);
  const others = storedSessions().filter((s) => s.user.id !== session.user.id);
  writeJson(localStorage, SESSIONS_KEY, [session, ...others].slice(0, STORED_SESSIONS_MAX));
}

function forgetSession() {
  const id = state.session?.user.id;
  writeJson(localStorage, SESSIONS_KEY, storedSessions().filter((s) => s.user.id !== id));
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* stockage indisponible */ }
  state.releaseSession?.();
  state.releaseSession = null;
}

function logout() {
  if (state.game && state.game.phase !== 'finished'
    && !window.confirm('Une partie est en cours. Changer d\'indicatif vous en fera perdre l\'accès.')) return;
  forgetSession();
  state.conn?.close();
  Object.assign(state, {
    session: null, conn: null, welcomed: false, queued: false, room: null, game: null, inbox: null, earlyEvents: [],
  });
  $('callsign').value = '';
  show('login');
}

async function login(name) {
  const res = await fetch('/api/auth/guest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(res.status === 422 ? 'Indicatif invalide : 2 à 20 lettres, chiffres, espaces, _ ou -.' : 'Serveur indisponible.');
  const { token, user, expiresIn } = await res.json();
  return { token, user, expiresAt: Date.now() + expiresIn * 1000 };
}

function startConnection() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  state.conn = new Connection({
    url: `${scheme}://${location.host}/ws`,
    getToken: () => state.session.token,
    onMessage,
    onStatus,
  });
  state.conn.connect();
}

// Session enregistrée jamais acceptée (jeton refusé, serveur absent) : on rend la main à l'accueil
// plutôt que de laisser l'écran vide pendant les tentatives.
const RESUME_GIVE_UP_ATTEMPTS = 4;

function onStatus(s) {
  if (s.state === 'waiting' && !state.welcomed && s.attempt >= RESUME_GIVE_UP_ATTEMPTS && state.screen !== 'login') {
    state.conn.close();
    show('login');
    $('login-error').textContent = 'Impossible de reprendre la session précédente. Saisissez un indicatif.';
  }
  const dot = $('link-dot');
  const banner = $('link-banner');
  if (s.state === 'online') {
    dot.className = 'dot';
    $('link-text').textContent = 'Liaison établie';
    $('instance-text').textContent = `Station ${s.instance}`;
    if (s.rtt !== undefined) $('rtt-text').textContent = `${s.rtt} ms`;
    banner.hidden = true;
  } else if (s.state === 'waiting') {
    dot.className = 'dot wait';
    $('link-text').textContent = `Tentative ${s.attempt}`;
    $('rtt-text').textContent = '';
    banner.textContent = `Liaison perdue. Nouvelle tentative dans ${(s.delay / 1000).toFixed(1)} s.`;
    banner.hidden = false;
  } else {
    dot.className = 'dot wait';
    $('link-text').textContent = 'Connexion…';
  }
}

function onMessage(msg) {
  const { type, payload } = msg;
  switch (type) {
    case 'sys.welcome': return onWelcome(payload);
    case 'sys.error': return onError(payload);
    case 'sys.shutdown': return undefined;
    case 'presence.delta': return onPresence(payload);
    case 'match.queued': state.queued = true; return renderLobby();
    case 'match.cancelled': state.queued = false; return renderLobby();
    case 'room.created': state.room = payload.code; return renderLobby();
    case 'room.invited': return showInvite(payload);
    case 'match.found': return resumeGame(payload.gameId, 0);
    case 'game.snapshot': return onSnapshot(payload);
    case 'sys.ack': return undefined;
    default:
      if (!msg.seq) return undefined;
      if (state.inbox && msg.gameId === state.game?.id) state.inbox.push(msg);
      else state.earlyEvents.push(msg); // arrivé avant l'instantané de cette partie
      return undefined;
  }
}

function onWelcome({ user, presence, activeGame }) {
  state.welcomed = true;
  state.presence = new Map(presence.users.map((u) => [u.id, u]));
  state.presenceTotal = presence.total;
  $('lobby-user').textContent = user.name;
  if (state.game && state.game.phase !== 'finished') resumeGame(state.game.id, state.inbox.lastSeq);
  else if (activeGame) resumeGame(activeGame, 0);
  else if (state.screen === 'login' || !state.screen) enterLobby();
  renderPresence();
}

const ERROR_TEXT = {
  NOT_YOUR_TURN: 'Ce n\'est pas votre tour.',
  ALREADY_FIRED: 'Case déjà visée.',
  NOT_FOUND: 'Salon introuvable ou expiré.',
  RATE_LIMITED: 'Trop de messages, ralentissez.',
  INVALID_FLEET: 'Déploiement refusé.',
};

function onError({ code, message }) {
  const text = ERROR_TEXT[code] ?? message;
  if (code === 'WRONG_PHASE' && !state.game) return;
  if (state.screen === 'lobby') $('queue-sub').textContent = text;
  else if (state.screen === 'placement') $('placement-status').textContent = text;
  else if (state.screen === 'battle') {
    state.firing = false;
    renderBattle();
    log(text, 'hit');
  }
}

function onPresence({ joined, left, changed, total }) {
  for (const u of joined) state.presence.set(u.id, u);
  for (const u of changed) state.presence.set(u.id, u);
  for (const id of left) state.presence.delete(id);
  state.presenceTotal = total;
  renderPresence();
}

/* ---------- Salon ---------- */

function enterLobby() {
  state.game = null;
  state.queued = false;
  world.clearBoards();
  world.showBoards(0, 0);
  world.showReviewFleet();
  world.orbitCamera();
  show('lobby');
  renderLobby();
}

function renderLobby() {
  $('btn-queue').classList.toggle('active', state.queued);
  $('queue-sub').textContent = state.queued
    ? 'Recherche en cours. Cliquez pour annuler.'
    : 'Appariement automatique avec le prochain commandant disponible';
  $('btn-room').classList.toggle('active', Boolean(state.room));
  const sub = $('room-sub');
  if (state.room) {
    sub.textContent = 'Code à transmettre : ';
    const code = document.createElement('strong');
    code.textContent = state.room;
    code.id = 'room-code';
    sub.append(code);
  } else {
    sub.textContent = 'Obtenez un code à transmettre à votre adversaire';
  }
}

const STATUS_TEXT = { lobby: 'à quai', queue: 'en attente', playing: 'en mer' };

function renderPresence() {
  $('presence-count').textContent = state.presenceTotal;
  const list = $('presence-list');
  list.replaceChildren();
  const me = state.session?.user.id;
  const users = [...state.presence.values()].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)));
  for (const u of users.slice(0, 100)) {
    const li = document.createElement('li');
    li.dataset.user = u.id;
    const dot = document.createElement('i');
    dot.className = `dot ${u.status === 'lobby' ? '' : u.status}`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = u.id === me ? `${u.name} (vous)` : u.name;
    li.append(dot, name);
    if (u.id !== me && u.status === 'lobby') {
      const btn = document.createElement('button');
      btn.className = 'challenge';
      btn.textContent = 'Défier';
      btn.addEventListener('click', () => state.conn.send('room.create', { invite: u.id }));
      li.append(btn);
    } else {
      const s = document.createElement('span');
      s.className = 'state';
      s.textContent = STATUS_TEXT[u.status] ?? '';
      li.append(s);
    }
    list.append(li);
  }
}

function showInvite({ code, from }) {
  $('invite-text').textContent = `${from.name} vous défie.`;
  $('invite').hidden = false;
  $('invite-accept').onclick = () => {
    $('invite').hidden = true;
    state.conn.send('room.join', { code });
  };
  $('invite-decline').onclick = () => { $('invite').hidden = true; };
}

/* ---------- Partie : état ---------- */

function resumeGame(gameId, lastSeq) {
  state.conn.send('game.resume', { gameId, lastSeq });
}

/** Instantané : reconstruit toute la scène sans animation (rechargement, trou de séquence, nouvelle partie). */
function onSnapshot(view) {
  const g = {
    id: view.gameId, you: view.you, phase: view.phase, turn: view.turn, deadline: view.deadline,
    winner: view.winner, reason: view.reason, me: view.me, foe: view.foe, deadlineStart: Date.now(),
    foeOnline: true, ownHits: new Set(), foeSunk: new Map(),
    myShots: new Map(view.me.shots.map((s) => [key(s.x, s.y), s])),
    theirShots: new Map(view.foe.shots.map((s) => [key(s.x, s.y), s])),
  };
  state.game = g;
  state.inbox = new SequencedInbox({
    lastSeq: view.seq,
    onEvent: applyEvent,
    onGap: (seq) => resumeGame(g.id, seq),
  });
  state.room = null;
  state.queued = false;
  state.firing = false;
  state.draft = [];
  $('log').replaceChildren();
  rebuildScene(view);
  if (g.phase === 'placement') enterPlacement();
  else if (g.phase === 'battle') enterBattle();
  else {
    enterBattle();
    showEnd();
  }
  const early = state.earlyEvents.filter((e) => e.gameId === g.id);
  state.earlyEvents = [];
  early.forEach((e) => state.inbox.push(e));
}

function rebuildScene(view) {
  world.hideReviewFleet();
  world.clearBoards();
  const g = state.game;
  for (const ship of view.me.fleet ?? []) world.addShip('own', ship);
  for (const s of view.foe.shots) {
    if (s.result === 'miss') markMiss('own', s.x, s.y);
    else { world.addFire('own', s.x, s.y, { silent: true }); markHit('own', s.x, s.y); }
  }
  for (const s of view.me.shots) {
    if (s.result === 'miss') markMiss('enemy', s.x, s.y);
    else { world.addFire('enemy', s.x, s.y, { silent: true }); markHit('enemy', s.x, s.y); }
    if (s.ship) {
      g.foeSunk.set(s.ship.type, s.ship);
      world.sink('enemy', s.ship, { instant: true });
    }
  }
  for (const ship of view.me.fleet ?? []) {
    const cells = shipCells(ship);
    if (cells.every((c) => g.theirShots.has(key(c.x, c.y)))) world.sink('own', ship, { instant: true });
  }
}

function markMiss(board, x, y) {
  world.addMissMarker(board, x, y);
  world.tintCell(board, x, y, [205, 225, 235], 0.1);
}

function markHit(board, x, y) { world.tintCell(board, x, y, RED, 0.22); }

function applyEvent(e) {
  const g = state.game;
  if (!g) return;
  const p = e.payload;
  switch (e.type) {
    case 'game.player_ready':
      if (p.player === g.you) g.me.ready = true;
      else g.foe.ready = true;
      if (p.player !== g.you) $('placement-status').textContent = `${g.foe.name} est prêt.`;
      if (p.player === g.you && p.auto) requestFullResync();
      break;
    case 'game.battle_started':
      g.phase = 'battle';
      setTurn(p.firstTurn, p.deadline);
      enterBattle();
      log(p.firstTurn === g.you ? 'Combat engagé. Vous tirez le premier.' : 'Combat engagé. L\'ennemi ouvre le feu.');
      break;
    case 'game.shot':
      onShot(p, e);
      break;
    case 'game.turn_skipped':
      setTurn(p.nextTurn, p.deadline);
      log(`${p.player === g.you ? 'Vous avez' : `${g.foe.name} a`} laissé passer son tour (${p.timeouts}/3).`);
      focusTurn();
      break;
    case 'game.player_connection':
      if (p.player !== g.you && g.foeOnline !== p.online) {
        g.foeOnline = p.online;
        $('foe-name').classList.toggle('off', !p.online);
        log(p.online ? `${g.foe.name} a rétabli sa liaison.` : `${g.foe.name} a perdu sa liaison.`);
      }
      break;
    case 'game.finished':
      g.finishedPayload = p;
      // Laisse l'obus en vol terminer son trajet avant l'écran de fin.
      setTimeout(() => onFinished(p), 2600);
      break;
    case 'game.rematch_offered':
      if (p.by !== g.you) $('end-status').textContent = `${g.foe.name} propose une revanche.`;
      else $('end-status').textContent = 'Proposition envoyée.';
      break;
    case 'chat.message':
      log(`${p.name} : ${p.text}`, 'chat');
      if (p.player !== g.you) audio.blip(520);
      break;
    default:
  }
}

/** Un placement automatique du serveur nous concerne : on relit notre flotte. */
function requestFullResync() { resumeGame(state.game.id, 0); }

function setTurn(turn, deadline) {
  const g = state.game;
  g.turn = turn;
  g.deadline = deadline;
  g.deadlineStart = Date.now();
  renderBattle();
}

function focusTurn() {
  const g = state.game;
  if (!g || g.phase !== 'battle') return;
  setView(g.turn === g.you ? 'enemy' : 'own');
}

function setView(name) {
  state.view = name;
  world.setView(name);
  world.showBoards(name === 'own' ? 1 : 0, name === 'enemy' ? 1 : 0);
  $('tab-own').classList.toggle('active', name === 'own');
  $('tab-enemy').classList.toggle('active', name === 'enemy');
  world.ocean.setHover('enemy', null);
}

function onShot(p) {
  const g = state.game;
  const mine = p.by === g.you;
  const targetBoard = mine ? 'enemy' : 'own';
  // Après une touche, on rejoue : le verrou reste posé jusqu'à l'impact pour voir le résultat
  // avant de choisir la case suivante (filet de sécurité de 6 s si l'animation ne tourne pas).
  const replay = mine && p.nextTurn === g.you;
  if (mine && !replay) state.firing = false;
  const release = () => {
    if (!replay || !state.firing) return;
    state.firing = false;
    renderBattle();
  };
  if (replay) setTimeout(release, 6000);
  const shots = mine ? g.myShots : g.theirShots;
  shots.set(key(p.x, p.y), p);
  if (p.nextTurn) setTurn(p.nextTurn, p.deadline);
  else { g.turn = null; renderBattle(); }
  if (state.view !== targetBoard) setView(targetBoard);
  audio.gun();
  audio.whistle();
  world.fireShell(mine ? 'own' : 'enemy', targetBoard, p.x, p.y, p.result, () => {
    resolveImpact(p, targetBoard, mine);
    release();
    setTimeout(focusTurn, 1500);
  });
}

function resolveImpact(p, board, mine) {
  const g = state.game;
  if (!g) return;
  const where = coordLabel(p.x, p.y);
  if (p.result === 'miss') {
    audio.splash();
    markMiss(board, p.x, p.y);
    toast('À l\'eau', 'miss');
    log(`${mine ? 'Tir' : 'Tir ennemi'} en ${where} : à l'eau.`);
  } else {
    audio.explosion(p.result === 'sunk');
    markHit(board, p.x, p.y);
    world.addFire(board, p.x, p.y);
    if (p.result === 'sunk') {
      if (mine) g.foeSunk.set(p.ship.type, p.ship);
      world.sink(board, p.ship);
      toast('Coulé', 'sunk');
      log(`${mine ? 'Le' : 'Notre'} ${shipName(p.ship.type).toLowerCase()} ${mine ? 'ennemi est coulé' : 'est coulé'} (${where}).`, 'sunk');
    } else {
      toast('Touché', 'hit');
      log(`${mine ? 'Tir' : 'Tir ennemi'} en ${where} : touché.`, 'hit');
    }
    if (p.nextTurn === p.by) log(mine ? 'Cible atteinte : vous rejouez.' : `${g.foe.name} rejoue.`);
  }
  renderBattle();
}

function onFinished(p) {
  const g = state.game;
  if (!g || g.phase === 'finished') return;
  g.phase = 'finished';
  g.winner = p.winner;
  g.reason = p.reason;
  for (const ship of p.fleets[other(g.you)]) {
    if (!g.foeSunk.has(ship.type)) world.addShip('enemy', ship);
  }
  showEnd();
}

/* ---------- Placement ---------- */

function enterPlacement() {
  const g = state.game;
  show('placement');
  setViewOnly('own');
  state.selected = 0;
  state.dir = 'h';
  $('placement-status').textContent = '';
  if (g.me.ready) lockPlacement();
  else renderDock();
}

function setViewOnly(name) {
  world.setView(name, 2.2);
  world.showBoards(name === 'own' ? 1 : 0, name === 'enemy' ? 1 : 0);
  state.view = name;
}

function renderDock() {
  const list = $('dock-list');
  list.replaceChildren();
  FLEET.forEach((s, i) => {
    const placed = state.draft.some((d) => d.type === s.type);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.ship = s.type;
    b.className = `${placed ? 'placed' : ''} ${i === state.selected ? 'selected' : ''}`;
    const name = document.createElement('span');
    name.textContent = s.name;
    const pips = document.createElement('span');
    pips.className = s.width > 1 ? 'pips wide' : 'pips';
    pips.append(...Array.from({ length: s.size * s.width }, () => document.createElement('i')));
    b.append(name, pips);
    b.addEventListener('click', () => selectShip(i));
    li.append(b);
    list.append(li);
  });
  $('btn-ready').disabled = state.draft.length !== FLEET.length;
}

function selectShip(i) {
  state.selected = i;
  const type = FLEET[i].type;
  if (state.draft.some((d) => d.type === type)) {
    state.draft = state.draft.filter((d) => d.type !== type);
    world.removeShip('own', type);
    world.rebuildWash();
  }
  renderDock();
  updateGhost();
}

function draftCandidate() {
  if (!state.hover || state.selected < 0) return null;
  return { type: FLEET[state.selected].type, x: state.hover.x, y: state.hover.y, dir: state.dir };
}

function candidateValid(candidate) {
  const occupied = new Set(state.draft.flatMap(shipCells).map((c) => key(c.x, c.y)));
  return shipCells(candidate).every((c) => c.x >= 0 && c.y >= 0 && c.x < 10 && c.y < 10 && !occupied.has(key(c.x, c.y)));
}

function updateGhost() {
  world.ocean.cells.clear('own');
  const candidate = draftCandidate();
  if (!candidate) { world.setGhost(null); return; }
  const valid = candidateValid(candidate);
  for (const c of shipCells(candidate)) {
    if (c.x < 10 && c.y < 10) world.tintCell('own', c.x, c.y, valid ? GREEN : RED, 0.4);
  }
  world.setGhost(valid ? candidate : null);
}

function placeCandidate() {
  const candidate = draftCandidate();
  if (!candidate || !candidateValid(candidate)) return;
  state.draft.push(candidate);
  world.setGhost(null);
  world.addShip('own', candidate);
  audio.blip(740);
  const next = FLEET.findIndex((s) => !state.draft.some((d) => d.type === s.type));
  state.selected = next;
  renderDock();
  updateGhost();
}

function randomDraft() {
  for (const d of state.draft) world.removeShip('own', d.type);
  state.draft = randomFleet();
  state.selected = -1;
  state.draft.forEach((s) => world.addShip('own', s));
  world.rebuildWash();
  world.setGhost(null);
  world.ocean.cells.clear('own');
  renderDock();
  audio.blip(740);
}

function rotate() {
  state.dir = state.dir === 'h' ? 'v' : 'h';
  updateGhost();
}

function confirmFleet() {
  const invalid = validateFleet(state.draft);
  if (invalid) { $('placement-status').textContent = invalid; return; }
  const g = state.game;
  g.me.fleet = state.draft;
  g.me.ready = true;
  state.conn.send('game.place', { gameId: g.id, fleet: state.draft });
  lockPlacement();
}

function lockPlacement() {
  const g = state.game;
  world.setGhost(null);
  world.ocean.cells.clear('own');
  state.selected = -1;
  for (const b of document.querySelectorAll('#dock-list button, #btn-rotate, #btn-random, #btn-ready')) b.disabled = true;
  $('placement-status').textContent = g.foe.ready ? 'Combat imminent.' : `En attente de ${g.foe.name}…`;
}

/* ---------- Combat ---------- */

function enterBattle() {
  show('battle');
  $('me-name').textContent = state.game.me.name;
  $('foe-name').textContent = state.game.foe.name;
  renderBattle();
  focusTurn();
}

function renderPips(ul, entries) {
  ul.replaceChildren();
  for (const { name, size, hits, sunk, wide } of entries) {
    const li = document.createElement('li');
    li.className = sunk ? 'sunk' : '';
    const label = document.createElement('span');
    label.textContent = name;
    const pips = document.createElement('span');
    pips.className = wide ? 'pips wide' : 'pips';
    for (let i = 0; i < size; i++) {
      const p = document.createElement('i');
      if (i < hits) p.className = 'hit';
      pips.append(p);
    }
    li.append(label, pips);
    ul.append(li);
  }
}

function renderBattle() {
  const g = state.game;
  if (!g || state.screen !== 'battle') return;
  const mine = g.turn === g.you;
  $('turnbar').classList.toggle('mine', mine);
  let label = 'Tir ennemi attendu';
  if (g.turn === null) label = 'Fin des combats';
  else if (state.firing) label = 'Salve en route';
  else if (mine) label = 'À vous de tirer';
  $('turn-label').textContent = label;

  const fleet = g.me.fleet ?? [];
  const own = fleet.map((s) => {
    const cells = shipCells(s);
    const hits = cells.filter((c) => g.theirShots.has(key(c.x, c.y))).length;
    const wide = FLEET.find((f) => f.type === s.type).width > 1;
    return { name: shipName(s.type), size: cells.length, hits, sunk: hits === cells.length, wide };
  });
  renderPips($('own-status'), own);
  $('own-remaining').textContent = `${own.filter((s) => !s.sunk).length}/5 à flot`;

  const foe = FLEET.map((s) => {
    const area = s.size * s.width;
    const sunk = g.foeSunk.has(s.type);
    return { name: s.name, size: area, hits: sunk ? area : 0, sunk, wide: s.width > 1 };
  });
  renderPips($('foe-status'), foe);
  $('foe-remaining').textContent = `${5 - g.foeSunk.size}/5 à flot`;
}

function fireAt(cell) {
  const g = state.game;
  if (!g || g.phase !== 'battle' || g.turn !== g.you || state.view !== 'enemy') return;
  if (state.firing) return;
  if (g.myShots.has(key(cell.x, cell.y))) { toast('Déjà visé', 'miss'); return; }
  state.firing = true; // verrou local jusqu'à la réponse du serveur
  renderBattle();
  state.conn.send('game.fire', { gameId: g.id, x: cell.x, y: cell.y, clientTs: Date.now() });
}

function showEnd() {
  const g = state.game;
  const win = g.winner === g.you;
  const shots = g.myShots.size;
  const hits = [...g.myShots.values()].filter((s) => s.result !== 'miss').length;
  const sunk = g.foeSunk.size;
  $('end-eyebrow').textContent = win ? 'Rapport de fin de mission' : 'Message de l\'amirauté';
  $('end-title').textContent = win ? 'Victoire' : 'Défaite';
  const reasons = {
    fleet_destroyed: win ? 'La flotte ennemie repose par le fond.' : 'Votre flotte a été anéantie.',
    forfeit: win ? `${g.foe.name} a abandonné le combat.` : 'Vous avez quitté le combat.',
    timeout: win ? `${g.foe.name} ne répond plus.` : 'Trois tours sans réponse : le combat est perdu.',
  };
  $('end-reason').textContent = reasons[g.reason] ?? '';
  const stats = [['Tirs', shots], ['Précision', shots ? `${Math.round((hits / shots) * 100)} %` : '—'], ['Coulés', `${sunk}/5`]];
  $('end-stats').replaceChildren(...stats.map(([k, v]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    d.append(dt, dd);
    return d;
  }));
  $('end-status').textContent = '';
  $('btn-rematch').disabled = false;
  show('end');
  world.showBoards(0, 0);
}

function tick() {
  const g = state.game;
  if (g?.deadline && (state.screen === 'battle' || state.screen === 'placement')) {
    const left = Math.max(0, g.deadline - Date.now());
    const label = `${Math.ceil(left / 1000)} s`;
    if (state.screen === 'placement') $('placement-timer').textContent = label;
    else {
      $('turn-time').textContent = label;
      const total = Math.max(1, g.deadline - g.deadlineStart);
      $('turn-progress').style.transform = `scaleX(${Math.min(1, left / total)})`;
    }
  }
  requestAnimationFrame(tick);
}

/* ---------- Interactions ---------- */

function bindEvents() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    audio.unlock();
    $('login-error').textContent = '';
    try {
      state.session = await login($('callsign').value.trim());
      await saveSession(state.session);
      state.conn?.close();
      startConnection();
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('btn-queue').addEventListener('click', () => {
    audio.unlock();
    state.conn.send(state.queued ? 'match.cancel' : 'match.queue');
  });
  $('btn-room').addEventListener('click', () => { audio.unlock(); if (!state.room) state.conn.send('room.create'); });
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    audio.unlock();
    const code = $('join-code').value.trim().toUpperCase();
    if (/^[A-Z2-9]{6}$/.test(code)) state.conn.send('room.join', { code });
    else $('queue-sub').textContent = 'Le code comporte 6 caractères.';
  });

  $('btn-rotate').addEventListener('click', rotate);
  $('btn-random').addEventListener('click', randomDraft);
  $('btn-ready').addEventListener('click', confirmFleet);

  $('tab-own').addEventListener('click', () => setView('own'));
  $('tab-enemy').addEventListener('click', () => setView('enemy'));
  $('btn-forfeit').addEventListener('click', () => {
    if (window.confirm('Abandonner le combat ?')) state.conn.send('game.forfeit', { gameId: state.game.id });
  });
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (text && state.game) state.conn.send('chat.send', { gameId: state.game.id, text });
    input.value = '';
  });

  $('btn-rematch').addEventListener('click', () => {
    $('btn-rematch').disabled = true;
    state.conn.send('game.rematch', { gameId: state.game.id });
  });
  $('btn-lobby').addEventListener('click', enterLobby);
  $('btn-logout').addEventListener('click', logout);
  $('btn-mute').addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    $('btn-mute').textContent = audio.muted ? 'Son coupé' : 'Son activé';
  });

  const stage = $('stage');
  stage.addEventListener('pointermove', (e) => {
    if (state.screen === 'placement' && state.selected >= 0) {
      state.hover = world.pick(e.clientX, e.clientY, 'own');
      updateGhost();
    } else if (state.screen === 'battle' && state.view === 'enemy') {
      setBattleHover(world.pick(e.clientX, e.clientY, 'enemy'));
    }
  });
  stage.addEventListener('pointerdown', (e) => {
    audio.unlock();
    if (state.screen === 'placement' && state.selected >= 0 && !state.game?.me.ready) {
      state.hover = world.pick(e.clientX, e.clientY, 'own');
      updateGhost();
      placeCandidate();
    } else if (state.screen === 'battle' && state.view === 'enemy') {
      const cell = world.pick(e.clientX, e.clientY, 'enemy');
      if (cell) fireAt(cell);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (state.screen === 'placement') {
      if (e.key === 'r' || e.key === 'R') rotate();
      if (moves[e.key]) moveCursor(moves[e.key], () => updateGhost());
      if (e.key === 'Enter' && state.selected >= 0) placeCandidate();
    } else if (state.screen === 'battle') {
      if (e.key === 'Tab') {
        e.preventDefault();
        setView(state.view === 'own' ? 'enemy' : 'own');
      }
      if (moves[e.key] && state.view === 'enemy') moveCursor(moves[e.key], () => setBattleHover(state.hover));
      if ((e.key === 'Enter' || e.key === ' ') && state.hover) fireAt(state.hover);
    }
  });
}

function moveCursor([dx, dy], apply) {
  const h = state.hover ?? { x: 4, y: 4 };
  state.hover = { x: Math.min(9, Math.max(0, h.x + dx)), y: Math.min(9, Math.max(0, h.y + dy)) };
  apply();
}

function setBattleHover(cell) {
  state.hover = cell;
  const g = state.game;
  const myTurn = g?.turn === g?.you;
  const used = cell && g?.myShots.has(key(cell.x, cell.y));
  world.ocean.setHover('enemy', cell, myTurn && !used ? [1, 0.68, 0.22] : [0.72, 0.78, 0.8]);
  $('stage').style.cursor = cell && myTurn && !used ? 'crosshair' : 'default';
}

/* ---------- Démarrage ---------- */

async function boot() {
  bindEvents();
  requestAnimationFrame(tick);
  state.session = await loadSession();
  if (state.session) startConnection();
  else show('login');
  // Crochet de test : lecture seule pour les vérifications automatisées de bout en bout.
  window.__bn = { state, world };
}

boot();
