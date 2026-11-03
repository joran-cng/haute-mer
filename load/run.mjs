// Pilote de mesure reproductible : node load/run.mjs <etiquette> [PRESENCE_BATCH_MS]
// Repart d'instances neuves, exécute k6, relève Prometheus et écrit load/results/<etiquette>.json.
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const [label = 'run', batchMs = '500'] = process.argv.slice(2);
const TIERS = (process.env.TIERS ?? '100,200,400,600,800,1000').split(',').map(Number);
const RAMP_S = Number(process.env.RAMP_S ?? 20);
const HOLD_S = Number(process.env.HOLD_S ?? 40);
const PROM = 'http://localhost:9090/api/v1';

const sh = (cmd, env = {}) => execSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function rangeQuery(expr, start, end) {
  const url = `${PROM}/query_range?query=${encodeURIComponent(expr)}&start=${start}&end=${end}&step=5`;
  const json = await (await fetch(url)).json();
  return json.data.result.flatMap((r) => r.values.map(([t, v]) => [t, Number(v)]));
}

const mean = (rows) => (rows.length ? rows.reduce((s, [, v]) => s + v, 0) / rows.length : 0);
const peak = (rows) => rows.reduce((m, [, v]) => (Number.isFinite(v) && v > m ? v : m), 0);

mkdirSync(`${ROOT}load/results/raw`, { recursive: true });
console.log(`[${label}] instances neuves, PRESENCE_BATCH_MS=${batchMs}`);
sh('docker compose exec -T redis redis-cli FLUSHALL');
sh('docker compose up -d --force-recreate game-1 game-2', { PRESENCE_BATCH_MS: batchMs });
await sleep(8000);

const k6 = spawnSync('docker', [
  'compose', '--profile', 'load', 'run', '--rm', '--no-deps',
  '-e', `LABEL=${label}`, '-e', `TIERS=${TIERS.join(',')}`, '-e', `RAMP_S=${RAMP_S}`, '-e', `HOLD_S=${HOLD_S}`,
  'k6', 'run', '--quiet', '--no-usage-report', '/load/scenario.js',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
console.log(`k6 terminé, code ${k6.status}`);

const summary = JSON.parse(readFileSync(`${ROOT}load/results/raw/${label}.json`, 'utf8'));
const started = Math.floor(summary.setup_data.startedAt / 1000); // horloge de k6, pas celle du pilote
const metric = (name, tier) => summary.metrics[`${name}{tier:${tier}}`]?.values;
const period = RAMP_S + HOLD_S;
const measured = HOLD_S - 5;

const tiers = [];
for (let i = 0; i < TIERS.length; i++) {
  const from = started + i * period + RAMP_S + 5;
  const to = started + (i + 1) * period;
  const q = (expr) => rangeQuery(expr, from, to);
  const lat = metric('shot_e2e_ms', TIERS[i]) ?? {};
  tiers.push({
    connections: TIERS[i],
    connectionsObserved: Math.round(mean(await q('sum(bn_ws_connections_active)'))),
    p50Ms: lat['p(50)'] ?? null,
    p95Ms: lat['p(95)'] ?? null,
    p99Ms: lat['p(99)'] ?? null,
    shotsPerSecond: (metric('shots_received', TIERS[i])?.count ?? 0) / measured,
    wsMessagesPerSecond: mean(await q('sum(rate(bn_ws_messages_total[20s]))')),
    outMessagesPerSecond: mean(await q('sum(rate(bn_ws_messages_total{direction="out"}[20s]))')),
    outBytesPerSecond: mean(await q('sum(rate(bn_ws_bytes_total{direction="out"}[20s]))')),
    cpuCoresTotal: mean(await q('sum(rate(bn_node_process_cpu_seconds_total[20s]))')),
    eventLoopP99Ms: peak(await q('max(bn_node_nodejs_eventloop_lag_p99_seconds)')) * 1000,
    errors: metric('ws_app_errors', TIERS[i])?.count ?? 0,
  });
}

const result = { label, presenceBatchMs: Number(batchMs), date: new Date().toISOString(), rampS: RAMP_S, holdS: HOLD_S, tiers };
writeFileSync(`${ROOT}load/results/${label}.json`, `${JSON.stringify(result, null, 2)}\n`);
console.table(tiers.map((t) => ({
  conn: t.connectionsObserved, p50: t.p50Ms?.toFixed(1), p95: t.p95Ms?.toFixed(1), 'tirs/s': t.shotsPerSecond.toFixed(0),
  'msg/s': t.wsMessagesPerSecond.toFixed(0), cpu: t.cpuCoresTotal.toFixed(2), errs: t.errors,
})));
