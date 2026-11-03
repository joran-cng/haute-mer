// Proxy HTTP/CONNECT capable de geler le trafic sans fermer les connexions : du point de vue des
// deux extrémités, c'est un câble débranché (ni FIN ni RST), contrairement à context.setOffline(),
// qui laisse vivre les WebSocket déjà ouvertes.
import http from 'node:http';
import net from 'node:net';

export function startBlackholeProxy(port) {
  const tunnels = new Set();
  let cut = false;

  const server = http.createServer((req, res) => {
    if (cut) { req.socket.destroy(); return; }
    const url = new URL(req.url);
    const upstream = http.request({
      host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers: req.headers,
    }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req, client, head) => {
    if (cut) { client.destroy(); return; }
    const [host, p] = req.url.split(':');
    const upstream = net.connect(Number(p), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    const pair = { client, upstream };
    tunnels.add(pair);
    const drop = () => { tunnels.delete(pair); client.destroy(); upstream.destroy(); };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      cut() {
        cut = true;
        for (const { client, upstream } of tunnels) {
          client.unpipe(upstream);
          upstream.unpipe(client);
          client.pause();
          upstream.pause();
        }
      },
      restore() {
        cut = false;
        for (const { client, upstream } of tunnels) {
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
          upstream.resume();
        }
      },
      close() {
        for (const { client, upstream } of tunnels) { client.destroy(); upstream.destroy(); }
        server.close();
      },
    }));
  });
}
