// Source unique du contrat de messages : schémas JSON (validés par Ajv côté serveur),
// descriptions et exemples. docs/contrat-messages.md est généré depuis ce fichier.

const uuid = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' };
const coord = { type: 'integer', minimum: 0, maximum: 9 };
const player = { enum: ['p1', 'p2'] };
const shipType = { enum: ['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer'] };
const ship = {
  type: 'object',
  required: ['type', 'x', 'y', 'dir'],
  additionalProperties: false,
  properties: { type: shipType, x: coord, y: coord, dir: { enum: ['h', 'v'] } },
};
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, required, properties,
});
const empty = obj({}, []);
const G = '7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11';
const fleetEx = [
  { type: 'carrier', x: 0, y: 0, dir: 'h' }, { type: 'battleship', x: 0, y: 2, dir: 'h' },
  { type: 'cruiser', x: 0, y: 4, dir: 'v' }, { type: 'submarine', x: 5, y: 5, dir: 'h' },
  { type: 'destroyer', x: 9, y: 8, dir: 'v' },
];

/** Commandes client → serveur. Enveloppe : { id, type, payload }. */
export const CLIENT_MESSAGES = {
  'sys.ping': { desc: 'Battement applicatif (5 s) : mesure le RTT et prouve que le lien est vivant.', payload: obj({ clientTs: { type: 'number' } }), example: { clientTs: 1793620000000 } },
  'match.queue': { desc: 'Entrer dans la file d\'appariement.', payload: empty, example: {} },
  'match.cancel': { desc: 'Quitter la file.', payload: empty, example: {} },
  'room.create': { desc: 'Créer un salon privé ; `invite` prévient directement un joueur connecté.', payload: obj({ invite: uuid }, []), example: { invite: '4b3a7a10-5b2f-4f0e-8a65-3f6d1e0c2a77' } },
  'room.join': { desc: 'Rejoindre un salon par son code.', payload: obj({ code: { type: 'string', pattern: '^[A-Z2-9]{6}$' } }), example: { code: 'K7TQ2M' } },
  'game.resume': { desc: 'Se rattacher à une partie et rejouer les événements après `lastSeq` (0 = instantané complet).', payload: obj({ gameId: uuid, lastSeq: { type: 'integer', minimum: 0 } }), example: { gameId: G, lastSeq: 12 } },
  'game.place': { desc: 'Déclarer sa flotte (5 navires).', payload: obj({ gameId: uuid, fleet: { type: 'array', minItems: 5, maxItems: 5, items: ship } }), example: { gameId: G, fleet: fleetEx } },
  'game.fire': { desc: 'Tirer sur une case. `clientTs` sert à mesurer la latence de bout en bout.', payload: obj({ gameId: uuid, x: coord, y: coord, clientTs: { type: 'number' } }, ['gameId', 'x', 'y']), example: { gameId: G, x: 3, y: 7, clientTs: 1793620000000 } },
  'game.forfeit': { desc: 'Abandonner.', payload: obj({ gameId: uuid }), example: { gameId: G } },
  'game.rematch': { desc: 'Proposer ou accepter une revanche.', payload: obj({ gameId: uuid }), example: { gameId: G } },
  'chat.send': { desc: 'Message texte de partie (200 caractères max).', payload: obj({ gameId: uuid, text: { type: 'string', minLength: 1, maxLength: 200 } }), example: { gameId: G, text: 'Touché, bien joué !' } },
};

const userInfo = { id: 'd2f1b8a0-8a5e-4c55-9d73-0f6f2c1e4b10', name: 'Amiral_Nemo', status: 'lobby' };

/** Messages serveur → client hors journal de partie. Enveloppe : { id, type, ts, payload }. */
export const SERVER_MESSAGES = {
  'sys.welcome': { desc: 'Premier message après connexion : identité, instance servante, présence, partie en cours.', fields: 'connId, instance, user, presence { total, users[] }, activeGame|null, heartbeatMs', example: { connId: 'c-91fa', instance: 'game-2', user: { id: userInfo.id, name: userInfo.name }, presence: { total: 1, users: [userInfo] }, activeGame: null, heartbeatMs: 5000 } },
  'sys.pong': { desc: 'Réponse au battement.', fields: 'clientTs, instance', example: { clientTs: 1793620000000, instance: 'game-2' } },
  'sys.ack': { desc: 'Commande appliquée. `duplicate: true` si cet `id` avait déjà été traité (renvoi idempotent).', fields: 'ref, duplicate', example: { ref: '0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001', duplicate: false } },
  'sys.error': { desc: 'Commande rejetée. Codes : BAD_JSON, BINARY_REFUSED, TOO_LARGE, INVALID_MESSAGE, UNKNOWN_TYPE, RATE_LIMITED, FORBIDDEN, NOT_FOUND, WRONG_PHASE, NOT_YOUR_TURN, ALREADY_FIRED, ALREADY_READY, INVALID_FLEET, CONFLICT, INTERNAL.', fields: 'ref|null, code, message', example: { ref: null, code: 'INVALID_MESSAGE', message: 'payload/x doit être <= 9' } },
  'sys.shutdown': { desc: 'L\'instance s\'arrête proprement : le client se reconnecte.', fields: 'reconnectInMs', example: { reconnectInMs: 250 } },
  'presence.delta': { desc: 'Changements de présence, regroupés sur une fenêtre configurable.', fields: 'joined[], left[], changed[], total', example: { joined: [userInfo], left: ['4b3a7a10-5b2f-4f0e-8a65-3f6d1e0c2a77'], changed: [], total: 12 } },
  'match.queued': { desc: 'Attente d\'un adversaire.', fields: '(vide)', example: {} },
  'match.cancelled': { desc: 'Sortie de file confirmée.', fields: '(vide)', example: {} },
  'room.created': { desc: 'Code du salon privé.', fields: 'code, expiresInMs', example: { code: 'K7TQ2M', expiresInMs: 600000 } },
  'room.invited': { desc: 'Invitation reçue d\'un joueur connecté.', fields: 'code, from', example: { code: 'K7TQ2M', from: { id: userInfo.id, name: userInfo.name } } },
  'match.found': { desc: 'Partie créée, à rattacher par `game.resume`.', fields: 'gameId, you, opponent', example: { gameId: G, you: 'p1', opponent: { id: '4b3a7a10-5b2f-4f0e-8a65-3f6d1e0c2a77', name: 'Surcouf' } } },
  'game.snapshot': { desc: 'État complet vu par CE joueur ; ne contient jamais la position d\'un navire adverse à flot.', fields: 'gameId, seq, phase, you, turn, deadline, winner, reason, me, foe', example: { gameId: G, seq: 14, phase: 'battle', you: 'p1', turn: 'p2', deadline: 1793620045000, winner: null, reason: null, me: { name: 'Amiral_Nemo', ready: true, fleet: fleetEx, shots: [] }, foe: { name: 'Surcouf', ready: true, shots: [], sunk: [], fleet: null } } },
};

/** Journal de partie : `gameId` et `seq` strictement croissant. Enveloppe : { id, type, ts, gameId, seq, payload }. */
export const GAME_EVENTS = {
  'game.player_ready': { desc: 'Un joueur a déployé sa flotte (`auto` : placement aléatoire après expiration).', fields: 'player, auto?', example: { player: 'p2' } },
  'game.battle_started': { desc: 'Les deux flottes sont prêtes.', fields: 'firstTurn, deadline', example: { firstTurn: 'p1', deadline: 1793620045000 } },
  'game.shot': { desc: 'Résultat d\'un tir ; `ship` n\'est renseigné qu\'au naufrage. Touché ou coulé : `nextTurn` reste le tireur ; à l\'eau : le tour passe.', fields: 'by, x, y, result (miss|hit|sunk), ship|null, nextTurn|null, deadline|null, clientTs|null', example: { by: 'p1', x: 3, y: 7, result: 'sunk', ship: { type: 'destroyer', x: 3, y: 6, dir: 'v' }, nextTurn: 'p1', deadline: 1793620045000, clientTs: 1793620000000 } },
  'game.turn_skipped': { desc: 'Délai de tour dépassé.', fields: 'player, timeouts, nextTurn, deadline', example: { player: 'p1', timeouts: 1, nextTurn: 'p2', deadline: 1793620090000 } },
  'game.player_connection': { desc: 'Un joueur perd ou retrouve la liaison.', fields: 'player, online', example: { player: 'p2', online: false } },
  'game.finished': { desc: 'Fin de partie : `reason` vaut fleet_destroyed, forfeit ou timeout ; les flottes sont révélées.', fields: 'winner, reason, fleets { p1[], p2[] }', example: { winner: 'p1', reason: 'fleet_destroyed', fleets: { p1: fleetEx, p2: fleetEx } } },
  'game.rematch_offered': { desc: 'Un joueur propose une revanche.', fields: 'by', example: { by: 'p2' } },
  'chat.message': { desc: 'Message de partie : journalisé, donc rattrapé après une coupure.', fields: 'player, name, text', example: { player: 'p1', name: 'Amiral_Nemo', text: 'Touché, bien joué !' } },
};

export const LIMITS = Object.freeze({ MAX_MESSAGE_BYTES: 4096, MAX_FRAME_BYTES: 65536 });
