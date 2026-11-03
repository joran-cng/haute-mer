# Haute Mer — bataille navale multijoueur en temps réel

Projet fil rouge du module Web temps réel : un jeu de bataille navale à deux joueurs, dans une scène 3D, où chaque changement d'état est un événement diffusé. Le serveur se déploie en plusieurs instances derrière un répartiteur, relié par un broker.

> **Filière :** le sujet est proposé par le groupe (« vous pouvez proposer le vôtre ») et correspond au cadre AL, *plateforme orientée événements* : chaque tir, chaque changement de phase est un événement ordonné et diffusé. Il reprend aussi les notions IW de salons et de présence.

## Lancement

Prérequis : Docker Desktop (ou Docker Engine + Compose v2). Rien d'autre.

```bash
docker compose up
```

Le premier démarrage construit les images (2 à 4 minutes). Ensuite :

| Service | Adresse |
|---|---|
| Jeu | <http://localhost:8088> |
| Jeu en TLS (certificat auto-signé) | <https://localhost:8443> |
| Tableau de bord Grafana | <http://localhost:3001> |
| Prometheus | <http://localhost:9090> |

Pour jouer seul sur un poste, ouvrez deux onglets : chaque onglet est un joueur distinct.

**Port déjà pris ?** `HTTP_PORT=9000 docker compose up`, en ajoutant cette origine à `ALLOWED_ORIGINS`.

**À distance, via ngrok :** `node scripts/partage-ngrok.mjs` ouvre un tunnel ngrok (v3.28 ou plus, authentifié), ajoute son adresse publique à `ALLOWED_ORIGINS` et lance la pile. Envoyez le lien affiché à votre adversaire. Si la commande `ngrok` n'est pas la bonne, indiquez le binaire avec `NGROK_BIN`. Pour garder la même adresse d'une session à l'autre, réservez un domaine et passez-le avec `NGROK_DOMAIN`.

**Sur le réseau local :** copiez `.env.example` vers `.env` et ajoutez `http://<ip-du-poste>:8088` à `ALLOWED_ORIGINS`. Une origine absente de la liste est refusée, c'est le comportement voulu.

## Sujet, utilisateurs, scénario

**Sujet.** Deux commandants s'affrontent sur une grille de 10 × 10. Chacun déploie cinq navires, puis ils tirent à tour de rôle jusqu'à ce qu'une flotte soit coulée.

**Utilisateurs.** Des joueurs occasionnels qui veulent lancer une partie en quelques secondes, sans compte, avec un adversaire aléatoire ou un proche via un code.

**Scénario principal**

1. Le joueur saisit son indicatif et voit qui est connecté.
2. Il cherche un adversaire, ou crée un salon dont il transmet le code.
3. Les deux joueurs déploient leur flotte sur la grille.
4. Ils tirent à tour de rôle : chaque tir apparaît chez l'adversaire en quelques millisecondes.
5. La dernière flotte coulée termine la partie ; ils peuvent demander une revanche.

## Documentation

| Document | Contenu |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Schéma, composants, flux et technique de chaque flux |
| [`docs/decisions.md`](docs/decisions.md) | Tableau de décision |
| [`docs/contrat-messages.md`](docs/contrat-messages.md) | Contrat de messages (généré depuis le code) |
| [`docs/garanties.md`](docs/garanties.md) | Sécurité, reconnexion, présence, garanties de livraison |
| [`docs/mesures.md`](docs/mesures.md) | Protocole de mesure, résultats, optimisation |
| [`docs/dossier/dossier-technique.pdf`](docs/dossier/dossier-technique.pdf) | Dossier technique |
| [`docs/soutenance.md`](docs/soutenance.md) | Trame de la soutenance et tableau comparatif |
| [`USAGE-IA.md`](USAGE-IA.md) | Journal d'usage de l'IA |
| [`CHECKLIST.md`](CHECKLIST.md) | Suivi de chaque consigne de la fiche, avec sa preuve |

## Tests

```bash
# Règles, validation, consommateur idempotent (Node 22)
cd server && npm ci && npm test

# Critères observables des phases 2 à 4 sur la pile réelle
docker compose up -d
cd tests/e2e && npm ci && node verify.mjs

# Scénario de charge et relevé des métriques
node load/run.mjs apres 500
```

`verify.mjs` pilote Google Chrome : il doit être installé sur le poste.

## Structure

```
client/   Scène Three.js, interface, client WebSocket (build Vite, servi par nginx)
server/   Instance de jeu Node.js : WebSocket, commandes, présence, métriques
shared/   Règles du jeu, contrat de messages, consommateur idempotent
infra/    Configuration nginx, Prometheus, Grafana
load/     Scénario k6, pilote de mesure, résultats
tests/    Vérifications de bout en bout
docs/     Dossier et documents de conception
```
