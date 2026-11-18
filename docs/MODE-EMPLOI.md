# Mode d'emploi de Relais Distant

Relais Distant te permet de contrôler ton Mac depuis ton iPhone, ton iPad, un PC, ou l'ordinateur d'un ami. Ce guide explique tout, de l'installation à l'utilisation quotidienne.

## Sommaire

1. [Le principe](#1-le-principe)
2. [Préparer ton Mac](#2-préparer-ton-mac)
3. [Connecter tes autres appareils](#3-connecter-tes-autres-appareils)
4. [Contrôler ton Mac](#4-contrôler-ton-mac)
5. [Chez un ami](#5-chez-un-ami)
6. [Ton compte](#6-ton-compte)
7. [Problèmes fréquents](#7-problèmes-fréquents)

---

## 1. Le principe

- **Un compte** (nom d'utilisateur et mot de passe) relie tous tes appareils.
- **Mes appareils** affiche les appareils que tu peux contrôler. Aujourd'hui, ce sont tes Mac équipés de Relais Distant Agent.
- **Tous les appareils peuvent contrôler** : iPhone, iPad, Mac, PC Windows, PC Linux, Android, ou un simple navigateur.
- **Deux types de connexion** :
  - **Permanente** : pour tes appareils. Ils restent connectés à ton compte.
  - **Temporaire** : pour l'appareil d'un ami ou un ordinateur partagé. L'accès dure 12 heures au plus et s'efface à la fermeture.

## 2. Préparer ton Mac

C'est le Mac que tu veux pouvoir contrôler.

1. Télécharge **Relais Distant Agent** et **Relais Distant** depuis la page [Téléchargements](https://github.com/ayzak2006/relais-distant/releases/latest).
2. Glisse les deux apps dans le dossier **Applications**.
3. Ouvre **Relais Distant Agent**. Une icône d'écran apparaît dans la barre des menus, en haut à droite.
4. macOS demande deux autorisations. Accepte-les toutes les deux :
   - **Enregistrement de l'écran** : pour transmettre l'image ;
   - **Accessibilité** : pour la souris et le clavier.

   Si les fenêtres de demande n'apparaissent pas, ouvre Réglages Système, puis Confidentialité et sécurité, et active Relais Distant Agent dans ces deux rubriques.
5. **Quitte l'agent et rouvre-le** : macOS ne prend les autorisations en compte qu'après ce redémarrage.
6. Ouvre l'app **Relais Distant**, choisis **Connexion permanente**, puis **Utiliser mon identifiant**, puis **Créer un compte**.
7. C'est tout : l'agent se connecte automatiquement au même compte. Dans son menu, tu lis « En ligne ».

Pour que le Mac reste joignable, active **Lancer à l'ouverture de session** dans le menu de l'agent. L'agent empêche aussi la mise en veille du Mac pendant qu'il tourne (l'écran, lui, peut s'éteindre).

> Si une version publiée refuse de s'ouvrir (« développeur non identifié »), fais un clic droit sur l'app, puis **Ouvrir**.

## 3. Connecter tes autres appareils

Sur ton iPhone, ton iPad, ton PC ou ta tablette :

1. Installe et ouvre **Relais Distant**.
2. Choisis **Connexion permanente**.
3. Connecte-toi, de l'une de ces deux façons :
   - **Avec un code** : l'appareil affiche un code de 6 caractères, par exemple `K7P 4QX`. Sur un appareil déjà connecté, ouvre **Connecter un appareil** et saisis ce code. Sur un téléphone, tu peux aussi scanner le QR code ;
   - **Avec ton identifiant** : nom d'utilisateur et mot de passe.

Le code ne sert qu'une fois et change toutes les 10 minutes.

## 4. Contrôler ton Mac

1. Ouvre **Relais Distant**. Ton Mac apparaît dans **Mes appareils**, avec la mention **En ligne**.
2. Touche-le : l'écran du Mac s'affiche.

### Sur ordinateur

- La souris et le clavier fonctionnent directement.
- Approche la souris du haut de l'écran pour afficher la **barre d'outils**.

### Sur iPhone et iPad, l'écran devient un trackpad

| Geste | Action |
|---|---|
| Glisser un doigt | Déplacer le curseur |
| Toucher | Clic |
| Toucher deux fois | Double-clic |
| Toucher, maintenir, puis glisser | Glisser-déposer |
| Toucher avec deux doigts | Clic droit |
| Glisser avec deux doigts | Faire défiler |
| Pincer | Zoomer (la vue suit le curseur) |

La poignée en haut de l'écran ouvre la barre d'outils.

### La barre d'outils

| Bouton | Rôle |
|---|---|
| ⌘ | **Ctrl → ⌘** : la touche Ctrl d'un PC devient la touche Cmd du Mac (activé par défaut depuis Windows) |
| Clavier | Ouvre le clavier sur iPhone et iPad |
| Presse-papiers | Tape sur le Mac le texte copié sur ton appareil |
| Loupe | Spotlight (⌘ Espace) |
| Fenêtre | Changer d'app (⌘ Tab) |
| Flèches | Plein écran |
| Sortie (rouge) | Se déconnecter |

## 5. Chez un ami

Rien à installer sur son ordinateur.

1. Sur son ordinateur, ouvre **relais-distant.relais-distant-worker.workers.dev**.
2. Laisse **Temporaire** sélectionné.
3. Sur ton iPhone, ouvre Relais Distant, puis **Connecter un appareil**, et saisis le code affiché, ou scanne le QR code. Tu peux aussi le scanner avec l'appareil photo de l'iPhone.
4. Touche **Connecter 12 h** sur ton iPhone. L'ordinateur de ton ami affiche tes appareils.
5. Clique sur ton Mac pour le contrôler.

En partant, clique sur **Se déconnecter**, ou ferme simplement l'onglet. Pour couper l'accès à distance de tous les ordinateurs invités, ouvre ton compte, puis **Déconnecter les ordinateurs invités**.

## 6. Ton compte

Touche la pastille ronde en haut à droite de l'app.

| Action | Rôle |
|---|---|
| **Nom d'utilisateur** | Affiché en clair, si tu l'as oublié |
| **Changer le mot de passe** | Même si tu as oublié l'ancien. Tes appareils restent connectés. Possible seulement depuis une connexion permanente |
| **Déconnecter les ordinateurs invités** | Coupe tous les accès temporaires |
| **Serveur relais** | Pour utiliser ton propre relais |
| **Se déconnecter** | Déconnecte cet appareil |

Pour retirer un appareil de ta liste, touche **⋯** sur sa tuile, puis **Retirer**. Il perd son accès immédiatement.

Ton mot de passe ne peut pas être affiché : il n'est enregistré nulle part en clair. C'est ce qui protège ton compte.

## 7. Problèmes fréquents

**Mon Mac n'apparaît pas dans Mes appareils**
- Vérifie que Relais Distant Agent tourne : icône dans la barre des menus, avec la mention « En ligne ».
- Ouvre l'app Relais Distant sur le Mac, connectée au même compte : elle relie l'agent automatiquement.

**« Autorise Relais Distant Agent à enregistrer l'écran »**
- Ouvre Réglages Système, puis Confidentialité et sécurité, puis Enregistrement de l'écran, et active Relais Distant Agent.
- Quitte l'agent et rouvre-le.
- Si plusieurs lignes « Relais Distant Agent » apparaissent, supprime les anciennes avec le bouton −.

**La souris ou le clavier ne répondent pas**
- Active Relais Distant Agent dans Réglages Système, puis Confidentialité et sécurité, puis **Accessibilité**, et redémarre l'agent.

**« Connexion directe impossible »**
- Certains réseaux d'entreprise ou d'opérateur mobile bloquent les connexions directes. Essaie sur un autre réseau (Wi-Fi ou partage de connexion).

**Le Mac est verrouillé ou en veille**
- macOS empêche de taper le mot de passe de session à distance. Laisse le Mac allumé et déverrouillé, et active « Lancer à l'ouverture de session ».

---

Relais Distant est un logiciel libre d'Aymen Derbali, sous licence MIT. [Code source et signalement de problèmes](https://github.com/ayzak2006/relais-distant).
