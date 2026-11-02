import { randomUUID } from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { LIMITS } from '../../shared/protocol.js';
import { Commands } from './commands.js';
import { config } from './config.js';
import { Hub } from './hub.js';
import { log } from './log.js';
import { metrics, registry } from './metrics.js';
import { Store } from './store.js';
import { parseClientMessage, TokenBucket } from './validation.js';

const SUBPROTOCOL = 'bn.v1';
const TOKEN_PREFIX = 'auth.';
const NAME_PATTERN = /^[\p{L}\p{N} _-]{2,20}$/u;

const store = new Store();
const hub = new Hub(store);
const commands = new Commands(store, hub);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req, maxBytes = 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) reject(new Error('too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function issueGuestToken(req, res) {
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.has(origin)) return json(res, 403, { error: 'ORIGIN_FORBIDDEN' });
  let name;
  try {
    ({ name } = JSON.parse(await readBody(req)));
  } catch {
    return json(res, 400, { error: 'BAD_REQUEST' });
  }
  name = typeof name === 'string' ? name.trim() : '';
  if (!NAME_PATTERN.test(name)) return json(res, 422, { error: 'INVALID_NAME' });
  const user = { id: randomUUID(), name };
  const token = jwt.sign({ name }, config.jwtSecret, {
    subject: user.id, expiresIn: config.jwtTtlSeconds, algorithm: 'HS256',
  });
  return json(res, 200, { token, user, expiresIn: config.jwtTtlSeconds });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/auth/guest') return await issueGuestToken(req, res);
    if (req.method === 'GET' && req.url === '/api/health') {
      await store.ping();
      return json(res, 200, { status: 'ok', instance: config.instance, connections: hub.conns.size });
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType });
      return res.end(await registry.metrics());
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    log.error('http.failed', { url: req.url, error: err.message });
    return json(res, 500, { error: 'INTERNAL' });
  }
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: LIMITS.MAX_FRAME_BYTES,
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
});

function refuse(socket, status, reason) {
  metrics.rejected.inc({ reason });
  log.warn('ws.refused', { reason, status });
  const text = http.STATUS_CODES[status];
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Sécurité à la poignée de main : rien n'est alloué pour une connexion refusée.
// Le jeton circule dans Sec-WebSocket-Protocol, l'API navigateur ne permettant pas d'en-tête
// Authorization, et il n'apparaît ainsi pas dans les URL ni les journaux d'accès.
function authenticate(req) {
  const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
  const entry = offered.find((p) => p.startsWith(TOKEN_PREFIX));
  if (!entry) return null;
  try {
    const claims = jwt.verify(entry.slice(TOKEN_PREFIX.length), config.jwtSecret, { algorithms: ['HS256'] });
    return { id: claims.sub, name: claims.name };
  } catch {
    return null;
  }
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  if (new URL(req.url, 'http://x').pathname !== '/ws') return refuse(socket, 404, 'bad_path');
  if (!config.allowedOrigins.has(req.headers.origin)) return refuse(socket, 403, 'origin');
  const user = authenticate(req);
  if (!user) return refuse(socket, 401, 'token');
  return wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
});

async function onConnection(ws, user) {
  const conn = {
    id: `${config.instance}-${randomUUID().slice(0, 8)}`,
    ws, user, alive: true, strikes: 0, games: new Set(), closeReason: null,
    bucket: new TokenBucket(config.rateLimitPerSecond, config.rateLimitBurst),
  };

  // Tout message reçu pendant l'enregistrement Redis attend dans cette chaîne : l'ordre des
  // commandes d'une connexion est conservé.
  let chain = Promise.resolve();
  ws.on('pong', () => { conn.alive = true; });
  ws.on('error', (err) => { conn.closeReason = err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'too_large' : 'socket_error'; });
  ws.on('message', (data, isBinary) => {
    conn.alive = true;
    chain = chain.then(() => onMessage(conn, data, isBinary)).catch((err) => log.error('message.failed', { error: err.message }));
  });
  ws.on('close', (code) => {
    metrics.disconnects.inc({ reason: conn.closeReason ?? (code === 1001 || code === 1000 ? 'client_closed' : 'network') });
    log.info('ws.closed', { conn: conn.id, user: user.name, code });
    chain = chain.then(() => onClose(conn)).catch((err) => log.error('close.failed', { error: err.message }));
  });

  chain = chain.then(async () => {
    const { activeGame, presence } = await hub.register(conn);
    log.info('ws.connected', { conn: conn.id, user: user.name });
    hub.send(conn, 'sys.welcome', {
      connId: conn.id, instance: config.instance, user, presence, activeGame, heartbeatMs: config.heartbeatMs,
    });
  }).catch((err) => {
    log.error('register.failed', { error: err.message });
    ws.close(1011, 'indisponible');
  });
}

async function onMessage(conn, data, isBinary) {
  const rx = Date.now();
  metrics.bytes.inc({ direction: 'in' }, data.length);
  if (!conn.bucket.take(rx)) {
    conn.strikes += 1;
    if (conn.strikes >= config.rateLimitMaxStrikes) {
      conn.closeReason = 'rate_limited';
      conn.ws.close(1008, 'rate limit');
      return;
    }
    hub.sendError(conn, null, 'RATE_LIMITED', 'Trop de messages');
    return;
  }
  if (isBinary) {
    metrics.messages.inc({ direction: 'in', type: 'invalid' });
    hub.sendError(conn, null, 'BINARY_REFUSED', 'Trames texte uniquement');
    return;
  }
  const parsed = parseClientMessage(data.toString());
  if (!parsed.ok) {
    metrics.messages.inc({ direction: 'in', type: 'invalid' });
    log.warn('message.rejected', { conn: conn.id, code: parsed.code, detail: parsed.message });
    hub.sendError(conn, parsed.ref, parsed.code, parsed.message);
    return;
  }
  metrics.messages.inc({ direction: 'in', type: parsed.msg.type });
  await commands.dispatch(conn, parsed.msg, rx);
}

async function onClose(conn) {
  const leftGames = await hub.unregister(conn);
  if (!hub.byUser.has(conn.user.id)) await store.leaveQueue({ id: conn.user.id, name: conn.user.name });
  await Promise.all(leftGames.map((gameId) =>
    commands.announceConnection(gameId, conn.user.id, false).catch(() => {})));
}

const every = (ms, task) => setInterval(() => {
  Promise.resolve().then(task).catch((err) => log.warn('task.failed', { error: err.message }));
}, ms);

const timers = [
  every(config.heartbeatMs, () => hub.heartbeat()),
  every(1000, () => commands.sweepDeadlines()),
  every(3000, () => hub.sweepPresence()),
];

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutdown', { signal, connections: hub.conns.size });
  timers.forEach(clearInterval);
  hub.shutdown();
  server.close();
  setTimeout(async () => {
    await store.close();
    process.exit(0);
  }, 400);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => log.error('uncaught', { error: err.message, stack: err.stack }));
process.on('unhandledRejection', (err) => log.error('unhandled', { error: String(err) }));

server.listen(config.port, () => {
  log.info('listening', { port: config.port, presenceBatchMs: config.presenceBatchMs });
});
