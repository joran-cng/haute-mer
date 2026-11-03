// Partage la partie locale via un tunnel ngrok, pour jouer à deux depuis deux réseaux différents.
//
//   node scripts/partage-ngrok.mjs
//
// Prérequis : ngrok v3 installé et authentifié (ngrok config add-authtoken <jeton>).
// Le script ouvre le tunnel, lit son adresse publique, l'ajoute à ALLOWED_ORIGINS
// puis (re)lance la pile Docker. Ctrl+C ferme le tunnel ; la pile reste démarrée.
import { spawn, spawnSync } from 'node:child_process';

const port = process.env.HTTP_PORT ?? '8088';
const ngrokBin = process.env.NGROK_BIN ?? 'ngrok';
const isWindows = process.platform === 'win32';
const baseOrigins = (process.env.ALLOWED_ORIGINS
  ?? 'http://localhost:8088,https://localhost:8443,http://127.0.0.1:8088').split(',');

const args = ['http', port, '--log', 'stdout'];
// Domaine réservé facultatif (ex. mon-nom.ngrok-free.app) pour garder la même adresse.
if (process.env.NGROK_DOMAIN) args.push(`--url=${process.env.NGROK_DOMAIN}`);

const ngrok = spawn(ngrokBin, args, { shell: isWindows, stdio: ['ignore', 'pipe', 'inherit'] });
ngrok.on('error', (err) => fail(`ngrok introuvable (${err.message}). Installez-le ou indiquez NGROK_BIN.`));
ngrok.on('exit', (code) => fail(`ngrok s'est arrêté (code ${code}). Vérifiez l'authtoken : ngrok config add-authtoken <jeton>`));

let lastLog = '';
ngrok.stdout.on('data', (chunk) => { lastLog = chunk.toString().trim().split('\n').pop(); });

const publicUrl = await waitForTunnel();
const origins = [...new Set([...baseOrigins, publicUrl])].join(',');

console.log(`Tunnel ouvert : ${publicUrl}`);
console.log('Démarrage de la pile Docker avec cette origine autorisée…');
const up = spawnSync('docker', ['compose', 'up', '-d', '--build', 'lb'], {
  stdio: 'inherit',
  shell: isWindows,
  env: { ...process.env, ALLOWED_ORIGINS: origins },
});
if (up.status !== 0) fail('docker compose up a échoué. Docker Desktop est-il lancé ?');

console.log(`
  Partie accessible ici : ${publicUrl}
  Envoyez ce lien à votre adversaire. Sur la page d'avertissement ngrok, cliquez « Visit Site ».
  Ctrl+C pour fermer le tunnel.
`);

process.on('SIGINT', () => {
  ngrok.removeAllListeners('exit');
  ngrok.kill();
  console.log('\nTunnel fermé. Pour arrêter le jeu : docker compose down');
  process.exit(0);
});

async function waitForTunnel() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels');
      const { tunnels } = await res.json();
      const https = tunnels.find((t) => t.public_url.startsWith('https://'));
      if (https) return https.public_url;
    } catch { /* API locale pas encore prête */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`Le tunnel ngrok n'a pas répondu à temps.${lastLog ? `\nDernier journal : ${lastLog}` : ''}`);
}

function fail(message) {
  console.error(message);
  if (ngrok.exitCode === null) ngrok.kill();
  process.exit(1);
}
