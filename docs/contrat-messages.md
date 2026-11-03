# Contrat de messages

> Fichier généré par `node scripts/gen-contract.mjs` depuis `shared/protocol.js`. Les schémas de ce fichier
> sont ceux que le serveur applique ; le test `server/test/protocol.test.js` valide chaque exemple client, et
> `tests/e2e/verify.mjs` compare les trames réelles d'une partie à ce contrat.

## Transport

| Élément | Valeur |
|---|---|
| Point d'entrée | `ws://hôte:8088/ws` ou `wss://hôte:8443/ws` |
| Authentification | jeton JWT obtenu par `POST /api/auth/guest` (`{ "name": "Nemo" }`) |
| Sous-protocoles offerts | `bn.v1` et `auth.<jeton>` (l'API WebSocket du navigateur n'autorise pas d'en-tête `Authorization`) |
| Format | une trame texte = un objet JSON ; les trames binaires sont refusées |
| Taille | 4096 octets par message (erreur `TOO_LARGE`), 65536 octets par trame (fermeture 1009) |
| Débit | 20 messages/s, rafale de 40 (`RATE_LIMITED`), fermeture 1008 après 50 dépassements |

## Enveloppes

| Famille | Sens | Forme |
|---|---|---|
| Commande | client → serveur | `{ id, type, payload }` ; `id` est un UUID, clé d'idempotence |
| Message | serveur → client | `{ id, type, ts, payload }` ; `ts` en ms depuis l'époque Unix |
| Événement de partie | serveur → client | `{ id, type, ts, gameId, seq, payload }` ; `seq` croît de 1 par partie |

Les coordonnées vont de 0 à 9 : `x` pour la colonne (A à J), `y` pour la ligne (1 à 10). Les joueurs sont `p1` et `p2`.

## Fermetures de connexion

| Situation | Effet |
|---|---|
| Sans jeton valide | HTTP 401 à la poignée de main |
| Origine hors liste blanche | HTTP 403 à la poignée de main |
| Trame trop grosse | fermeture 1009 |
| Abus de débit | fermeture 1008 |
| Client trop lent | fermeture 1013 |
| Arrêt d'instance | `sys.shutdown`, puis fermeture 1012 |

## Commandes (client → serveur)

### `sys.ping`

Battement applicatif (5 s) : mesure le RTT et prouve que le lien est vivant.

- **Sens :** client → serveur
- **Champs de `payload` :** clientTs

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "sys.ping",
  "payload": {
    "clientTs": 1793620000000
  }
}
```

### `match.queue`

Entrer dans la file d'appariement.

- **Sens :** client → serveur
- **Champs de `payload` :** (vide)

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "match.queue",
  "payload": {}
}
```

### `match.cancel`

Quitter la file.

- **Sens :** client → serveur
- **Champs de `payload` :** (vide)

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "match.cancel",
  "payload": {}
}
```

### `room.create`

Créer un salon privé ; `invite` prévient directement un joueur connecté.

- **Sens :** client → serveur
- **Champs de `payload` :** invite?

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "room.create",
  "payload": {
    "invite": "4b3a7a10-5b2f-4f0e-8a65-3f6d1e0c2a77"
  }
}
```

### `room.join`

Rejoindre un salon par son code.

- **Sens :** client → serveur
- **Champs de `payload` :** code

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "room.join",
  "payload": {
    "code": "K7TQ2M"
  }
}
```

### `game.resume`

Se rattacher à une partie et rejouer les événements après `lastSeq` (0 = instantané complet).

- **Sens :** client → serveur
- **Champs de `payload` :** gameId, lastSeq

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.resume",
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
    "lastSeq": 12
  }
}
```

### `game.place`

Déclarer sa flotte (5 navires).

- **Sens :** client → serveur
- **Champs de `payload` :** gameId, fleet

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.place",
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
    "fleet": [
      {
        "type": "carrier",
        "x": 0,
        "y": 0,
        "dir": "h"
      },
      {
        "type": "battleship",
        "x": 0,
        "y": 2,
        "dir": "h"
      },
      {
        "type": "cruiser",
        "x": 0,
        "y": 4,
        "dir": "v"
      },
      {
        "type": "submarine",
        "x": 5,
        "y": 5,
        "dir": "h"
      },
      {
        "type": "destroyer",
        "x": 9,
        "y": 8,
        "dir": "v"
      }
    ]
  }
}
```

### `game.fire`

Tirer sur une case. `clientTs` sert à mesurer la latence de bout en bout.

- **Sens :** client → serveur
- **Champs de `payload` :** gameId, x, y, clientTs?

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.fire",
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
    "x": 3,
    "y": 7,
    "clientTs": 1793620000000
  }
}
```

### `game.forfeit`

Abandonner.

- **Sens :** client → serveur
- **Champs de `payload` :** gameId

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.forfeit",
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11"
  }
}
```

### `game.rematch`

Proposer ou accepter une revanche.

- **Sens :** client → serveur
- **Champs de `payload` :** gameId

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.rematch",
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11"
  }
}
```

### `chat.send`

Message texte de partie (200 caractères max).

- **Sens :** client → serveur
- **Champs de `payload` :** gameId, text

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "chat.send",
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
    "text": "Touché, bien joué !"
  }
}
```

## Messages (serveur → client)

### `sys.welcome`

Premier message après connexion : identité, instance servante, présence, partie en cours.

- **Sens :** serveur → client
- **Champs de `payload` :** connId, instance, user, presence { total, users[] }, activeGame|null, heartbeatMs

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "sys.welcome",
  "ts": 1793620000123,
  "payload": {
    "connId": "c-91fa",
    "instance": "game-2",
    "user": {
      "id": "d2f1b8a0-8a5e-4c55-9d73-0f6f2c1e4b10",
      "name": "Amiral_Nemo"
    },
    "presence": {
      "total": 1,
      "users": [
        {
          "id": "d2f1b8a0-8a5e-4c55-9d73-0f6f2c1e4b10",
          "name": "Amiral_Nemo",
          "status": "lobby"
        }
      ]
    },
    "activeGame": null,
    "heartbeatMs": 5000
  }
}
```

### `sys.pong`

Réponse au battement.

- **Sens :** serveur → client
- **Champs de `payload` :** clientTs, instance

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "sys.pong",
  "ts": 1793620000123,
  "payload": {
    "clientTs": 1793620000000,
    "instance": "game-2"
  }
}
```

### `sys.ack`

Commande appliquée. `duplicate: true` si cet `id` avait déjà été traité (renvoi idempotent).

- **Sens :** serveur → client
- **Champs de `payload` :** ref, duplicate

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "sys.ack",
  "ts": 1793620000123,
  "payload": {
    "ref": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
    "duplicate": false
  }
}
```

### `sys.error`

Commande rejetée. Codes : BAD_JSON, BINARY_REFUSED, TOO_LARGE, INVALID_MESSAGE, UNKNOWN_TYPE, RATE_LIMITED, FORBIDDEN, NOT_FOUND, WRONG_PHASE, NOT_YOUR_TURN, ALREADY_FIRED, ALREADY_READY, INVALID_FLEET, CONFLICT, INTERNAL.

- **Sens :** serveur → client
- **Champs de `payload` :** ref|null, code, message

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "sys.error",
  "ts": 1793620000123,
  "payload": {
    "ref": null,
    "code": "INVALID_MESSAGE",
    "message": "payload/x doit être <= 9"
  }
}
```

### `sys.shutdown`

L'instance s'arrête proprement : le client se reconnecte.

- **Sens :** serveur → client
- **Champs de `payload` :** reconnectInMs

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "sys.shutdown",
  "ts": 1793620000123,
  "payload": {
    "reconnectInMs": 250
  }
}
```

### `presence.delta`

Changements de présence, regroupés sur une fenêtre configurable.

- **Sens :** serveur → client
- **Champs de `payload` :** joined[], left[], changed[], total

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "presence.delta",
  "ts": 1793620000123,
  "payload": {
    "joined": [
      {
        "id": "d2f1b8a0-8a5e-4c55-9d73-0f6f2c1e4b10",
        "name": "Amiral_Nemo",
        "status": "lobby"
      }
    ],
    "left": [
      "4b3a7a10-5b2f-4f0e-8a65-3f6d1e0c2a77"
    ],
    "changed": [],
    "total": 12
  }
}
```

### `match.queued`

Attente d'un adversaire.

- **Sens :** serveur → client
- **Champs de `payload` :** (vide)

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "match.queued",
  "ts": 1793620000123,
  "payload": {}
}
```

### `match.cancelled`

Sortie de file confirmée.

- **Sens :** serveur → client
- **Champs de `payload` :** (vide)

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "match.cancelled",
  "ts": 1793620000123,
  "payload": {}
}
```

### `room.created`

Code du salon privé.

- **Sens :** serveur → client
- **Champs de `payload` :** code, expiresInMs

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "room.created",
  "ts": 1793620000123,
  "payload": {
    "code": "K7TQ2M",
    "expiresInMs": 600000
  }
}
```

### `room.invited`

Invitation reçue d'un joueur connecté.

- **Sens :** serveur → client
- **Champs de `payload` :** code, from

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "room.invited",
  "ts": 1793620000123,
  "payload": {
    "code": "K7TQ2M",
    "from": {
      "id": "d2f1b8a0-8a5e-4c55-9d73-0f6f2c1e4b10",
      "name": "Amiral_Nemo"
    }
  }
}
```

### `match.found`

Partie créée, à rattacher par `game.resume`.

- **Sens :** serveur → client
- **Champs de `payload` :** gameId, you, opponent

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "match.found",
  "ts": 1793620000123,
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
    "you": "p1",
    "opponent": {
      "id": "4b3a7a10-5b2f-4f0e-8a65-3f6d1e0c2a77",
      "name": "Surcouf"
    }
  }
}
```

### `game.snapshot`

État complet vu par CE joueur ; ne contient jamais la position d'un navire adverse à flot.

- **Sens :** serveur → client
- **Champs de `payload` :** gameId, seq, phase, you, turn, deadline, winner, reason, me, foe

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.snapshot",
  "ts": 1793620000123,
  "payload": {
    "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
    "seq": 14,
    "phase": "battle",
    "you": "p1",
    "turn": "p2",
    "deadline": 1793620045000,
    "winner": null,
    "reason": null,
    "me": {
      "name": "Amiral_Nemo",
      "ready": true,
      "fleet": [
        {
          "type": "carrier",
          "x": 0,
          "y": 0,
          "dir": "h"
        },
        {
          "type": "battleship",
          "x": 0,
          "y": 2,
          "dir": "h"
        },
        {
          "type": "cruiser",
          "x": 0,
          "y": 4,
          "dir": "v"
        },
        {
          "type": "submarine",
          "x": 5,
          "y": 5,
          "dir": "h"
        },
        {
          "type": "destroyer",
          "x": 9,
          "y": 8,
          "dir": "v"
        }
      ],
      "shots": []
    },
    "foe": {
      "name": "Surcouf",
      "ready": true,
      "shots": [],
      "sunk": [],
      "fleet": null
    }
  }
}
```

## Événements de partie (serveur → client, diffusés aux deux joueurs)

### `game.player_ready`

Un joueur a déployé sa flotte (`auto` : placement aléatoire après expiration).

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** player, auto?

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.player_ready",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "player": "p2"
  }
}
```

### `game.battle_started`

Les deux flottes sont prêtes.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** firstTurn, deadline

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.battle_started",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "firstTurn": "p1",
    "deadline": 1793620045000
  }
}
```

### `game.shot`

Résultat d'un tir ; `ship` n'est renseigné qu'au naufrage. Touché ou coulé : `nextTurn` reste le tireur ; à l'eau : le tour passe.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** by, x, y, result (miss|hit|sunk), ship|null, nextTurn|null, deadline|null, clientTs|null

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.shot",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "by": "p1",
    "x": 3,
    "y": 7,
    "result": "sunk",
    "ship": {
      "type": "destroyer",
      "x": 3,
      "y": 6,
      "dir": "v"
    },
    "nextTurn": "p1",
    "deadline": 1793620045000,
    "clientTs": 1793620000000
  }
}
```

### `game.turn_skipped`

Délai de tour dépassé.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** player, timeouts, nextTurn, deadline

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.turn_skipped",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "player": "p1",
    "timeouts": 1,
    "nextTurn": "p2",
    "deadline": 1793620090000
  }
}
```

### `game.player_connection`

Un joueur perd ou retrouve la liaison.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** player, online

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.player_connection",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "player": "p2",
    "online": false
  }
}
```

### `game.finished`

Fin de partie : `reason` vaut fleet_destroyed, forfeit ou timeout ; les flottes sont révélées.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** winner, reason, fleets { p1[], p2[] }

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.finished",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "winner": "p1",
    "reason": "fleet_destroyed",
    "fleets": {
      "p1": [
        {
          "type": "carrier",
          "x": 0,
          "y": 0,
          "dir": "h"
        },
        {
          "type": "battleship",
          "x": 0,
          "y": 2,
          "dir": "h"
        },
        {
          "type": "cruiser",
          "x": 0,
          "y": 4,
          "dir": "v"
        },
        {
          "type": "submarine",
          "x": 5,
          "y": 5,
          "dir": "h"
        },
        {
          "type": "destroyer",
          "x": 9,
          "y": 8,
          "dir": "v"
        }
      ],
      "p2": [
        {
          "type": "carrier",
          "x": 0,
          "y": 0,
          "dir": "h"
        },
        {
          "type": "battleship",
          "x": 0,
          "y": 2,
          "dir": "h"
        },
        {
          "type": "cruiser",
          "x": 0,
          "y": 4,
          "dir": "v"
        },
        {
          "type": "submarine",
          "x": 5,
          "y": 5,
          "dir": "h"
        },
        {
          "type": "destroyer",
          "x": 9,
          "y": 8,
          "dir": "v"
        }
      ]
    }
  }
}
```

### `game.rematch_offered`

Un joueur propose une revanche.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** by

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "game.rematch_offered",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "by": "p2"
  }
}
```

### `chat.message`

Message de partie : journalisé, donc rattrapé après une coupure.

- **Sens :** serveur → client, via Redis Pub/Sub, journalisé dans Redis Streams
- **Champs de `payload` :** player, name, text

```json
{
  "id": "0d9a4f8e-6a11-4d0e-8a51-27e2b4a6f001",
  "type": "chat.message",
  "ts": 1793620000123,
  "gameId": "7f6c1c32-52de-4b56-9b61-3a1f0f6c9d11",
  "seq": 15,
  "payload": {
    "player": "p1",
    "name": "Amiral_Nemo",
    "text": "Touché, bien joué !"
  }
}
```
