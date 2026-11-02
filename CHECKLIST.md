# Suivi des consignes — Fiche projet fil rouge

Légende : `[ ]` à faire · `[x]` fait **et vérifié** (preuve indiquée) · `[H]` action humaine, impossible à faire à la place du groupe.

## Socle commun
- [ ] Connexion persistante (WebSocket) + client navigateur
- [ ] Lancement complet par une seule commande `docker compose up`
- [ ] Dépôt Git (historique lisible)
- [H] Dépôt partagé avec le formateur
- [ ] Stack justifiée dans le tableau de décision
- [ ] Aucune API payante ; simulation éventuelle indiquée

## Phase 1
- [ ] README : sujet, utilisateurs, scénario en 5 étapes max
- [ ] Schéma d'architecture, chaque flux porte sa technique
- [ ] Tableau de décision : ≥ 2 alternatives par choix majeur
- [ ] Contrat de messages : types, champs, sens, exemple JSON
- [ ] Dépôt initialisé
- [H] Pitch de 2 min

## Phase 2
- [ ] Client et serveur conformes au contrat
- [ ] Fichier docker compose
- [ ] Deux navigateurs : action visible dans l'autre < 1 s
- [ ] `docker compose up` sur poste propre
- [ ] Messages observés conformes au contrat

## Phase 3
- [ ] Authentification sur la connexion persistante + vérification d'origine
- [ ] Validation, taille maximale, limitation de débit
- [ ] Reconnexion (délai croissant, plafond, gigue) + reprise
- [ ] Présence : liste des utilisateurs connectés
- [ ] Connexion sans jeton valide refusée
- [ ] Origine hors liste blanche refusée
- [ ] Message malformé / trop gros rejeté sans arrêt du serveur
- [ ] Coupure 10 s : reconnexion seule, messages manqués rattrapés
- [ ] Onglet fermé disparaît de la présence dans un délai annoncé

## Phase 4
- [ ] ≥ 2 instances derrière un répartiteur
- [ ] Broker justifié
- [ ] Garantie de livraison annoncée, traitement des doublons
- [ ] Deux clients sur deux instances échangent (instance visible)
- [ ] Arrêt d'une instance : reconnexion sur l'autre
- [ ] Doublon / désordre démontré

## Phase 5
- [x] Scénario de charge scripté et versionné — `load/scenario.js` (k6), pilote `load/run.mjs`
- [x] Métriques : connexions actives, msg/s, latence (histogramme), erreurs, déconnexions — `server/src/metrics.js`, tableau dans `docs/mesures.md` §2
- [x] Tableau de bord Grafana — `infra/grafana/dashboards/bataille-navale.json`, captures `docs/mesures/*-grafana.png`
- [x] Optimisation mesurée avant/après — regroupement de la présence, passages `avant` (0) et `apres` (500) du 04/11
- [x] Protocole écrit : machine, durée, montée en charge, point d'horodatage — `docs/mesures.md` §1 (modèle du Mac à compléter)
- [x] Résultats : p50, p95, débit, seuil de dégradation — `docs/mesures.md` §4–5 : 600–800 conn. avant, > 1 000 après
- [x] Gain chiffré, même méthode avant/après — −79 % msg/s, −40 % CPU, p95 29 → 6 ms à 1 000 conn.

## Phase 6
- [x] Dossier technique 8–12 pages, plan complet (10 sections) — `docs/dossier/dossier-technique.pdf`, 10 pages, généré par `node scripts/gen-dossier.mjs`
- [ ] Vidéo de démonstration ≤ 3 min — script `tests/e2e/demo-video.mjs` prêt, vidéo pas encore enregistrée
- [x] Ligne du tableau comparatif — `docs/soutenance.md`
- [x] USAGE-IA.md à la racine, format de la fiche — journal à jour au 04/11 ; numéro de groupe à compléter
- [H] Relecture par un autre groupe (grille C) avant fin J3
- [H] Dépôt de la vidéo avant fin J3
- [H] Soutenance en 7 min ; chaque membre prend la parole

## Design (demande explicite)
- [ ] Rendu réaliste vérifié sur captures réelles
