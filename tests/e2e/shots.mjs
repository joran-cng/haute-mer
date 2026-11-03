// Parcours visuel complet à deux navigateurs, avec captures dans tests/e2e/artifacts/.
import { shipCells } from '../../shared/game.js';
import { launchBrowser, openPlayer, sleep } from './lib.mjs';

const OUT = new URL('./artifacts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` });

const a = await openPlayer(browser, '');
await a.page.waitForSelector('#screen-login:not([hidden])');
await sleep(3500);
const info = await a.page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a', fps: window.__bn.world.lastFps };
});
console.log(info);
await shot(a.page, '01-login');
if (process.argv[2] === 'login') { await browser.close(); process.exit(0); }

await a.page.fill('#callsign', 'Amiral_Nemo');
await a.page.click('#login-form button');
await a.page.waitForSelector('#screen-lobby:not([hidden])');
const b = await openPlayer(browser, 'Surcouf');
await a.page.click('#btn-room');
await a.page.waitForSelector('#room-code');
const code = await a.page.textContent('#room-code');
await sleep(1500);
await shot(a.page, '02-lobby');
await b.page.fill('#join-code', code);
await b.page.click('#join-form button');

for (const { page } of [a, b]) await page.waitForSelector('#screen-placement:not([hidden])');
await sleep(3000);
await a.page.click('#dock-list button[data-ship="carrier"]');
await a.page.mouse.move(800, 420);
await sleep(600);
await shot(a.page, '03-placement-ghost');
await a.page.click('#btn-random');
await sleep(1200);
await shot(a.page, '04-placement-random');
await a.page.click('#btn-ready');
await b.page.click('#btn-random');
await b.page.click('#btn-ready');
for (const { page } of [a, b]) await page.waitForSelector('#screen-battle:not([hidden])');
await sleep(3000);

// Tire en priorité sur les navires adverses pour voir les effets.
const fleetOf = (p) => p.evaluate(() => window.__bn.state.game.me.fleet);
const fleets = { a: await fleetOf(a.page), b: await fleetOf(b.page) };
const cellsOf = (fleet) => fleet.flatMap(shipCells).map((c) => [c.x, c.y]);
const targets = { a: cellsOf(fleets.b), b: cellsOf(fleets.a) };
const send = (p, x, y) => p.evaluate(([cx, cy]) => {
  const { state } = window.__bn;
  state.conn.send('game.fire', { gameId: state.game.id, x: cx, y: cy, clientTs: Date.now() });
}, [x, y]);

let captured = 0;
for (let i = 0; i < 14; i++) {
  const turnA = await a.page.evaluate(() => { const g = window.__bn.state.game; return g.turn === g.you; });
  const shooter = turnA ? a : b;
  const list = turnA ? targets.a : targets.b;
  const [x, y] = i % 4 === 3 ? [9 - (i % 10), 9] : list.shift();
  await send(shooter.page, x, y);
  await sleep(250);
  if (captured < 2) await shot(a.page, `05-flight-${i}`);
  await sleep(1250);
  await shot(a.page, `06-impact-${i}`);
  captured++;
  await sleep(3000);
}
await shot(a.page, '07-battle-late');
await a.page.click('#tab-own');
await sleep(2500);
await shot(a.page, '08-own-fleet');
console.log('fps', await a.page.evaluate(() => window.__bn.world.lastFps));
await a.page.evaluate(() => { window.confirm = () => true; });
await a.page.click('#btn-forfeit');
await a.page.waitForSelector('#screen-end:not([hidden])', { timeout: 8000 });
await sleep(800);
await shot(a.page, '09-end');
await browser.close();
