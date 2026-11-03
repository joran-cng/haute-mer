// Vérifie les critères observables des phases 2, 3 et 4 sur la pile Docker réelle.
// Prérequis : docker compose up -d. Lancement : node verify.mjs
import { exec, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { parseClientMessage } from '../../server/src/validation.js';
import { CLIENT_MESSAGES, GAME_EVENTS, SERVER_MESSAGES } from '../../shared/protocol.js';
import {
  BASE, Bot, check, guest, launchBrowser, openPlayer, ORIGIN, report, sleep, startGame, WS_URL,
} from './lib.mjs';
import { startBlackholeProxy } from './blackhole-proxy.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const health = (svc) => JSON.parse(sh(`docker compose exec -T ${svc} wget -qO- http://127.0.0.1:3000/api/health`));
const shAsync = (cmd) => new Promise((resolve) => { exec(cmd, { cwd: ROOT }, () => resolve()); });
const forge = (claims, secret, exp) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b({ ...claims, exp })}.${secret}`;
};
const refused = async (session, opts) => {
  try {
    const bot = await Bot.open(session, opts);
    bot.close();
    return null;
  } catch (e) {
    return e.status ?? e.message;
  }
};
const expectEq = (a, b, what) => { if (a !== b) throw new Error(`${what} : attendu ${b}, obtenu ${a}`); };
const assert = (cond, what) => { if (!cond) throw new Error(what); };

const only = process.argv[2];
const section = async (name, fn) => {
  if (only && !name.toLowerCase().includes(only)) return;
  console.log(`\n== ${name}`);
  await fn();
};

await section('Phase 3 — refus de connexion', async () => {
  const good = await guest('Sentinelle');
  await check('sans jeton : 401', async () => {
    const status = await new Promise((resolve) => {
      const ws = new WebSocket(WS_URL, ['bn.v1'], { origin: ORIGIN });
      ws.on('unexpected-response', (_q, r) => resolve(r.statusCode));
      ws.on('open', () => resolve('ouvert'));
      ws.on('error', () => {});
    });
    expectEq(status, 401, 'statut');
    return 'HTTP 401';
  });
  await check('jeton forgé (alg none) : 401', async () => {
    expectEq(await refused({ token: forge({ sub: 'x', name: 'x' }, '', 9999999999) }), 401, 'statut');
    return 'HTTP 401';
  });
  await check('jeton à signature altérée : 401', async () => {
    expectEq(await refused({ token: `${good.token.slice(0, -3)}abc` }), 401, 'statut');
    return 'HTTP 401';
  });
  await check('origine absente de la liste blanche : 403', async () => {
    expectEq(await refused(good, { origin: 'https://evil.example' }), 403, 'statut');
    return 'HTTP 403';
  });
  await check('origine manquante : 403', async () => {
    const status = await new Promise((resolve) => {
      const ws = new WebSocket(WS_URL, ['bn.v1', `auth.${good.token}`]);
      ws.on('unexpected-response', (_q, r) => resolve(r.statusCode));
      ws.on('open', () => resolve('ouvert'));
      ws.on('error', () => {});
    });
    expectEq(status, 403, 'statut');
    return 'HTTP 403';
  });
  await check('jeton et origine valides : accepté', async () => {
    const bot = await Bot.open(good);
    const { instance } = bot.welcome;
    bot.close();
    return `servi par ${instance}`;
  });
  await check('/metrics non exposé par le répartiteur', async () => {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    assert(!text.includes('bn_ws_connections_active'), 'les métriques fuient');
  });
});

await section('Phase 3 — messages hostiles', async () => {
  const bot = await Bot.open(await guest('Hostile'));
  const sendRaw = (raw, opts) => bot.ws.send(raw, opts);
  const nextError = async (code) => (await bot.wait((m) => m.type === 'sys.error' && m.payload.code === code)).payload;
  await check('JSON illisible rejeté', async () => { sendRaw('{pas du json'); await nextError('BAD_JSON'); });
  await check('enveloppe invalide rejetée', async () => { sendRaw('{"type":1}'); await nextError('INVALID_MESSAGE'); });
  await check('type inconnu rejeté', async () => { bot.send('admin.drop'); await nextError('UNKNOWN_TYPE'); });
  await check('tir hors grille rejeté', async () => {
    bot.clear();
    bot.send('game.fire', { gameId: randomUUID(), x: 99, y: 0 });
    return (await nextError('INVALID_MESSAGE')).message;
  });
  await check('trame binaire rejetée', async () => { sendRaw(Buffer.from([1, 2, 3]), { binary: true }); await nextError('BINARY_REFUSED'); });
  await check('message > 4 Ko rejeté, connexion conservée', async () => {
    sendRaw('x'.repeat(5000));
    await nextError('TOO_LARGE');
    assert(bot.ws.readyState === WebSocket.OPEN, 'connexion fermée');
  });
  await check('trame > 64 Ko : fermeture 1009 de cette seule connexion', async () => {
    const victim = await Bot.open(await guest('Gros'));
    const closed = new Promise((r) => { victim.ws.once('close', r); });
    victim.ws.send('x'.repeat(70000));
    expectEq(await closed, 1009, 'code');
    return 'code 1009';
  });
  await check('limitation de débit (rafale de 200 messages)', async () => {
    const flood = await Bot.open(await guest('Rafale'));
    for (let i = 0; i < 200; i++) flood.send('sys.ping', { clientTs: 1 });
    await flood.wait((m) => m.type === 'sys.error' && m.payload.code === 'RATE_LIMITED');
    await sleep(300);
    const limited = flood.received.filter((m) => m.payload.code === 'RATE_LIMITED').length;
    const served = flood.received.filter((m) => m.type === 'sys.pong').length;
    flood.close();
    return `${served} servis, ${limited} refusés`;
  });
  await check('les deux instances répondent toujours', async () => {
    expectEq(health('game-1').status, 'ok', 'game-1');
    expectEq(health('game-2').status, 'ok', 'game-2');
  });
  bot.close();
});

await section('Phase 3 — présence', async () => {
  const watcher = await Bot.open(await guest('Vigie'));
  const leftAt = (id) => watcher.wait((m) => m.type === 'presence.delta' && m.payload.left.includes(id), 20000);
  await check('onglet fermé : disparaît en moins d\'1 s', async () => {
    const tab = await Bot.open(await guest('Onglet'));
    await watcher.wait((m) => m.type === 'presence.delta' && m.payload.joined.some((u) => u.id === tab.session.user.id));
    const t0 = Date.now();
    tab.close();
    await leftAt(tab.session.user.id);
    const ms = Date.now() - t0;
    assert(ms < 1000, `${ms} ms`);
    return `${ms} ms`;
  });
  await check('deux onglets du même joueur : reste présent jusqu\'au dernier', async () => {
    const session = await guest('Double');
    const one = await Bot.open(session);
    const two = await Bot.open(session);
    await sleep(700);
    one.close();
    await sleep(1200);
    assert(!watcher.received.some((m) => m.type === 'presence.delta' && m.payload.left.includes(session.user.id)), 'parti trop tôt');
    two.close();
    await leftAt(session.user.id);
  });
  await check('liaison muette (plus de pong) : disparaît en 15 s au plus', async () => {
    const session = await guest('Muet');
    const ws = new WebSocket(WS_URL, ['bn.v1', `auth.${session.token}`], { origin: ORIGIN, autoPong: false });
    await new Promise((r) => { ws.once('open', r); });
    await sleep(300);
    const t0 = Date.now();
    await leftAt(session.user.id);
    const ms = Date.now() - t0;
    ws.terminate();
    assert(ms <= 15000, `${ms} ms`);
    return `${(ms / 1000).toFixed(1)} s`;
  });
  watcher.close();
});

await section('Phase 4 — instances, doublons, désordre', async () => {
  const g = await startGame();
  await check('deux clients sur deux instances échangent', async () => {
    assert(g.a.welcome.instance !== g.b.welcome.instance, `même instance ${g.a.welcome.instance}`);
    const t0 = Date.now();
    // Tir à l'eau (case vide de la flotte fixe) : le tour passe au second joueur.
    g.first.send('game.fire', { gameId: g.gameId, x: 9, y: 9, clientTs: t0 });
    const e = await g.second.wait('game.shot');
    return `${g.first.welcome.instance} → ${g.second.welcome.instance} en ${Date.now() - e.payload.clientTs} ms`;
  });
  await check('commande rejouée (même id) : un seul effet', async () => {
    const id = randomUUID();
    await sleep(200); // laisse arriver l'écho du tir précédent
    g.second.clear();
    g.first.clear();
    g.second.send('game.fire', { gameId: g.gameId, x: 9, y: 9 }, id);
    await g.second.wait((m) => m.type === 'sys.ack' && m.payload.ref === id);
    g.second.send('game.fire', { gameId: g.gameId, x: 9, y: 9 }, id);
    const dup = await g.second.wait((m) => m.type === 'sys.ack' && m.payload.ref === id && m.payload.duplicate);
    await sleep(200);
    expectEq(g.first.received.filter((m) => m.type === 'game.shot').length, 1, 'événements émis');
    return `ack duplicate=${dup.payload.duplicate}`;
  });
  await check('même commande sur deux instances en même temps : un seul effet', async () => {
    const id = randomUUID();
    const sameUserOther = await Bot.open(g.first.session);
    g.second.clear();
    g.first.send('game.fire', { gameId: g.gameId, x: 1, y: 0 }, id);
    sameUserOther.send('game.fire', { gameId: g.gameId, x: 1, y: 0 }, id);
    await g.second.wait('game.shot');
    await sleep(300);
    expectEq(g.second.received.filter((m) => m.type === 'game.shot').length, 1, 'événements émis');
    sameUserOther.close();
  });
  await check('écritures concurrentes sur deux instances : seq sans trou ni doublon', async () => {
    g.a.clear();
    g.b.clear();
    await sleep(150);
    for (let i = 0; i < 12; i++) {
      g.a.send('chat.send', { gameId: g.gameId, text: `a${i}` });
      g.b.send('chat.send', { gameId: g.gameId, text: `b${i}` });
    }
    await sleep(1500);
    const seqs = g.a.received.filter((m) => m.type === 'chat.message').map((m) => m.seq);
    expectEq(seqs.length, 24, 'messages reçus');
    const sorted = [...seqs].sort((x, y) => x - y);
    sorted.forEach((s, i) => { if (i && s !== sorted[i - 1] + 1) throw new Error(`trou entre ${sorted[i - 1]} et ${s}`); });
    return `seq ${sorted[0]} à ${sorted.at(-1)}`;
  });
  g.a.close();
  g.b.close();
});

await section('Phase 2 — navigateurs réels', async () => {
  const browser = await launchBrowser();
  const proxy = await startBlackholeProxy(18089);
  const proxied = await launchBrowser({
    proxy: { server: 'http://127.0.0.1:18089' },
    args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--mute-audio', '--proxy-bypass-list=<-loopback>'],
  });
  const frames = [];
  const a = await openPlayer(browser, 'Alpha');
  const b = await openPlayer(proxied, 'Bravo');
  const collect = (page) => page.on('websocket', (ws) => {
    ws.on('framesent', (f) => frames.push({ dir: 'out', raw: f.payload }));
    ws.on('framereceived', (f) => frames.push({ dir: 'in', raw: f.payload }));
  });
  // Rechargement pour capturer dès la poignée de main (sessionStorage conserve la session).
  for (const p of [a.page, b.page]) {
    collect(p);
    await p.reload();
    await p.waitForSelector('#screen-lobby:not([hidden])');
  }
  await check('présence croisée visible dans les deux navigateurs', async () => {
    await a.page.waitForFunction(() => document.querySelectorAll('#presence-list li').length >= 2, null, { timeout: 4000 });
  });
  await a.page.click('#btn-room');
  await a.page.waitForSelector('#room-code');
  await b.page.fill('#join-code', await a.page.textContent('#room-code'));
  await b.page.click('#join-form button');
  for (const p of [a.page, b.page]) {
    await p.waitForSelector('#screen-placement:not([hidden])');
    await p.click('#btn-random');
    await p.click('#btn-ready');
  }
  for (const p of [a.page, b.page]) await p.waitForSelector('#screen-battle:not([hidden])');
  await sleep(2200);
  const turnOf = (p) => p.evaluate(() => { const g = window.__bn.state.game; return g.turn === g.you; });
  const [shooter, target] = (await turnOf(a.page)) ? [a.page, b.page] : [b.page, a.page];
  const cell = await shooter.evaluate(() => {
    const { world } = window.__bn;
    const v = { x: 65 + (4 - 4.5) * 10, y: 0, z: (4 - 4.5) * 10 };
    const p = new world.camera.position.constructor(v.x, v.y, v.z).project(world.camera);
    const r = world.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height };
  });
  await check('un tir à la souris est visible chez l\'adversaire en moins d\'1 s', async () => {
    await target.evaluate(() => {
      window.__seenAt = null;
      const inbox = window.__bn.state.inbox;
      const push = inbox.onEvent;
      inbox.onEvent = (e) => { if (e.type === 'game.shot') window.__seenAt = Date.now(); push(e); };
    });
    const t0 = Date.now();
    await shooter.mouse.click(cell.x, cell.y);
    await target.waitForFunction(() => window.__seenAt, null, { timeout: 3000 });
    const ms = (await target.evaluate(() => window.__seenAt)) - t0;
    assert(ms < 1000, `${ms} ms`);
    return `${ms} ms`;
  });
  await check('messages observés conformes au contrat', async () => {
    await sleep(500);
    const known = { ...SERVER_MESSAGES, ...GAME_EVENTS };
    let client = 0;
    let server = 0;
    for (const f of frames) {
      if (f.dir === 'out') {
        const r = parseClientMessage(f.raw);
        assert(r.ok, `client non conforme : ${f.raw.slice(0, 120)} (${r.message})`);
        assert(CLIENT_MESSAGES[r.msg.type], `type absent du contrat : ${r.msg.type}`);
        client++;
      } else {
        const m = JSON.parse(f.raw);
        assert(known[m.type], `type serveur absent du contrat : ${m.type}`);
        assert(m.id && m.ts && m.payload, `enveloppe incomplète : ${f.raw.slice(0, 120)}`);
        if (GAME_EVENTS[m.type]) assert(m.gameId && m.seq > 0, `événement sans seq : ${m.type}`);
        server++;
      }
    }
    return `${client} client, ${server} serveur`;
  });

  await section('Phase 3 — coupure réseau', async () => {
    const victim = b.page;
    const other = a.page;
    const chat = (text) => other.evaluate((t) => {
      const { state } = window.__bn;
      state.conn.send('chat.send', { gameId: state.game.id, text: t });
    }, text);
    const inLog = (text) => victim.waitForFunction((t) => document.getElementById('log').textContent.includes(t), text, { timeout: 25000 });
    const lastSeq = () => victim.evaluate(() => window.__bn.state.inbox.lastSeq);

    await check('coupure silencieuse de 10 s : retour seul, messages manqués rattrapés', async () => {
      const before = await lastSeq();
      proxy.cut();
      await sleep(1000);
      await chat('Emis pendant la coupure');
      await chat('Second message manque');
      await sleep(1000);
      const during = await victim.evaluate(() => document.getElementById('log').textContent.includes('Emis pendant'));
      assert(!during, 'le message a traversé la coupure : proxy inefficace');
      await sleep(8000);
      const t0 = Date.now();
      proxy.restore();
      await inLog('Second message manque');
      await victim.waitForFunction(() => document.getElementById('link-text').textContent === 'Liaison établie', null, { timeout: 25000 });
      return `seq ${before} → ${await lastSeq()}, rattrapé ${Date.now() - t0} ms après le retour du réseau`;
    });

    await check('coupure silencieuse de 22 s : le client détecte seul la liaison morte', async () => {
      const before = await lastSeq();
      proxy.cut();
      const t0 = Date.now();
      await chat('Emis pendant la longue coupure');
      await victim.waitForFunction(() => document.getElementById('link-text').textContent.startsWith('Tentative'), null, { timeout: 21000 });
      const detected = Date.now() - t0;
      await sleep(Math.max(0, 22000 - detected));
      proxy.restore();
      await inLog('Emis pendant la longue coupure');
      return `détectée en ${(detected / 1000).toFixed(1)} s, seq ${before} → ${await lastSeq()}`;
    });
  });

  await section('Phase 4 — arrêt d\'une instance', async () => {
    await check('arrêt de l\'instance servant un client : reconnexion sur l\'autre', async () => {
      const stationOf = (p) => p.evaluate(() => document.getElementById('instance-text').textContent.replace('Station ', ''));
      const before = await stationOf(target);
      const survivor = before === 'game-1' ? 'game-2' : 'game-1';
      const t0 = Date.now();
      const stopping = shAsync(`docker compose stop ${before}`);
      await target.waitForFunction((s) => document.getElementById('instance-text').textContent === `Station ${s}`, survivor, { timeout: 25000 });
      const ms = Date.now() - t0;
      await stopping;
      const gameId = await target.evaluate(() => window.__bn.state.game.id);
      await target.evaluate(([id]) => window.__bn.state.conn.send('chat.send', { gameId: id, text: 'Toujours en ligne' }), [gameId]);
      await shooter.waitForFunction(() => document.getElementById('log').textContent.includes('Toujours en ligne'), null, { timeout: 8000 });
      sh(`docker compose start ${before}`);
      return `${before} arrêtée, ${survivor} prend le relais en ${ms} ms, partie conservée`;
    });
  });

  await section('Phase 4 — doublon et désordre dans le navigateur', async () => {
    await sleep(500);
    await check('doublon injecté sur le broker : ignoré, désordre : remis en ordre', async () => {
      const { gameId, lastSeq } = await target.evaluate(() => ({ gameId: window.__bn.state.game.id, lastSeq: window.__bn.state.inbox.lastSeq }));
      const evt = (seq, text) => JSON.stringify({ id: randomUUID(), type: 'chat.message', ts: Date.now(), gameId, seq, payload: { player: 'p1', name: 'Injection', text } });
      const channel = `bn:ch:game:${gameId}`;
      const file = `${ROOT}tests/e2e/artifacts/inject.txt`;
      const cmds = [evt(lastSeq + 2, 'deuxieme'), evt(lastSeq + 1, 'premier'), evt(lastSeq + 1, 'premier'), evt(lastSeq + 2, 'deuxieme')]
        .map((e) => `PUBLISH ${channel} ${JSON.stringify(e)}`).join('\n');
      writeFileSync(file, `${cmds}\n`);
      execSync('docker compose exec -T redis redis-cli', { cwd: ROOT, input: readFileSync(file) });
      await target.waitForFunction(() => document.getElementById('log').textContent.includes('deuxieme'), null, { timeout: 4000 });
      const info = await target.evaluate(() => ({
        dup: window.__bn.state.inbox.duplicates,
        order: [...document.querySelectorAll('#log li')].map((l) => l.textContent).filter((t) => /Injection/.test(t)).map((t) => t.split(' : ')[1]),
      }));
      expectEq(info.order.join(','), 'premier,deuxieme', 'ordre');
      assert(info.dup >= 2, `doublons comptés : ${info.dup}`);
      return `ordre ${info.order.join(' puis ')}, ${info.dup} doublons écartés`;
    });
  });

  await browser.close();
  await proxied.close();
  proxy.close();
});

await section('Phase 3 — instance tuée', async () => {
  await check('instance tuée sans préavis : présence purgée en 20 s au plus', async () => {
    let doomed;
    let watcher;
    for (let i = 0; i < 12; i++) {
      const bot = await Bot.open(await guest('Condamne'));
      if (bot.welcome.instance === 'game-1') { doomed = bot; break; }
      bot.close();
    }
    for (let i = 0; i < 12 && !watcher; i++) {
      const bot = await Bot.open(await guest('Temoin'));
      if (bot.welcome.instance === 'game-2') watcher = bot;
      else bot.close();
    }
    assert(doomed && watcher, 'répartition impossible');
    doomed.ws.on('error', () => {});
    const t0 = Date.now();
    sh('docker compose kill game-1');
    await watcher.wait((m) => m.type === 'presence.delta' && m.payload.left.includes(doomed.session.user.id), 25000);
    const ms = Date.now() - t0;
    sh('docker compose start game-1');
    watcher.close();
    assert(ms <= 20000, `${ms} ms`);
    return `${(ms / 1000).toFixed(1)} s`;
  });
});

report();
