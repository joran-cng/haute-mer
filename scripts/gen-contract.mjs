// Génère docs/contrat-messages.md depuis shared/protocol.js : le document ne peut pas diverger du code.
import { writeFileSync } from 'node:fs';
import { CLIENT_MESSAGES, GAME_EVENTS, LIMITS, SERVER_MESSAGES } from '../shared/protocol.js';

const fieldsOf = (schema) => {
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  if (!names.length) return '(vide)';
  return names.map((n) => (schema.required?.includes(n) ? n : `${n}?`)).join(', ');
};
const json = (o) => JSON.stringify(o, null, 2);
const block = (o) => `\`\`\`json\n${json(o)}\n\`\`\``;
const ID = '0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001';
const TS = 1793620000123;
const G = '7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11';

const section = (title, entries, dir, wrap, fields) => `## ${title}\n\n${
  Object.entries(entries).map(([type, def]) => `### \`${type}\`\n\n${def.desc}\n\n- **Sens :** ${dir}\n- **Champs de \`payload\` :** ${fields(def)}\n\n${block(wrap(type, def))}\n`).join('\n')
}`;

const md = `# Contrat de messages

> Fichier généré par \`node scripts/gen-contract.mjs\` depuis \`shared/protocol.js\`. Les schémas de ce fichier
> sont ceux que le serveur applique ; le test \`server/test/protocol.test.js\` valide chaque exemple client, et
> \`tests/e2e/verify.mjs\` compare les trames réelles d'une partie à ce contrat.

## Transport

| Élément | Valeur |
|---|---|
| Point d'entrée | \`ws://hôte:8088/ws\` ou \`wss://hôte:8443/ws\` |
| Authentification | jeton JWT obtenu par \`POST /api/auth/guest\` (\`{ "name": "Nemo" }\`) |
| Sous-protocoles offerts | \`bn.v1\` et \`auth.<jeton>\` (l'API WebSocket du navigateur n'autorise pas d'en-tête \`Authorization\`) |
| Format | une trame texte = un objet JSON ; les trames binaires sont refusées |
| Taille | ${LIMITS.MAX_MESSAGE_BYTES} octets par message (erreur \`TOO_LARGE\`), ${LIMITS.MAX_FRAME_BYTES} octets par trame (fermeture 1009) |
| Débit | 20 messages/s, rafale de 40 (\`RATE_LIMITED\`), fermeture 1008 après 50 dépassements |

## Enveloppes

| Famille | Sens | Forme |
|---|---|---|
| Commande | client → serveur | \`{ id, type, payload }\` ; \`id\` est un UUID, clé d'idempotence |
| Message | serveur → client | \`{ id, type, ts, payload }\` ; \`ts\` en ms depuis l'époque Unix |
| Événement de partie | serveur → client | \`{ id, type, ts, gameId, seq, payload }\` ; \`seq\` croît de 1 par partie |

Les coordonnées vont de 0 à 9 : \`x\` pour la colonne (A à J), \`y\` pour la ligne (1 à 10). Les joueurs sont \`p1\` et \`p2\`.

## Fermetures de connexion

| Situation | Effet |
|---|---|
| Sans jeton valide | HTTP 401 à la poignée de main |
| Origine hors liste blanche | HTTP 403 à la poignée de main |
| Trame trop grosse | fermeture 1009 |
| Abus de débit | fermeture 1008 |
| Client trop lent | fermeture 1013 |
| Arrêt d'instance | \`sys.shutdown\`, puis fermeture 1012 |

${section('Commandes (client → serveur)', CLIENT_MESSAGES, 'client → serveur', (type, d) => ({ id: ID, type, payload: d.example }), (d) => fieldsOf(d.payload))}
${section('Messages (serveur → client)', SERVER_MESSAGES, 'serveur → client', (type, d) => ({ id: ID, type, ts: TS, payload: d.example }), (d) => d.fields)}
${section('Événements de partie (serveur → client, diffusés aux deux joueurs)', GAME_EVENTS, 'serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams', (type, d) => ({ id: ID, type, ts: TS, gameId: G, seq: 15, payload: d.example }), (d) => d.fields)}`;

writeFileSync(new URL('../docs/contrat-messages.md', import.meta.url), md);
