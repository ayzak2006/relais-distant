# Fiche App Store : Relais Distant

Textes prêts à copier dans App Store Connect (iPhone et iPad). Les limites de caractères d'Apple sont respectées.

## Informations de l'app

| Champ | Valeur |
|---|---|
| Nom (30 max) | `Relais Distant` |
| Sous-titre (30 max) | `Contrôle ton Mac à distance` |
| Identifiant de bundle | `com.relaisdistant.client` |
| SKU | `relais-distant-ios` |
| Catégorie principale | Utilitaires |
| Catégorie secondaire | Productivité |
| Prix | Gratuit |
| Classification | 4+ (aucun contenu sensible) |
| URL d'assistance | `https://github.com/ayzak2006/relais-distant` |
| URL marketing | `https://github.com/ayzak2006/relais-distant` |
| Politique de confidentialité | `https://relais-distant.relais-distant-worker.workers.dev/confidentialite` |
| Copyright | `2026 Aymen Derbali` |

## Texte promotionnel (170 max)

```
Prends le contrôle de ton Mac depuis ton iPhone ou ton iPad, d'une seule touche. Libre, gratuit, sans publicité, et sans code compliqué à retenir.
```

## Mots-clés (100 max, séparés par des virgules)

```
bureau à distance,contrôle,mac,remote,desktop,vnc,teamviewer,anydesk,rustdesk,écran,accès,souris
```

## Description

```
Relais Distant transforme ton iPhone et ton iPad en télécommande pour ton Mac.

UN COMPTE, TOUS TES APPAREILS
Connecte tes appareils une fois : ton Mac apparaît dans « Mes appareils ». Touche-le, son écran s'affiche, tu en prends le contrôle.

PAS DE CODE À RETENIR
Pour connecter un nouvel appareil, saisis un code à usage unique de 6 caractères ou scanne un QR code. Plus d'identifiants à 9 chiffres à recopier.

CHEZ UN AMI, RIEN À INSTALLER
Ouvre la version web sur son ordinateur et scanne le code avec ton iPhone : tu retrouves tes appareils pendant 12 heures au plus, et l'accès s'efface à la fermeture.

PENSÉ POUR LE TACTILE
• L'écran devient un trackpad : glisser pour déplacer, toucher pour cliquer
• Deux doigts pour le clic droit et le défilement
• Pincer pour zoomer, la vue suit le curseur
• Clavier, presse-papiers, Spotlight et changement d'app en un geste

RAPIDE ET PRIVÉ
• Image fluide, encodée par la puce vidéo du Mac
• L'écran, le clavier et la souris passent en direct entre tes appareils, chiffrés
• Aucune publicité, aucun traqueur, aucune adresse e-mail demandée

CONNEXION PERMANENTE OU TEMPORAIRE
Choisis à chaque appareil : permanente pour les tiens, temporaire pour un appareil partagé.

LIBRE ET OPEN SOURCE
Le code est public (licence MIT). Tu peux même héberger ton propre relais.

À installer sur le Mac : l'app gratuite Relais Distant Agent, disponible sur la page du projet. L'iPhone et l'iPad servent à contrôler : Apple ne permet pas à une app de les rendre contrôlables.
```

## Nouveautés de la version 0.1.0

```
Première version : Mes appareils, connexion par code à usage unique ou QR code, connexions permanentes et temporaires, gestes tactiles, zoom.
```

## Confidentialité (questionnaire « App Privacy »)

| Question | Réponse |
|---|---|
| Collecte de données ? | Oui, limitée |
| Identifiants | **Identifiant utilisateur** (nom d'utilisateur) : fonctionnement de l'app, lié à l'utilisateur, pas de suivi |
| Autres données | **Autres données** (nom et type des appareils) : fonctionnement de l'app, lié à l'utilisateur, pas de suivi |
| Suivi (tracking) | Non |
| Publicité, analyse | Non |

Ni l'écran, ni le clavier, ni la souris ne passent par les serveurs : ils circulent en direct entre les appareils.

## Notes pour la validation par Apple (App Review)

```
Relais Distant est un client de bureau à distance. Pour le tester, il faut un Mac équipé de l'agent gratuit Relais Distant Agent (open source : https://github.com/ayzak2006/relais-distant).

Compte de démonstration :
- Nom d'utilisateur : <à renseigner>
- Mot de passe : <à renseigner>
Un Mac de démonstration restera connecté à ce compte pendant la période de validation ; il apparaît dans « Mes appareils ».

Étapes : ouvrir l'app, choisir « Connexion permanente », puis « Utiliser mon identifiant » et saisir le compte ci-dessus. Toucher le Mac dans « Mes appareils » pour afficher son écran et le contrôler.

L'appareil photo sert uniquement à scanner les QR codes de connexion. Aucune donnée n'est vendue ni partagée.
```

> Avant d'envoyer l'app à la validation : crée un compte de démonstration, laisse un Mac allumé avec l'agent connecté à ce compte, et renseigne-le ci-dessus. Sans appareil à contrôler, Apple risque de refuser l'app.

## Captures d'écran à fournir

| Appareil | Taille | Écrans conseillés |
|---|---|---|
| iPhone 6,9 pouces | 1320 × 2868 | Mes appareils, session sur le Mac, connexion par code, choix permanente ou temporaire |
| iPad 13 pouces | 2064 × 2752 | Mes appareils, session sur le Mac en plein écran |
