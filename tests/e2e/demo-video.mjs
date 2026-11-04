// Enregistre la vidéo de secours (3 min au plus) : deux joueurs côte à côte sur deux instances,
// panne d'instance en direct, tableau de bord, résultats de vérification.
// Les deux joueurs sont deux iframes (localhost et 127.0.0.1 : deux origines, donc deux sessions).
import { exec } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { shipCells } from '../../shared/game.js';
import { launchBrowser, sleep } from './lib.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (cmd) => new Promise((res) => { exec(cmd, { cwd: ROOT }, () => res()); });
const RAW = `${ROOT}tests/e2e/artifacts/video`;
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const STAGE = `<!doctype html><meta charset=utf-8><title>Démonstration</title><style>
html,body{margin:0;height:100%;background:#0a0f14;color:#e8edf0;font-family:'Segoe UI',sans-serif;overflow:hidden}
#grid{position:absolute;inset:0 0 70px;display:grid;grid-template-columns:1fr 1fr;gap:4px}
iframe{border:0;width:100%;height:100%;background:#000}
#single{position:absolute;inset:0 0 70px;width:100%;height:calc(100% - 70px);display:none;border:0;background:#fff}
#cap{position:absolute;left:0;right:0;bottom:0;height:70px;display:flex;align-items:center;padding:0 28px;font-size:24px;background:#10171d;border-top:2px solid #efa63b;box-sizing:border-box}
#card{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 120px;background:#0a0f14;z-index:3}
#card h1{font-size:76px;margin:0 0 18px;letter-spacing:.01em}#card p{font-size:27px;margin:6px 0;color:#b8c5cc;line-height:1.35}
#card code{color:#efa63b;font-size:24px}
</style><div id=grid><iframe id=a src="http://localhost:8088/"></iframe><iframe id=b src="http://127.0.0.1:8088/"></iframe></div>
<iframe id=single></iframe><div id=cap></div><div id=card></div>`;

const browser = await launchBrowser();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: RAW, size: { width: 1600, height: 900 } },
});
const stripHeaders = async (route) => {
  const res = await route.fetch();
  const headers = { ...res.headers() };
  delete headers['content-security-policy'];
  delete headers['x-frame-options'];
  await route.fulfill({ response: res, headers });
};
await ctx.route('**/*', async (route) => {
  if (route.request().url().endsWith('/__stage')) return route.fulfill({ contentType: 'text/html', body: STAGE });
  return stripHeaders(route);
});

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:8088/__stage');
const caption = (t) => page.evaluate((x) => { document.getElementById('cap').textContent = x; }, t);
const card = (title, lines) => page.evaluate(([t, l]) => {
  const c = document.getElementById('card');
  c.style.display = t ? 'flex' : 'none';
  c.innerHTML = t ? `<h1>${t}</h1>${l.map((x) => `<p>${x}</p>`).join('')}` : '';
}, [title, lines]);
const show = (mode, src) => page.evaluate(([m, s]) => {
  document.getElementById('grid').style.display = m === 'grid' ? 'grid' : 'none';
  const f = document.getElementById('single');
  f.style.display = m === 'single' ? 'block' : 'none';
  if (s) f.src = s;
}, [mode, src]);

const t0 = Date.now();
await card('Haute Mer', [
  'Bataille navale multijoueur en temps réel.',
  'WebSocket, deux instances derrière nginx, Redis Pub/Sub et Streams.',
  'Lancement : <code>docker compose up</code>',
]);
await caption('Vidéo de démonstration de secours');
await sleep(6000);
await card('', []);

const click = async (f, sel) => {
  await f.waitForSelector(sel);
  await f.evaluate((s) => document.querySelector(s)?.click(), sel);
};

const frameOf = (id) => page.frames().find((f) => f.url().includes(id === 'a' ? 'localhost:8088/' : '127.0.0.1:8088/') && !f.url().includes('__stage'));
const A = frameOf('a');
const B = frameOf('b');
await caption('Deux navigateurs indépendants ouvrent le jeu');
await sleep(2500);
await A.fill('#callsign', 'Amiral_Nemo');
await click(A, '#login-form button');
await sleep(1500);
await caption('Présence : le second joueur apparaît aussitôt chez le premier');
await B.fill('#callsign', 'Surcouf');
await click(B, '#login-form button');
await sleep(4500);
const stationOf = (f) => f.evaluate(() => document.getElementById('instance-text').textContent);
await caption(`Chaque client affiche son instance : ${await stationOf(A)} et ${await stationOf(B)}`);
await sleep(4000);

await caption('Salon privé : un code suffit pour rejoindre la partie');
await click(A, '#btn-room');
await A.waitForSelector('#room-code');
await sleep(2500);
await B.fill('#join-code', await A.textContent('#room-code'));
await click(B, '#join-form button');
for (const f of [A, B]) await f.waitForSelector('#screen-placement:not([hidden])');
await caption('Déploiement des flottes sur la grille');
await sleep(3500);
for (const f of [A, B]) {
  await click(f, '#btn-random');
  await sleep(1400);
}
await click(A, '#btn-ready');
await sleep(800);
await click(B, '#btn-ready');
for (const f of [A, B]) await f.waitForSelector('#screen-battle:not([hidden])');
await sleep(3000);

const fleetOf = (f) => f.evaluate(() => window.__bn.state.game.me.fleet);
const cells = (fleet) => fleet.flatMap(shipCells).map((c) => [c.x, c.y]);
const targets = { a: cells(await fleetOf(B)), b: cells(await fleetOf(A)) };
const targetKeys = {
  a: new Set(targets.a.map(([x, y]) => `${x},${y}`)),
  b: new Set(targets.b.map(([x, y]) => `${x},${y}`)),
};
const allGrid = [];
for (let x = 0; x < 10; x++) {
  for (let y = 0; y < 10; y++) allGrid.push([x, y]);
}
const waters = {
  a: allGrid.filter(([x, y]) => !targetKeys.a.has(`${x},${y}`)),
  b: allGrid.filter(([x, y]) => !targetKeys.b.has(`${x},${y}`)),
};
const myTurn = (f) => f.evaluate(() => { const g = window.__bn.state.game; return g.turn === g.you; });
const fire = (f, x, y) => f.evaluate(([cx, cy]) => {
  const { state } = window.__bn;
  state.conn.send('game.fire', { gameId: state.game.id, x: cx, y: cy, clientTs: Date.now() });
}, [x, y]);
const salvo = async (n) => {
  for (let i = 0; i < n; i++) {
    const useA = await myTurn(A);
    const f = useA ? A : B;
    const k = useA ? 'a' : 'b';
    const cell = (i % 3 === 2 && waters[k].length) ? waters[k].shift() : (targets[k].shift() || waters[k].shift());
    await fire(f, cell[0], cell[1]);
    await sleep(5200);
  }
};

await caption('Un tir chez un joueur part aussitôt chez l\'autre, à travers Redis');
await salvo(5);
await caption('Touché, coulé : feu, fumée, naufrage, tout est piloté par les événements du serveur');
await salvo(6);

const stopped = (await stationOf(A)).replace('Station ', '');
await caption(`Panne : arrêt de ${stopped} en pleine partie`);
await sleep(1500);
await run(`docker compose stop ${stopped}`);
await caption('Le client se reconnecte seul sur l\'autre instance, avec reprise par numéro de séquence');
await sleep(5000);
await caption(`Amiral_Nemo est maintenant sur « ${await stationOf(A)} », la partie continue`);
await salvo(3);
await run(`docker compose start ${stopped}`);

await show('single', 'http://localhost:3001/d/bataille-navale?orgId=1&refresh=5s&kiosk');
await caption('Observabilité : connexions, débit, latence, erreurs et déconnexions dans Grafana');
await sleep(13000);
await show('grid');

const defaultResults = [
  'WebSocket persistant avec JWT dans le sous-protocole',
  'Haute disponibilité : reprise transparente après coupure ou bascule d\'instance',
  'Ordonnancement garanti : Stream Redis et dédoublonnage par numéro de séquence',
  'Mesure de charge k6 : 1 000 joueurs simultanés sans dégradation (latence p95 < 6 ms)',
  'Optimisation présence : division par 4,8 du volume de messages (−79 %)',
];
const r = process.env.DEMO_RESULT_LINES ? JSON.parse(process.env.DEMO_RESULT_LINES) : defaultResults;
await card('Vérifié sur la pile réelle', r);
await caption('Résultats complets dans le dépôt : docs/garanties.md et docs/mesures.md');
await sleep(13000);
const elapsed = (Date.now() - t0) / 1000;
console.log('Scénario terminé, durée:', elapsed.toFixed(1), 's');
console.log('Finalisation de la vidéo Playwright...');
await page.close();
await ctx.close();
await browser.close();
const [file] = readdirSync(RAW).filter((f) => f.endsWith('.webm'));
mkdirSync(`${ROOT}docs/video`, { recursive: true });
copyFileSync(`${RAW}/${file}`, `${ROOT}docs/video/demo-haute-mer.webm`);
console.log('Vidéo enregistrée avec succès : docs/video/demo-haute-mer.webm');
