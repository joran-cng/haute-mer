const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15000;
const STABLE_AFTER_MS = 5000;

/** Délai croissant plafonné, gigue « égale » : la moitié fixe, la moitié aléatoire. */
export function backoffDelay(attempt, random = Math.random) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

export class Connection {
  constructor({ url, getToken, onMessage, onStatus }) {
    Object.assign(this, { url, getToken, onMessage, onStatus });
    this.ws = null;
    this.attempt = 0;
    this.outbox = new Map();     // commandes non acquittées, renvoyées avec le même id
    this.heartbeatMs = 5000;
    this.lastSeen = 0;
    this.rtt = null;
    this.closed = false;
    window.addEventListener('online', () => this.retryNow());
  }

  connect() {
    this.closed = false;
    clearTimeout(this.retryTimer);
    this.onStatus({ state: this.attempt ? 'reconnecting' : 'connecting', attempt: this.attempt });
    const ws = new WebSocket(this.url, ['bn.v1', `auth.${this.getToken()}`]);
    this.ws = ws;
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {};
  }

  receive(data) {
    this.lastSeen = Date.now();
    const msg = JSON.parse(data);
    if (msg.type === 'sys.welcome') {
      this.heartbeatMs = msg.payload.heartbeatMs;
      this.openedAt = Date.now();
      this.startHeartbeat();
      this.onStatus({ state: 'online', instance: msg.payload.instance });
      this.onMessage(msg);
      // Renvoi des commandes restées sans réponse : le serveur les reconnaît à leur id.
      for (const pending of this.outbox.values()) this.write(pending);
      return;
    }
    if (msg.type === 'sys.pong') {
      this.rtt = Date.now() - msg.payload.clientTs;
      this.onStatus({ state: 'online', rtt: this.rtt, instance: msg.payload.instance });
      return;
    }
    if (msg.type === 'sys.ack' || msg.type === 'sys.error') this.outbox.delete(msg.payload.ref);
    this.onMessage(msg);
  }

  startHeartbeat() {
    clearInterval(this.heartbeat);
    this.ping();
    this.heartbeat = setInterval(() => {
      // Sans trafic depuis 3 périodes, la socket est considérée morte même si le navigateur l'ignore.
      if (Date.now() - this.lastSeen > this.heartbeatMs * 3) {
        this.ws?.close();
        this.handleClose(this.ws);
        return;
      }
      this.ping();
    }, this.heartbeatMs);
  }

  ping() { this.send('sys.ping', { clientTs: Date.now() }, { reliable: false }); }

  send(type, payload = {}, { reliable = true } = {}) {
    const msg = { id: crypto.randomUUID(), type, payload };
    if (reliable) this.outbox.set(msg.id, msg);
    this.write(msg);
    return msg.id;
  }

  write(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  handleClose(ws) {
    if (ws !== this.ws) return;
    this.ws = null;
    clearInterval(this.heartbeat);
    if (this.closed) return;
    if (this.openedAt && Date.now() - this.openedAt > STABLE_AFTER_MS) this.attempt = 0;
    this.openedAt = null;
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.onStatus({ state: 'waiting', attempt: this.attempt, delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  retryNow() {
    if (!this.ws && !this.closed) this.connect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
