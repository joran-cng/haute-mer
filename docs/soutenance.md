# Soutenance : trame et tableau comparatif

12 minutes : 7 de présentation et de démonstration, puis 5 de questions. Signal à 6 min, coupure à 7 min. **Chaque membre prend la parole.** 

## Ligne du groupe dans le tableau comparatif (annexe C)

| Technique | Broker | Instances | Outil de charge | Connexions avant dégradation | p50 / p95 | Débit | Optimisation et gain |
|---|---|---|---|---|---|---|---|
| WebSocket (`ws`, Node 22), JWT dans le sous-protocole | Redis 7.4 : Pub/Sub, Streams et script Lua | 2, derrière nginx `least_conn`, sans session collante | k6 0.54 | Plus de 1 000 (aucune dégradation au palier le plus haut) ; 600 à 800 sans l'optimisation | 1 ms / 6 ms à 1 000 connexions | 498 tirs/s, 3 738 msg WebSocket/s à 1 000 connexions | Regroupement de la présence (500 ms) : −79 % de messages, −40 % de CPU, p95 de 29 à 6 ms à 1 000 connexions |

Détail et méthode : [`mesures.md`](mesures.md).

## Déroulé (7 min)

| Temps | Contenu | Support | Orateur |
|---|---|---|---|
| 0:00 – 0:40 | Sujet, utilisateurs, scénario en 5 étapes. Rattachement au cadre AL : chaque tir est un événement ordonné et diffusé | README | Joran |
| 0:40 – 2:40 | **Démonstration** : deux navigateurs, connexion, appariement, placement, tirs visibles chez l'autre en moins d'une seconde. L’instance de chaque joueur est affichée dans l’interface (« Station game-1 ») | Jeu en direct, vidéo de secours en cas d'échec | Lucas |
| 2:40 – 3:20 | **Robustesse en direct** : `docker compose stop game-1`, le joueur concerné bascule sur `game-2` en 2 s environ et la partie continue | Terminal et jeu | Lucas |
| 3:20 – 5:00 | **Architecture et choix** : schéma, chemin d'un tir (instance → Lua CAS → Stream + Pub/Sub → autre instance), garantie « au moins une fois » et dédoublonnage par `seq`, sécurité à la poignée de main (401, 403) | `architecture.svg`, tableau de décision | Youenn |
| 5:00 – 6:30 | **Mesures, présentées honnêtement** : protocole, seuil entre 600 et 800 connexions sans l'optimisation, aucune dégradation jusqu'à 1 000 avec. Gain de 79 % sur les messages et de 40 % sur le CPU. Limites : k6 sur la même machine, un seul passage | Grafana, tableaux de `mesures.md` | Joran |
| 6:30 – 7:00 | Limites et pistes, usage de l'IA en une phrase | Dossier, section 9 | Joran |

Joran ouvre et ferme la présentation et présente les mesures ; Lucas fait la démonstration et la robustesse ; Youenn présente l'architecture.

### Préparation de la démonstration

```bash
docker compose up -d        # 2 à 4 minutes la première fois
# Navigateur A : http://localhost:8088    Navigateur B : http://127.0.0.1:8088 (ou une fenêtre privée)
# Grafana ouvert à côté : http://localhost:3001
```

Ouvrir les deux joueurs dans deux origines différentes, ou dans une fenêtre normale et une fenêtre privée : chacun a ainsi sa propre session. Lancer la partie avant le passage pour ne pas attendre la construction des images. Garder la vidéo de secours ouverte dans un onglet.

## Questions probables et éléments de réponse

| Question | Réponse courte | Où le montrer |
|---|---|---|
| Pourquoi WebSocket plutôt que SSE ? | Chaque joueur émet autant qu'il reçoit : un seul canal bidirectionnel authentifié une seule fois | `decisions.md` |
| Que se passe-t-il si un message est perdu entre Redis et une instance ? | Pub/Sub est « au plus une fois » ; le Stream, écrit dans le même script Lua, permet au client de redemander les `seq` manquants. On obtient « au moins une fois » | `garanties.md`, section Livraison |
| Et un doublon ? | Le client ignore tout `seq` déjà appliqué ; une commande renvoyée est reconnue par son `id` | `shared/sequenced-inbox.js` |
| Deux instances écrivent la même partie en même temps ? | Compare-and-set sur `seq` dans un script Lua atomique, jusqu'à 8 tentatives | `server/src/store.js` |
| Comment est mesurée la latence ? | `clientTs` à l'envoi du tir, relevé à la réception chez l'adversaire, même processus k6 donc même horloge | `mesures.md`, section 1 |
| Pourquoi la latence « avant » remonte-t-elle à 800 connexions ? | Chaque variation de présence part vers les N sockets : un coût en N² qui bloque la boucle d'événements | `mesures.md`, section 5 |
| Redis tombe ? | Point unique de défaillance assumé ; les instances attendent son retour, l'AOF peut perdre une seconde | `garanties.md`, Hors périmètre |
| Qu'a fait l'IA, que vous avez vérifié ? | Voir le journal ; exemples de corrections : mesure de 12,3 s fausse (2,2 s en réalité), `setOffline` inopérant sur une WebSocket | `USAGE-IA.md` |

## Avant le jour 4

- [ ] Relecture croisée du dossier par un autre groupe (grille C), avant la fin de J3
- [ ] Vidéo de secours déposée avant la fin de J3
- [ ] Répétition chronométrée sous 7 min, partage d'écran testé
- [ ] Chaque membre sait expliquer le chemin d'un tir et le gain de l'optimisation
