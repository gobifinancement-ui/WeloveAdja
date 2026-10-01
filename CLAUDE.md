# FEJA — Festival Adja

Site d'inscription et de billetterie du **Festival Adja**, à Azovè (Bénin).
Le festival a lieu **chaque 15 août**, au Terrain Omnisports CEG2 Azovè.

Un visiteur achète un ou plusieurs billets, paie par Mobile Money ou carte,
reçoit un billet PDF par e-mail, et le jour J un agent scanne son QR code à
l'entrée en vérifiant sa photo.

---

## Démarrer

```bash
npm start          # http://localhost:3000
npm test           # e-mails (12) et badge (7), sans réseau
```

Aucun framework, aucune étape de build. `node server.js` sert les pages et
l'API. Node 18 ou plus est nécessaire — le serveur appelle FedaPay avec le
`fetch` natif — mais `package.json` ne déclare pas de `engines`.

L'administration est sur `/admin.html`, le poste de scan sur `/scan.html`.

---

## Ce qu'il faut comprendre en premier

**Il n'y a pas de framework, et c'est volontaire.** `server.js` est un serveur
`http` natif de ~4 800 lignes : une suite de `if (url.pathname === …)` dans un
seul gestionnaire. Les pages sont des fichiers HTML autonomes, chacun avec son
`<style>` et son `<script>` en ligne. Rien à compiler, rien à installer sur la
machine de l'organisation le jour de l'événement.

**La base est un fichier SQLite en mémoire**, via `sql.js` (WebAssembly, donc
aucune compilation native). Elle est écrite sur disque à chaque modification
par `persistDatabase()` — fichier temporaire, fsync, puis renommage, pour
qu'une coupure de courant ne laisse jamais un fichier à moitié écrit.
Chemin : `data/weloveadja.sqlite`.

- L'écriture se fait **en arrière-plan et groupée** : `persistDatabase()` rend
  une promesse tenue quand l'état du moment est sur le disque. Dans une route,
  écrire `await persistDatabase()` avant de répondre.
- **Un seul serveur par base** : `data/serveur.lock` (PID + battement toutes
  les 30 s). Un second lancement sur le même dossier refuse de démarrer — deux
  serveurs s'écraseraient les inscriptions. Un verrou laissé par un arrêt
  brutal est repris tout seul.
- Sauvegardes : une par heure (24 gardées) et une par jour (30 gardées) dans
  `data/backups/`, copiées depuis la base en mémoire.
- Les badges PDF sont dessinés par un **pool de threads** (jusqu'à 3).

Tenue en charge mesurée (portable i5, mode démonstration) : 50 personnes qui
s'inscrivent, sont validées et téléchargent leur badge au même instant →
0 échec, 8,5 s pour le dernier ; 100 personnes → 0 échec, 14 s.

**Presque tout est réglable depuis l'admin**, pas dans le code : couleurs,
textes, montant, artistes, fond animé, pays à paiement direct… Ce sont des
lignes de la table `settings`, avec des valeurs par défaut dans
`DEFAULT_SETTINGS` (server.js). Avant d'écrire une constante en dur, regarder
si elle n'a pas sa place là.

---

## Structure

```
server.js               Serveur + API + base + PDF + stats.  Tout le back.
index.html              Accueil, formulaire d'inscription, récupération de billet.
retour-paiement.html    Page d'après paiement : téléchargement des billets.
verification.html       Vérification d'un code d'accès (public).
admin.html              Administration : participants, réglages, stats, apparence.
scan.html               Poste de scan à l'entrée (hors-ligne).
installer.html          Page d'installation de l'app de scan.
sw.js                   Service worker : scan et admin utilisables sans réseau.

js/branding.js          Applique logo et nom d'événement (les couleurs viennent de /api/theme.css).
js/chargement.js        Trois points animés pendant qu'un bouton attend.
js/badge-layout.js      Mise en page du badge — partagée par le PDF (serveur) et l'image (navigateur).
js/ticket-canvas.js     Traduction de cette mise en page en canvas — accueil, page de retour, admin.
lib/ticket-pdf.js       Traduction en pdfkit, exécutée dans un worker (ticket-pdf-worker.js).
fonts/                  Poppins Regular / SemiBold / Bold (licence OFL) — polices du badge.
img/badge/              Emblème du logo de la bande gauche du badge.
js/qr-scanner.js        Scanner QR (BarcodeDetector, repli jsQR).
js/scan-app.js          App de scan : le verdict est rendu localement.
js/scan-store.js        IndexedDB du scan : codes, journal, file d'attente, photos.

lib/mail/index.js       Point d'entrée unique — le reste du projet n'importe que lui.
lib/mail/template.js    Gabarit HTML unique (tableaux + styles en ligne, pour Outlook).
lib/mail/transport.js   SMTP d'abord, Resend en repli.
lib/mail/senders.js     Une classe par type d'e-mail.

test/mail.test.js       Un test par type d'e-mail, transport simulé.
test/badge.test.js      Mise en page, PDF, et lisibilité du QR malgré le sceau.
lib/sentinelle.js       Surveillance : fraude, attaques, incidents coûteux → journal + e-mail.
test/sentinelle.test.js Détection, regroupement, anti-doublon, plafond d'e-mails.
data/                   Base SQLite (non versionné).
uploads/                Photos des participants, QR, images de marque (non versionné).
```

---

## Modèle de données

Six tables (`server.js`, bloc `CREATE TABLE`) :

| Table | Rôle |
|---|---|
| `participants` | **Une ligne par billet**, pas par personne. |
| `settings` | Clé/valeur. Toute la configuration modifiable. |
| `sessions` | Sessions admin et scan (colonne `role`). |
| `ticket_codes` | Codes à 6 chiffres pour récupérer un billet par e-mail. |
| `ticket_sessions` | Jetons de téléchargement délivrés après vérification. |
| `webhook_events` | Événements FedaPay déjà traités (anti-rejeu). |

### Un billet = une ligne

Un achat de cinq billets crée **cinq lignes**, reliées par `groupe_id`, avec
`groupe_index` et `groupe_taille`. Chacune a son nom, sa photo, son
`code_unique` et son QR — c'est ce qui permet de contrôler les entrées une par
une. Le téléphone et l'e-mail de l'acheteur sont recopiés sur chaque ligne :
c'est par son adresse qu'il retrouvera **tous** les billets, y compris ceux des
autres.

`getParticipantsDuGroupe(p)` rend toujours un tableau, même pour les
inscriptions d'avant l'achat groupé (sans `groupe_id`) : elles sont leur propre
groupe d'une ligne, ce qui évite de distinguer les deux cas partout ailleurs.

Ajouter une colonne : l'ajouter à `ensureParticipantColumns()` — les `ALTER
TABLE` y sont joués au démarrage, les bases existantes suivent.

---

## Le parcours d'inscription

Dans `index.html`. Le formulaire est une suite de **volets** (`.pane`), pilotés
par un **parcours** — pas par un numéro d'étape.

```js
const PARCOURS = { solo: [0, 1, 2, 4], groupe: [0, 1, 2, 3, 4] };
```

Les volets gardent un numéro stable, le parcours dit lesquels et dans quel
ordre. `idx` est le rang dans le parcours, pas le numéro du volet.

| Volet | Contenu | Titre affiché |
|---|---|---|
| 0 | Nombre de billets (1 · 2 · 3 · autre, max 10) | « Combien de billets ? » |
| 1 | Le ou les noms | « Tes informations » / « À qui sont les billets ? » |
| 2 | La ou les photos | « Ta photo » / « La photo de chacun » |
| 3 | Téléphone + e-mail — **achat groupé seulement** | « Tes coordonnées » |
| 4 | Récapitulatif et paiement | « Vérifie avant de payer » |

À **un** billet, le bloc téléphone/e-mail vit dans le volet 1 ; à **plusieurs**,
il est **déplacé** (pas dupliqué) dans le volet 3 — deux jeux de champs
finiraient par ne plus dire la même chose.

Les titres suivent le nombre de billets (`majTextesGuides()`), la barre
d'étapes est engendrée (`majEtapes()`), et le bouton payer vit dans une barre
fixe en bas (`#payBar`), posée **hors** de `.reg-shell` — celle-ci porte
`overflow:hidden` et une animation de `transform`, qui déplaceraient un élément
fixe placé à l'intérieur.

---

## Le paiement

Deux chemins, décidés par le **pays choisi avec l'indicatif** :

**Bénin — sans redirection.** Les réseaux (MTN, Moov, Celtiis) deviennent
cliquables sur l'écran de paiement. Le serveur crée la transaction, obtient un
jeton, puis poste sur l'endpoint de l'opérateur : le client reçoit la demande
en USSD sur son téléphone. La page attend et interroge `/api/payments/status`
toutes les 6 s.

**Ailleurs, et carte bancaire — page hébergée FedaPay**, comme avant.

Le serveur **annonce le chemin retenu** (`mode: "direct" | "redirect"`) et la
page suit sa décision, pas son intention. Si la demande directe échoue — nom de
route d'opérateur devenu faux, opérateur muet — la création **retombe d'elle-même
sur la page hébergée**. Personne ne reste bloqué, et l'échec est journalisé.

> ⚠️ Les noms de route dans `OPERATEURS_DIRECTS` (`mtn_open`, `moov`,
> `celtiis_bj`) suivent la convention FedaPay mais **n'ont jamais été vérifiés
> contre une clé de production**. À confirmer par un vrai paiement le jour où
> une clé est disponible.

Les pays servis sans redirection sont le réglage `paiement_direct_pays`.

### Validation

`finalizePaidParticipant()` est le **point de passage unique** de tout paiement
validé — retour de paiement, webhook, mode démonstration. Toute chose à faire
« quand un paiement réussit » va là, pas ailleurs : accrochée à un seul appelant,
elle manquerait les autres chemins.

Elle valide **le groupe entier ou rien**, et vérifie que le montant correspond
au nombre de billets — sans cette multiplication, payer un billet en délivrerait
cinq.

### Mode démonstration

`demo_mode = "1"` court-circuite l'opérateur : le parcours complet se déroule
sans clé FedaPay, les inscriptions sont marquées `paiement = "demonstration"` et
purgeables d'un clic depuis l'admin (`/api/admin/demo`). `js/branding.js` pose
un bandeau rouge sur le site, et l'état de préparation le signale en erreur —
impossible de l'oublier allumé le jour de l'ouverture.

---

## Après paiement

Tout le monde atterrit sur **`retour-paiement.html`** — un achat d'un badge
comme de cinq. Trois temps :

1. **Vérification du paiement** (interrogation de `/api/payments/status`).
2. **Préparation** : silhouette de badge animée, jauge qui suit le vrai
   travail, messages « en cours de préparation… », « Encore un moment… ». Les
   images, aperçus et PDF sont fabriqués ICI, avant d'afficher les boutons
   (durée minimale 3,6 s pour que les messages se lisent).
3. **« Et voilà ! »** : trois gros boutons — image, PDF, WhatsApp. **Aucun code
   d'accès affiché** sur la page (il est sur le badge). À plusieurs badges,
   les boutons agissent sur tous (un seul PDF, une page par badge :
   `/api/public/ticket/pdf?ids=a,b,c`), puis une carte par personne.

WhatsApp passe par le **partage natif** (`navigator.share` avec l'image) : le
fichier doit être prêt AVANT le toucher, sinon Safari refuse d'ouvrir le
partage. Sans partage de fichiers, l'image est téléchargée et `wa.me` s'ouvre.

Le PDF vient du serveur (`renderTicketPdf`), l'image est dessinée dans le
navigateur par `js/ticket-canvas.js`. Les deux appellent **la même fonction
de mise en page** (`js/badge-layout.js`) avec un moteur différent : ils ne
peuvent pas diverger.

### Le badge

Il reproduit la maquette validée par l'organisation (854 × 1280 px, PDF en
4 × 6 pouces). Toutes les cotes, couleurs, tailles et graisses sont dans
`GEOMETRIE` de `js/badge-layout.js`, relevées sur la maquette au demi-pixel :
ne pas les arrondir. Le nom, l'année, l'exposant et les dates en gras sont en
Poppins **SemiBold**, pas Bold (mesuré à l'aire d'encre).

- Textes réglables dans `Admin → Réglages → Badge` (`badge_titre`,
  `badge_annee`, `badge_edition`, `badge_lieu`, `badge_dates` — `**gras**` —,
  `badge_activites` — une ligne par ligne). Vide = texte de la maquette.
- « N° » porte le **code d'accès**, le QR l'encode aussi : version 5, correction
  H, avec le logo du site en sceau au centre. Le navigateur reçoit la matrice
  (`qr_matrice`) du serveur, il n'a pas de générateur QR.
- Nom trop long : il rétrécit, puis passe sur deux lignes.
- **Passage automatique à l'édition suivante** : le lendemain du
  `badge_bascule` (30/08 par défaut, heure du Bénin), année + 1, édition + 1 et
  année remplacée dans les dates (`editionEnCours`, appliqué au dessin et
  enregistré par `appliquerBasculeBadge` toutes les 15 min, avec une alerte
  interne : les jours du festival restent à vérifier à la main).
- Le logo de la bande gauche est l'emblème de `IMG_6010` (mains + FEJA),
  détouré de ses anneaux : la maquette n'a qu'un anneau fin, dessiné en
  vectoriel.

Le serveur délivre un `ticket_token` au moment où il confirme le paiement :
sans lui, l'acheteur devrait redemander un code par e-mail pour un billet qu'il
vient d'acheter.

**Plus tard** : e-mail → code à 6 chiffres → tous ses billets. Un code par
adresse, usage unique, 5 essais maximum, message identique pour tous les échecs
(sinon on apprend quelles adresses existent).

---

## Le jour J — le scan

`scan.html` + `js/scan-app.js` + `js/scan-store.js`.

**Le verdict est rendu localement**, sans attendre le réseau. Les codes sont
téléchargés à l'avance dans IndexedDB ; un scan consomme le code sur place et
part en file d'attente vers le serveur. C'est ce qui garantit qu'un même QR ne
peut pas être accepté deux fois, même sans connexion.

Après un scan ou une saisie manuelle, **la photo de la personne s'affiche** pour
confirmer ou refuser l'entrée. Les photos doivent être **pré-téléchargées en
Wi-Fi avant l'événement** (bouton dans l'app de scan).

> ⚠️ **Sans HTTPS, la caméra et le mode hors-ligne ne marchent pas.**
> `navigator.mediaDevices` et les service workers exigent un contexte sécurisé.
> Sur `http://<ip-locale>:3000` ils sont indisponibles.

---

## Les e-mails

`lib/mail/` — le reste du projet n'importe que `lib/mail/index.js`.

- **Un seul gabarit** (`template.js`), en tableaux avec styles écrits sur chaque
  balise : Outlook rend le HTML avec le moteur de Word (ni flexbox, ni grid, ni
  media queries) et Gmail retire la balise `<style>` sur mobile.
- **Une classe par événement** (`senders.js`) : paiement confirmé, code de
  vérification, paiement échoué, alerte interne, e-mail de test.
- **Acheminement** (`transport.js`) : SMTP d'abord, Resend en repli. Les
  identifiants viennent de l'environnement d'abord, des réglages ensuite.
- L'alerte interne part vers `MAIL_ALERT_TO` → `alert_email` → `vendeur_email`.

Un achat groupé donne **un seul e-mail** portant tous les billets. Cinq messages
pour cinq billets ressembleraient à une erreur d'envoi.

- Mise en page calquée sur le modèle choisi par l'organisation (e-mail
  transactionnel Maketou) : fond gris, carte blanche, **logo FESTIVAL ADJA
  centré** (`img/email/logo-festival-adja.png`, lettres passées en vert foncé
  pour le fond blanc), titre en gras, « ✨ Détails de l'achat : » en lignes
  « Étiquette : valeur », code dans une pastille, bouton centré.
- Le logo est **joint en image intégrée** (cid) à chaque message : il
  s'affiche même avant la mise en ligne du site.
- L'e-mail de confirmation **vouvoie** (« Bingo 🎉 Votre badge est prêt ! »,
  « Kwabô … Vous venez de payer… ») : texte fourni par l'organisation,
  exception assumée au tutoiement du site. Événement, lieu et dates viennent
  des réglages du badge (`textesDepuisReglages`).
- Admin → Réglages → e-mail : « Recevoir un exemple de l'e-mail de
  confirmation » envoie l'e-mail exact, badge PDF d'exemple compris.

`npm test` couvre un type d'e-mail par test, avec un transport simulé.

---

## Configuration

`.env` à la racine (jamais versionné). Variables lues :

```
PORT                     défaut 3000
PUBLIC_BASE_URL          adresse publique — sans elle, le retour de paiement casse
FEDAPAY_SECRET_KEY       sk_… (~33 caractères)
FEDAPAY_ENVIRONMENT      sandbox | live
FEDAPAY_WEBHOOK_SECRET
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_SECURE / SMTP_TLS_STRICT
MAIL_FROM
MAIL_ALERT_TO
RESEND_API_KEY           repli si aucun SMTP
```

L'environnement l'emporte sur les réglages de l'admin. Le mot de passe
administrateur n'est **pas** ici : il est haché (scrypt) dans la table
`settings`.

`Admin → Réglages` affiche un **état de préparation** (`getConfigHealth`) qui
transforme les erreurs de configuration silencieuses en liste de contrôle :
clé absente, adresse publique locale, environnement encore en sandbox.

---

## Sécurité — ce qui est déjà en place

Ne pas défaire sans raison :

- **Chemins privés** (`PRIVATE_PREFIXES`, `PRIVATE_FILES`, `isPrivatePath`) :
  `data/`, `.env`, `lib/`, `test/`… ne sont jamais servis, même par un chemin
  détourné. `resolveFilePath` refuse tout ce qui sort de la racine.
- **Mots de passe** hachés en scrypt, comparaison à temps constant.
- **Jetons** (sessions, billets) stockés hachés en SHA-256.
- **Limitation de débit** par IP et par clé (e-mail, badge, achat) :
  `rateLimit()` / `rateLimitKey()`. Les plafonds **par IP sont larges** : au
  Bénin, les opérateurs mobiles font sortir des centaines de téléphones par la
  même IP. La protection fine est par e-mail (6 inscriptions / 10 min), par
  achat ou par jeton. `getClientIp` ne croit `X-Forwarded-For` que derrière un
  proxy local, et en prend le dernier maillon (le premier est écrit par le
  client et permettait de contourner toutes les limites).
- **Validation d'un paiement en file par achat** (`finalizePaidParticipant`) :
  le webhook et la page de retour arrivent souvent au même instant ; sans file,
  deux codes différents étaient tirés et deux e-mails partaient.
- **Aucune énumération d'adresses** : les échecs de récupération de billet
  rendent tous le même message.
- **Rôles de session** : un poste de scan n'atteint que `SCAN_ALLOWED_PATHS`.
- **Secrets masqués** dans les réponses de réglages (`SECRET_SETTING_KEYS`).
- **En-têtes de sécurité** sur chaque réponse (`applySecurityHeaders`).
- Les identifiants ne sont **jamais** écrits en dur, ni recopiés dans un
  document, ni dans un e-mail.

### Surveillance (`lib/sentinelle.js`)

Repère et signale : robots qui cherchent des failles, rafales de 404 / 429,
flots de requêtes, erreurs serveur et lenteurs en série, erreurs en série dans
le journal (console.error est observé), mots de passe admin faux, connexion
admin depuis une adresse jamais vue, réglages sensibles modifiés (numéros
Mobile Money, clé FedaPay, prix…), mode démonstration activé ou oublié,
badge validé à la main, fraude au paiement (montant faux, transaction
rejouée), fausse notification FedaPay, codes devinés, badge présenté deux fois
à l'entrée, pannes FedaPay, e-mails de badge qui ne partent pas, disque ou
mémoire saturés, base ou sauvegarde en échec.

- **critique** = e-mail immédiat ; **alerte** = e-mail groupé sur 2 min ;
  **info** = journal seul. Anti-doublon 10 / 30 min, plafond 12 e-mails/h.
- Journal : `data/securite.jsonl`, visible dans Admin → Réglages → Sécurité
  (avec un bouton d'alerte de test).
- Destinataire : `MAIL_SECURITE_TO` (.env) → `securite_email` → adresse des
  alertes internes. **Sans SMTP ni Resend, rien ne part** : tout reste au journal.
- Pour signaler un nouvel incident : `sentinelle.signaler({ gravite, type,
  titre, details, ip, cle })`, avec une consigne dans `CONSIGNES`.
- Sous 300 Mo de disque libre, les inscriptions (photos) sont refusées : un
  disque plein bloquerait la base elle-même.

---

## Conventions

**La langue du code est le français.** Noms de fonctions, de variables et
commentaires : `construireNoms`, `majBarrePaiement`, `peindreBillets`,
`billets`, `volet`. Le code plus ancien est en anglais (`showErr`, `paint`,
`validateStep1`) — on ne renomme pas pour renommer, mais le nouveau code suit
le français.

**Les commentaires disent *pourquoi*, jamais *quoi*.** Le code dit déjà ce
qu'il fait. Un commentaire utile explique la contrainte qui a dicté la
décision :

```js
// La barre est posée hors de .reg-shell : celle-ci porte overflow:hidden et
// joue une animation de transform à l'ouverture, ce qui déplacerait un
// élément fixe placé à l'intérieur.
```

**Les messages de commit sont en français**, sans accents (l'encodage de la
console Windows les abîme), et racontent le problème avant la solution.

**Textes affichés : tutoiement**, partout (« Réserve ta place », « ton code
d'accès »). Ne pas mélanger avec le vouvoiement.

**CSS :** propriétés personnalisées pour les couleurs, `color-mix(in oklab, …)`,
`prefers-reduced-motion` respecté, animations à l'entrée en cascade
(`staggerIn`).

---

## Pièges déjà rencontrés

Trois fois de suite, le même : **l'attribut `hidden` perd contre un `display`
écrit dans une règle CSS** de même portée. `index.html` et
`retour-paiement.html` portent désormais une règle qui tranche
(`[hidden]{display:none!important}` / `.hidden{display:none!important}`).
Dans une page qui ne l'a pas, masquer par `hidden` n'est pas fiable.

- `toLocaleString('fr-FR')` produit une **espace fine insécable** (U+202F)
  absente de WinAnsi : un montant devient « 50 /000 FCFA » dans un PDF pdfkit.
  Passer par `texteP()`.
- **pdfkit ajoute une page** si l'on écrit sous la marge basse. Mettre
  `doc.page.margins.bottom = 0` avant d'écrire un pied de page.
- **pdfkit intègre les images à leur taille d'origine** : un logo de 1,3 Mo
  donne un billet de 1,3 Mo. Réduire avec `downscalePng` (le cache est
  `uploads/branding/logo-badge.png`, effacé par `clearTicketCache` au remplacement).
- **Chrome aligne le texte d'une toile sur le pixel entier, verticalement** :
  pour comparer un rendu à la maquette, une ligne de base décalée de 0,4 px
  peut sembler en bouger d'un. Le PDF, vectoriel, n'a pas ce défaut.
- **Coupure de courant = base remplie de zéros.** Arrivé en septembre 2026 :
  bonne taille, contenu nul, dernière sauvegarde aussi. Les écritures passent
  désormais par `ecrireDurable` (fsync) et les sauvegardes copient la base en
  mémoire. Au démarrage, une base illisible fait refuser le lancement avec le
  nom de la dernière sauvegarde valide — le serveur ne la remplace jamais seul.
- **Le SDK Resend ne lève jamais** : il rend `{data: null, error}`. Sans
  vérification explicite, on annonce un e-mail envoyé qui ne l'est pas.
- **Le rattrapage d'un paiement en attente** (`resumePendingPayment`) ne se
  déclenche pas si le formulaire est déjà ouvert : il est fait pour qui *arrive*
  sur le site, pas pour couper une inscription en cours.
- **Les heredocs de shell mangent les antislashs.** Pour modifier un fichier,
  écrire un script Python dans le répertoire temporaire plutôt que de passer
  une expression régulière par le shell.

---

## État actuel — ce qui bloque encore

Rien de tout cela n'est un défaut du code ; ce sont des choses à fournir :

| Manque | Conséquence |
|---|---|
| Clé **FedaPay** valide | Aucun paiement réel. Mode démonstration en attendant. |
| **SMTP** ou clé Resend réelle | Aucun e-mail ne part. |
| `PUBLIC_BASE_URL` publique | Le retour de paiement renvoie le client sur son propre téléphone. |
| Hébergement **HTTPS** | Ni caméra de scan, ni mode hors-ligne le jour J. |
| Domaine + **SPF / DKIM / DMARC** | Les e-mails partent en indésirables. |

---

## Vérifier son travail

`npm test` ne couvre que les e-mails. Pour le reste, le projet se vérifie en
**pilotant un vrai navigateur** par le protocole DevTools de Chrome : lancer
Chrome en `--headless=new --remote-debugging-port=9222`, ouvrir une page,
dérouler le parcours et interroger le DOM.

Deux règles apprises à la dure :

1. **Regarder les captures d'écran, pas seulement les assertions.** Les trois
   défauts de mise en page les plus voyants du projet (boutons qui se
   chevauchent, blocs qui restent affichés, écran de confirmation fantôme) ont
   tous passé leurs tests avant d'être vus sur une image.
2. **Vider `localStorage` avant de charger le site** dans un profil de test
   réutilisé : sinon le rattrapage de paiement de l'essai précédent se déclenche
   et fausse tout.
