// Scénario de charge : chaque VU est un joueur complet (connexion authentifiée, appariement,
// placement, tirs, parties enchaînées). Paliers de connexions, mesurés uniquement sur le plateau.
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8088';
const WS_URL = __ENV.WS_URL || 'ws://localhost:8088/ws';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:8088';
const TIERS = (__ENV.TIERS || '100,200,400,600,800,1000').split(',').map(Number);
const RAMP_S = Number(__ENV.RAMP_S || 20);
const HOLD_S = Number(__ENV.HOLD_S || 40);
const THINK_MS = Number(__ENV.THINK_MS || 1000);

const SETTLE_S = 5; // début de plateau ignoré : le temps que les parties s'engagent

const shotLatency = new Trend('shot_e2e_ms', true);
const shots = new Counter('shots_received');
const wsErrors = new Counter('ws_app_errors');
const received = new Counter('ws_messages_received');

const stages = TIERS.flatMap((target) => [
  { duration: `${RAMP_S}s`, target },
  { duration: `${HOLD_S}s`, target },
]);
stages.push({ duration: '5s', target: 0 });

const thresholds = {};
for (const t of TIERS) {
  // Sans seuil, k6 ne publie pas les sous-métriques par palier dans le résumé.
  thresholds[`shot_e2e_ms{tier:${t}}`] = ['p(95)<60000'];
  thresholds[`shots_received{tier:${t}}`] = ['count>=0'];
  thresholds[`ws_messages_received{tier:${t}}`] = ['count>=0'];
  thresholds[`ws_app_errors{tier:${t}}`] = ['count>=0'];
}

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: { players: { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '3s', gracefulStop: '3s' } },
  thresholds,
};

export const setup = () => ({ startedAt: Date.now() });

/** Palier en cours, ou null pendant une montée. */
function currentTier() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  const period = RAMP_S + HOLD_S;
  const index = Math.floor(elapsed / period);
  const within = elapsed - index * period;
  if (index >= TIERS.length || within < RAMP_S + SETTLE_S) return null;
  return TIERS[index];
}

const FLEET = [
  { type: 'carrier', x: 0, y: 0, dir: 'h' }, { type: 'battleship', x: 0, y: 2, dir: 'h' },
  { type: 'cruiser', x: 0, y: 4, dir: 'h' }, { type: 'submarine', x: 0, y: 6, dir: 'h' },
  { type: 'destroyer', x: 0, y: 8, dir: 'h' },
];

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : (r % 4) + 8).toString(16);
});

function shuffledCells() {
  const cells = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) cells.push([x, y]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells;
}

export default function player() {
  const auth = http.post(`${BASE_URL}/api/auth/guest`, JSON.stringify({ name: `bot-${exec.vu.idInTest}` }), {
    headers: { 'content-type': 'application/json', origin: ORIGIN }, tags: { name: 'auth' },
  });
  if (auth.status !== 200) {
    wsErrors.add(1);
    return;
  }
  const { token, user } = auth.json();
  const params = { headers: { Origin: ORIGIN, 'Sec-WebSocket-Protocol': `bn.v1, auth.${token}` } };

  ws.connect(WS_URL, params, (socket) => {
    let gameId = null;
    let me = null;
    let cells = [];
    const send = (type, payload = {}) => socket.send(JSON.stringify({ id: uuid(), type, payload }));
    const tag = () => {
      const tier = currentTier();
      return tier ? { tier: String(tier) } : undefined;
    };
    const fire = () => {
      socket.setTimeout(() => {
        const [x, y] = cells.pop();
        send('game.fire', { gameId, x, y, clientTs: Date.now() });
      }, THINK_MS * (0.75 + Math.random() * 0.5));
    };

    socket.on('open', () => socket.setInterval(() => send('sys.ping', { clientTs: Date.now() }), 5000));
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const tags = tag();
      received.add(1, tags);
      switch (msg.type) {
        case 'sys.welcome':
          send('match.queue');
          break;
        case 'sys.error':
          wsErrors.add(1, { code: msg.payload.code, ...tags });
          break;
        case 'match.found':
          ({ gameId } = msg.payload);
          me = msg.payload.you;
          cells = shuffledCells();
          send('game.resume', { gameId, lastSeq: 0 });
          break;
        case 'game.snapshot':
          if (msg.payload.phase === 'placement' && !msg.payload.me.ready) send('game.place', { gameId, fleet: FLEET });
          break;
        case 'game.battle_started':
          if (msg.payload.firstTurn === me) fire();
          break;
        case 'game.shot':
          // Touché ou coulé : on rejoue.
          if (msg.payload.by === me && msg.payload.nextTurn === me) fire();
          if (msg.payload.by !== me) {
            // Horodatage : émission chez l'adversaire → réception ici (même horloge, k6 unique).
            if (msg.payload.clientTs) shotLatency.add(Date.now() - msg.payload.clientTs, tags);
            shots.add(1, tags);
            if (msg.payload.nextTurn === me) fire();
          }
          break;
        case 'game.finished':
          gameId = null;
          socket.setTimeout(() => send('match.queue'), 500);
          break;
        default:
      }
    });
    socket.on('error', () => wsErrors.add(1, tag()));
    void user;
  });
}

export function handleSummary(data) {
  return { [`/load/results/raw/${__ENV.LABEL || 'run'}.json`]: JSON.stringify(data) };
}
