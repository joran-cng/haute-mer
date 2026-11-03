# USAGE-IA — Joran Caunègre, Lucas Martin, Youenn — Haute Mer (bataille navale temps réel)

> Ce document rend compte en toute transparence de l'usage des outils d'intelligence artificielle dans le cadre du projet *Haute Mer*. Conformément aux exigences pédagogiques, l'ensemble de l'architecture, de la logique métier et du code source est maîtrisé et explicable à l'oral par chaque membre de l'équipe lors de la soutenance.

## 1. Démarche et outils utilisés

- **Outils :** Claude Code (CLI), modèle Claude Opus 5.5 (`claude-opus-5-5`), sessions de travail du 2 au 4 novembre 2026.
- **Rôle de l'IA :** Assistant de pair-programming, accélérateur de développement et sparring-partner technique. L'IA a été sollicitée pour la génération de code boilerplate, les calculs géométriques et shaders Three.js pour la scène 3D, l'aide à la rédaction de tests unitaires et d'intégration, ainsi que pour explorer des pistes d'optimisation.
- **Rôle du groupe :** Cadrage du sujet, conception de l'architecture temps réel (WebSocket, Redis Pub/Sub, Streams, reprise sur panne), implémentation et adaptation des règles métier (notamment la règle du porte-avions 5 × 2 et le rejeu après touche), configuration de l'infrastructure Docker/nginx, réalisation des campagnes de tests de charge (k6 sur machine réelle) et revue critique systématique de chaque proposition.

## 2. Rôle du groupe et appropriation individuelle

| Responsabilité | Membre | Détail de la réalisation et maîtrise |
|---|---|---|
| **Règles métier, contrat & charge** | **Joran Caunègre** (`joran-cng`) | Conception du moteur de jeu (`shared/game.js`), contrat d'échange JSON-Schema (`shared/protocol.js`), campagnes de montée en charge k6 (`load/`), observabilité Prometheus/Grafana et formalisation des mesures. |
| **Interface, Three.js & reconnexion** | **Lucas Martin** (`Suiidh`) | Scène 3D Three.js (océan, shaders, navires, impacts), interface utilisateur, gestionnaire de liaison WebSocket résiliente, verrouillage d'onglets (Web Locks API) et validation end-to-end Playwright. |
| **Backend temps réel, Redis & Infra** | **Youenn** (`Youpsilon`) | Passerelle WebSocket Node.js (`server/`), atomisme via scripts Lua dans Redis, coordination Pub/Sub et Streams pour la tolérance aux pannes, répartition de charge nginx et sécurité (JWT, origines). |

### Répartition pour la soutenance

Chaque partie du projet est maîtrisée en profondeur et sera soutenue oralement par son responsable :

| Partie du dépôt | Expliquée par | Sujets clés abordés |
|---|---|---|
| Règles du jeu (`shared/game.js`) et contrat de messages | Joran Caunègre | Fonctions pures, validation du placement, porte-avions 5 × 2, rejeu après touche. |
| Serveur WebSocket & sécurité (`server/src/index.js`, `validation.js`) | Youenn | Sous-protocole WebSocket, validation JWT à la poignée de main, protection CORS/Origin. |
| Reconnexion, reprise par `seq`, session (`client/src/net/connection.js`) | Lucas Martin | Backoff exponentiel avec gigue, renvoi des commandes en attente, reprise d'état. |
| Redis : Lua, Pub/Sub, Streams, présence (`server/src/store.js`, `hub.js`) | Youenn | Transaction atomique Lua CAS, persistance AOF, reprise des événements manqués. |
| Haute disponibilité, nginx, bascule d'instance | Youenn | nginx `least_conn`, passage d'une instance à l'autre en direct sans perte d'état. |
| Mesures de charge, Grafana, optimisation présence (`load/`, `metrics.js`) | Joran Caunègre | Profil k6 (1 000 VU), saturation quadratique évitée par regroupement de présence (500 ms). |
| Scène 3D Three.js (`client/src/scene/`) | Lucas Martin | Modélisation procédurale, shaders GLSL de houle et d'écume, rendu 60 fps stable. |

## 3. Journal des itérations

| Date / phase | Besoin technique | Rôle de l'IA | Validation & Contrôle par le groupe | Arbitrage / Correction apportée par le groupe |
|--------------|------------------|--------------|-------------------------------------|----------------------------------------------|
| 02/11 — Ph. 1 | Cadrage du sujet | Brainstorming sur l'adaptation de la bataille navale au cadre AL (plateforme événementielle). | Analyse de la fiche d'évaluation et formalisation de `CHECKLIST.md`. | Choix d'un jeu centré sur les flux temps réel et la tolérance aux pannes plutôt qu'un simple CRUD. |
| 02/11 — Ph. 1 | Contrat d'échange | Proposition de structures JSON pour les commandes et événements. | Écriture des tests du protocole (`server/test/protocol.test.js`). | Génération automatique de `docs/contrat-messages.md` depuis le code source pour éviter toute dérive. |
| 02/11 — Ph. 2 | Règles du jeu | Ébauche des fonctions pures de placement et tir. | Relecture du code, ajout de 9 tests unitaires stricts. | Correction de la gestion des arrivées de tirs hors ordre. |
| 02/11 — Ph. 2 | Déploiement | Écriture du template initial `docker-compose.yml`. | Test de démarrage sur nos machines de développement. | Conflit sur le port 8080 : bascule du port d'exposition sur 8088 configurable par `.env`. |
| 02/11 — Ph. 2 | Rendu 3D Three.js | Écriture des shaders de base pour l'eau et les trajectoires d'obus. | Profiling GPU et inspection visuelle des rendus WebGL. | Correction des coques inversées (winding order), alignement des textures d'écume et correction de la surexposition. |
| 02/11 — Ph. 3 | Sécurité & Auth | Proposition d'authentification par jeton JWT. | Vérification des refus avec `verify.mjs` (401, 403, payload invalide). | Ajout du contrôle strict des origines autorisées (`ALLOWED_ORIGINS`) sur les requêtes WebSocket. |
| 02/11 — Ph. 3 | Coupure réseau | Proposition de test de déconnexion via l'API navigateur. | Audit de la méthode proposée par l'assistant. | Refus de la proposition naïve (`setOffline`) au profit d'un proxy réseau réel simulant un trou noir. |
| 02/11 — Ph. 4 | Concurrence multi-instances | Génération du script Lua atomique pour Redis. | Test de 24 requêtes d'écriture concurrentes sur 2 instances distinctes. | Validation de l'idempotence et du Compare-And-Set sur le numéro de séquence (`seq`). |
| 02/11 — Ph. 4 | Tolérance aux pannes | Chronométrage de la bascule lors de l'arrêt brutal d'une instance. | Analyse des métriques réelles lors de l'arrêt du conteneur. | Détection d'un biais de mesure bloquant de l'IA (12,3 s annoncés) ; temps de bascule réel corrigé à 2,2 s. |
| 03/11 — Partage | Jeu à distance | Script de configuration du tunnel ngrok (`scripts/partage-ngrok.mjs`). | Tests de jeu à distance en conditions réelles avec adversaire distant. | Automatisation de l'injection dynamique de l'URL publique ngrok dans `ALLOWED_ORIGINS`. |
| 03/11 — Ph. 3 | Session persistante | Gestion multi-onglets et survie au rechargement. | Tests sur Chrome en mode privé et fenêtres multiples. | Intégration de la Web Locks API (`navigator.locks`) pour garantir l'indépendance de deux onglets sur la même machine. |
| 03/11 — Règles | Évolution des règles | Adaptation du moteur pour le porte-avions (5 × 2) et le rejeu après touche. | Adaptation des tests, de la validation et des modèles 3D. | Mise à jour complète de `shared/game.js`, des tests et de la scène. |
| 04/11 — Ph. 5 | Mesures de charge | Script d'automatisation de k6 (`load/scenario.js`, `run.mjs`). | Exécution des tests de charge k6 sur notre MacBook Air M2 jusqu'à 1 000 joueurs. | Alignement des fenêtres temporelles de mesure avec l'horloge de k6 pour garantir la fiabilité des percentiles p95. |

## 4. Propositions de l'IA rejetées ou corrigées

L'esprit critique du groupe a permis d'écarter plusieurs solutions inadaptées ou erronées proposées par l'assistant :

| Sujet | Proposition initiale de l'IA | Motif du refus / Correction apportée |
|---|---|---|
| **Simulation de coupure réseau** | Utiliser `context.setOffline(true)` dans Playwright puis fermer la WebSocket manuellement. | **Refusé.** `setOffline` ne coupe pas proprement les WebSockets ouvertes dans Chromium, et forcer la fermeture côté client ne démontre pas la détection de rupture par battement côté serveur. Nous avons implémenté un proxy TCP interceptant les paquets. |
| **Mesure du temps de reprise** | Mesurer le temps de bascule en exécutant `docker compose stop` de manière synchrone dans le chronomètre. | **Refusé.** Le chronomètre incluait le temps de commande Docker de l'hôte (12,3 s affichés). Une mesure asynchrone découplée montre un rétablissement réel de la liaison en 2,2 s. |
| **Délai de purge de présence** | Affirmer que la présence expire en 18 secondes après extinction d'une instance. | **Corrigé.** Calcul incomplet négligeant la gigue et le batching de 500 ms. Après modélisation du pire cas, nous avons rectifié la borne garantie à 20 secondes. |
| **Rendu procédural de l'écume** | Tracé par nuage de points et bruit à haute fréquence. | **Corrigé.** Rendu saccadé et hachuré sur le GPU. Remplacé par une texture générée dynamiquement avec tracé continu et résolution doublée. |

## 5. Bilan

L'usage de l'intelligence artificielle nous a permis d'atteindre un niveau d'exigence technique et graphique élevé dans le temps imparti pour ce projet fil rouge. Loin d'une utilisation passive, nous avons guidé l'assistant étape par étape, corrigé ses approximations et validé chaque flux sur banc d'essai réel. Chaque composant déployé — du script Lua dans Redis au répartiteur nginx et aux shaders WebGL — est compris et assumé par le groupe.
