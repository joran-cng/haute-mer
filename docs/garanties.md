# Sécurité, robustesse et garanties

Les valeurs chiffrées ci-dessous proviennent de `tests/e2e/verify.mjs` joué sur la pile réelle (31 vérifications).

## Sécurité

| Mécanisme | Mise en œuvre | Preuve observée |
|---|---|---|
| Authentification | JWT HS256 vérifié à la poignée de main, algorithme imposé | Sans jeton, jeton forgé `alg: none`, signature altérée : HTTP 401 |
| Origine | Liste blanche `ALLOWED_ORIGINS` vérifiée à la poignée de main | Origine étrangère ou absente : HTTP 403 |
| Validation | Enveloppe et charge validées par JSON Schema, propriétés inconnues interdites | JSON illisible, type inconnu, coordonnée hors grille : `sys.error`, connexion conservée |
| Taille | 4 Ko par message, 64 Ko par trame | Au-delà de 64 Ko : fermeture 1009 de cette seule connexion |
| Débit | Seau à jetons par connexion (20/s, rafale 40), limite nginx sur `/api` | Rafale de 200 messages : 41 servis, 49 refus, fermeture 1008 |
| Autorité serveur | Le serveur applique les règles ; un joueur ne reçoit jamais une position adverse à flot | Test `viewFor` |
| Chiffrement | TLS 1.2+ sur le port 8443, certificat auto-signé généré au démarrage | `https://localhost:8443` et `wss://` |
| Surface | `/metrics` non routé par nginx, CSP stricte, chat inséré par `textContent` | `/metrics` via le répartiteur ne renvoie pas de métrique |

**Limites assumées.** Le certificat est auto-signé : le navigateur affiche un avertissement, un déploiement réel demanderait une autorité reconnue. Le secret JWT a une valeur par défaut pour que `docker compose up` fonctionne sur un poste propre : il doit être remplacé hors démonstration. Les comptes sont des invités sans mot de passe, et aucun mécanisme de révocation de jeton n'existe (durée de vie : 7 jours, réglable par `JWT_TTL_SECONDS`). La limite de débit est par connexion, pas par utilisateur. Le serveur TLS est exposé en HTTP et HTTPS pour la démonstration, sans redirection.

## Reconnexion et reprise

**Stratégie client.** Délai `min(15 s, 0,5 s × 2^tentative)`, dont la moitié est fixe et l'autre aléatoire (gigue égale), remis à zéro après 5 s de connexion stable. Le client envoie `sys.ping` toutes les 5 s ; sans aucun trafic pendant 15 s, il considère la liaison morte, même si le navigateur n'a rien signalé.

**Reprise.** Le client conserve le dernier `seq` appliqué et envoie `game.resume { gameId, lastSeq }`. Le serveur s'abonne au canal **avant** de lire le journal, puis rejoue les événements suivants. Si le journal ne remonte plus assez loin, ou après un rechargement de page, il envoie un instantané complet. Les commandes sans accusé de réception sont renvoyées avec le même `id`.

| Scénario | Résultat mesuré |
|---|---|
| Coupure silencieuse de 10 s (paquets gelés, ni FIN ni RST) | Messages manqués rattrapés 1,1 s après le retour du réseau, aucune perte |
| Coupure de 22 s | Liaison morte détectée seule en 20 s, messages rattrapés ensuite |
| Arrêt propre d'une instance | Client reconnecté sur l'autre en 2,2 s, arrêt Docker compris, partie conservée |

La coupure est produite par `tests/e2e/blackhole-proxy.mjs`, qui gèle le trafic. `context.setOffline()` de Playwright ne convient pas : ce test a montré qu'il laisse vivre une WebSocket déjà ouverte.

## Présence

Une entrée par connexion dans un ZSet dont le score est le dernier signe de vie, et un compteur par utilisateur : un joueur reste présent tant qu'il lui reste un onglet. Ajout et retrait passent par des scripts Lua idempotents, car une fermeture propre et le balayage peuvent se croiser.

| Situation | Délai annoncé | Mesuré |
|---|---|---|
| Onglet fermé | moins d'1 s (fenêtre de regroupement de 500 ms) | 0,5 s |
| Liaison muette | 15 s au plus (deux battements serveur de 5 s) | 7,7 à 9,8 s |
| Instance tuée sans préavis | 20 s au plus (expiration 15 s + balayage 3 s + regroupement) | 16,3 à 17,9 s |

## Livraison

**Garantie annoncée : au moins une fois, par partie, dans l'ordre de `seq`.**

Redis Pub/Sub seul est « au plus une fois » : une instance déconnectée du broker perd ce qui a été publié. La garantie vient de la combinaison du Stream, écrit dans le même script atomique que la publication, et de la reprise par `seq`. Un client qui détecte un trou (attente de 1,5 s) redemande les événements manquants.

| Risque | Traitement | Démonstration |
|---|---|---|
| Événement reçu deux fois | Le client ignore tout `seq` déjà appliqué (`shared/sequenced-inbox.js`) | Doublons publiés à la main sur Redis : ignorés dans le navigateur |
| Événements désordonnés | Tampon, livraison par `seq` croissant | Publication de `seq+2` puis `seq+1` : affichés dans l'ordre |
| Trou persistant | Demande de reprise après 1,5 s | Test unitaire |
| Commande renvoyée | Clé d'idempotence `id`, conservée 10 min | Même `id` deux fois : un seul événement, accusé `duplicate: true` |
| Même commande sur deux instances | Clé vérifiée dans le script atomique | Un seul événement |
| Écritures simultanées | Compare-and-set sur `seq`, jusqu'à 8 tentatives | 24 messages concurrents sur deux instances : `seq` sans trou |

**Hors périmètre.** L'ordre n'est garanti que par partie, pas entre parties. Les variations de présence ne sont pas rejouées : elles sont au plus une fois, et un instantané complet est fourni à chaque connexion. Redis est un point unique de défaillance : les instances attendent son retour et l'AOF (`everysec`) peut perdre jusqu'à une seconde d'écritures.
