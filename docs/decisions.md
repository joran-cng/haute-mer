# Tableau de décision

Chaque choix majeur compare au moins deux alternatives. La colonne « Critère décisif » est ce qui a tranché pour ce projet, pas une vérité générale.

| Décision | Retenu | Alternative 1 | Alternative 2 | Critère décisif |
|---|---|---|---|---|
| Technique temps réel | **WebSocket** | SSE + POST : simple, reprise native par `Last-Event-ID`, mais deux canaux pour un jeu où chaque joueur émet autant qu'il reçoit | Interrogation périodique : latence égale à la période, charge inutile entre deux tirs | Trafic bidirectionnel fréquent sur un seul canal authentifié |
| Bibliothèque WebSocket | **`ws`** | Socket.IO : salles, reprise et adaptateur Redis prêts à l'emploi, mais protocole propre qui masque ce que le module doit démontrer | uWebSockets.js : plus rapide, mais module natif et API moins standard | Contrat de messages visible tel quel dans l'onglet Réseau, garanties écrites et testées par nos soins |
| Broker | **Redis (Pub/Sub + Streams)** | NATS JetStream : très bon pub/sub et persistance, mais il faudrait en plus un stockage d'état | Kafka : journal partitionné et débit élevé, exploitation lourde pour une machine à 8 Go de RAM | Un seul composant couvre diffusion, journal de reprise, état et présence ; script Lua atomique |
| Garantie de livraison | **Au moins une fois, avec dédoublonnage par `seq`** | Au plus une fois (Pub/Sub seul) : un tir perdu désynchronise la partie | « Exactement une fois » de bout en bout : irréaliste entre un navigateur et un serveur ; on l'approche par idempotence | Perdre un tir est inacceptable, recevoir un doublon est gérable côté client |
| Concurrence entre instances | **Compare-and-set sur `seq` (script Lua)** | Verrou distribué : attente, expiration et risque de double détenteur | Affinité partie → instance : routage complexe, panne plus difficile à absorber | N'importe quelle instance sert n'importe quel joueur, sans verrou |
| Répartition de charge | **nginx `least_conn`, sans session collante** | HAProxy : excellent, mais nginx sert aussi le statique et termine TLS | Round-robin avec sessions collantes : inutile, l'état vit dans Redis, et déséquilibré après une panne | Un seul composant ; `least_conn` rééquilibre les connexions longues |
| Authentification | **JWT invité (HS256) dans `Sec-WebSocket-Protocol`** | Jeton en paramètre d'URL : fuite dans les journaux et l'historique | Premier message d'authentification : la connexion est ouverte avant d'être vérifiée | Refus par HTTP 401 avant toute allocation, sans jeton dans les URL |
| Validation des messages | **JSON Schema + Ajv** | zod : très lisible, mais un schéma TypeScript-first que le client n'exploite pas ici | Validation manuelle : oublis probables, couverture invérifiable | Le schéma sert à la fois de validation et de source du contrat |
| Format de sérialisation | **JSON** | MessagePack : charge utile plus petite, mais trames illisibles dans l'onglet Réseau | Protobuf : gain supérieur, génération de code et schémas à maintenir | Le critère phase 2 impose de lire les messages ; le coût mesuré de JSON ne limite pas le débit |
| Rendu | **Three.js (WebGL)** | Canvas 2D : léger, mais l'objectif de réalisme n'est pas atteignable | Babylon.js : moteur plus complet, bundle plus lourd pour des besoins couverts par Three.js | Ombrage sur mesure de l'océan avec un bundle de 160 Ko gzippés |
| Pile serveur | **Node.js 22** | Go : meilleur usage multicœur, moins de partage de code avec le client | Elixir/Phoenix : modèle de présence excellent, compétence absente du groupe | Règles du jeu partagées entre client et serveur (`shared/`) |
| Outil de charge | **k6** | Artillery : scénarios YAML, mais logique de partie à deux joueurs plus pénible à exprimer | Script `ws` maison : flexible, mais métriques et paliers à refaire | Scénario scriptable en JS, image Docker, histogrammes par palier |
| Observabilité | **Prometheus + Grafana** | Fichiers de journaux seuls : pas d'histogramme ni d'agrégation par instance | Pile hébergée : payante ou externe, contraire au socle | Standard de fait, provisionné dans Compose |
| Optimisation mesurée | **Regroupement de la présence** | Compression `permessage-deflate` : coûte de la mémoire par connexion et du CPU | Format binaire : réduit des octets alors que le coût vient du nombre d'envois | Diffuser chaque arrivée à N clients est quadratique pendant une montée en charge |

## Données simulées

Aucune API payante ni donnée externe. Les seuls acteurs simulés sont les joueurs virtuels du test de charge (`load/scenario.js`), indiqués comme tels dans le dossier.
