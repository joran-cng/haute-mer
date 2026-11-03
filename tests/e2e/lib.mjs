import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

export const BASE = process.env.BASE ?? 'http://localhost:8088';
export const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
export const ORIGIN = 'http://localhost:8088';

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export async function guest(name = 'Testeur') {
  const res = await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  return res.json();
}

/** Client protocolaire minimal : garde tout ce qu'il reçoit pour que les tests puissent attendre un message. */
export class Bot {
  constructor(ws, session) {
    Object.assign(this, { ws, session, received: [], waiters: [] });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }

  static open(session, { origin = ORIGIN, url = WS_URL } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['bn.v1', `auth.${session.token}`], { origin });
      const bot = new Bot(ws, session);
      ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.once('error', reject);
      bot.wait('sys.welcome').then((m) => {
        bot.welcome = m.payload;
        resolve(bot);
      }, () => {});
    });
  }

  send(type, payload = {}, id = randomUUID()) {
    this.ws.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  wait(match, timeoutMs = 8000) {
    const fn = typeof match === 'string' ? (m) => m.type === match : match;
    const hit = this.received.find(fn);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`attente expirée : ${match}`)), timeoutMs);
      this.waiters.push({ match: fn, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  clear() { this.received = []; }
  close() { this.ws.close(); }
}

export const FLEET = [
  { type: 'carrier', x: 0, y: 0, dir: 'h' }, { type: 'battleship', x: 0, y: 2, dir: 'h' },
  { type: 'cruiser', x: 0, y: 4, dir: 'h' }, { type: 'submarine', x: 0, y: 6, dir: 'h' },
  { type: 'destroyer', x: 0, y: 8, dir: 'h' },
];

/** Deux bots en partie privée, flottes posées, bataille commencée. Connexions garanties sur deux instances si possible. */
export async function startGame({ differentInstances = true } = {}) {
  const a = await Bot.open(await guest('Alpha'));
  let b = await Bot.open(await guest('Bravo'));
  for (let i = 0; differentInstances && i < 12 && b.welcome.instance === a.welcome.instance; i++) {
    const extra = b;
    b = await Bot.open(await guest('Bravo'));
    if (b.welcome.instance === a.welcome.instance) extra.close();
    else extra.close();
  }
  a.send('room.create');
  const { payload: { code } } = await a.wait('room.created');
  b.send('room.join', { code });
  const found = await a.wait('match.found');
  const foundB = await b.wait('match.found');
  const { gameId } = found.payload;
  a.send('game.resume', { gameId, lastSeq: 0 });
  b.send('game.resume', { gameId, lastSeq: 0 });
  await Promise.all([a.wait('game.snapshot'), b.wait('game.snapshot')]);
  a.send('game.place', { gameId, fleet: FLEET });
  b.send('game.place', { gameId, fleet: FLEET });
  const started = await a.wait('game.battle_started');
  await b.wait('game.battle_started');
  const byTurn = found.payload.you === started.payload.firstTurn ? [a, b] : [b, a];
  return { a, b, gameId, first: byTurn[0], second: byTurn[1], you: { a: found.payload.you, b: foundB.payload.you } };
}

export async function launchBrowser(opts = {}) {
  const isMac = process.platform === 'darwin';
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      isMac ? '--use-angle=metal' : '--use-angle=d3d11',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--mute-audio',
      '--disable-web-security',
      '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
      ...(opts.args ?? []),
    ],
    ...opts,
  });
}

export async function openPlayer(browser, name, { base = BASE, viewport = { width: 1600, height: 900 }, ...ctxOpts } = {}) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...ctxOpts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console:`, m.text()); });
  await page.goto(base);
  if (name) {
    await page.fill('#callsign', name);
    await page.click('#login-form button');
    await page.waitForSelector('#screen-lobby:not([hidden])');
  }
  return { ctx, page };
}

const results = [];
export async function check(label, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail });
    console.log(`  OK    ${label}${detail ? ` — ${detail}` : ''} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ label, ok: false, detail: err.message });
    console.log(`  ÉCHEC ${label} — ${err.message}`);
  }
}

export function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies`);
  process.exitCode = failed.length ? 1 : 0;
  return failed.length === 0;
}
