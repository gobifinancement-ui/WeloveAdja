require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const { Worker } = require("worker_threads");
const initSqlJs = require("sql.js");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const mail = require("./lib/mail");
const { getTicketLogoPath, qrMatrice, textesBadge, MAX_TICKET_LOGO_BYTES, TICKET_LOGO_CACHE } = require("./lib/ticket-pdf");
const BadgeLayout = require("./js/badge-layout");
const { Sentinelle } = require("./lib/sentinelle");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads", "proofs");
const PARTICIPANT_PHOTOS_DIR = path.join(ROOT, "uploads", "participants");
const QRCODES_DIR = path.join(ROOT, "uploads", "qrcodes");
const BRANDING_DIR = path.join(ROOT, "uploads", "branding");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 24;
const DB_PATH = path.join(DATA_DIR, "weloveadja.sqlite");
const LEGACY_DB_PATH = path.join(DATA_DIR, "feja.sqlite");
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// 7 jours : un poste de scan reste hors-ligne toute la journee de l'evenement
// sans emettre la moindre requete. Avec 12 h, son jeton expirait avant la
// synchro du soir et l'agent devait ressaisir le mot de passe a la fermeture.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEZONE = "Africa/Porto-Novo";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  // Video de fond de l'en-tete. Sans ces deux types, le serveur de
  // fichiers refuse l'extension et le fond reste noir.
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  // Polices du badge, chargees par la toile qui dessine l'image du badge.
  ".ttf": "font/ttf",
};

const DEFAULT_SETTINGS = {
  event_name: "WeloveAdja",
  event_year: "2026",
  // Defaut de premiere installation uniquement : des qu'un mot de passe est
  // enregistre depuis l'admin, c'est lui qui fait foi. A changer sans tarder.
  admin_password: "admin",
  // Mot de passe distinct pour les postes de scan a l'entree. Vide = les
  // agents utilisent le mot de passe admin (ancien comportement).
  scan_password: "",
  // Mode demonstration : court-circuite l'operateur de paiement pour pouvoir
  // dérouler le parcours complet sans cle FedaPay. "1" = actif. Voir
  // DEMO_PAYMENT_TAG et la purge a l'extinction.
  demo_mode: "0",
  vendeur_email: "",
  vendeur_whatsapp: "",
  pickup_location: "",
  participation_fee: "10000",
  moov_nom: "",
  moov_numero: "",
  mtn_nom: "",
  mtn_numero: "",
  payment_public_key: "",
  payment_secret_key: "",
  payment_environment: "sandbox",
  // Pays dont les clients paient SANS quitter le site : la demande part en
  // USSD sur leur telephone. Ailleurs, la page hebergee de l'operateur reste
  // le seul moyen de couvrir tous les reseaux et la carte bancaire.
  paiement_direct_pays: "BJ",
  paiement_direct_actif: "1",
  fedapay_webhook_secret: "",
  public_base_url: "",
  wachap_instance_id: "",
  wachap_access_token: "",
  resend_api_key: "",
  resend_from: "",
  // --- Envoi par le SMTP de la boite du domaine ---
  // Ces valeurs peuvent aussi venir de l'environnement (SMTP_HOST,
  // SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE, MAIL_FROM), qui
  // l'emporte. En production, on les met dans .env et pas ici.
  smtp_host: "",
  smtp_port: "",
  smtp_user: "",
  smtp_password: "",
  smtp_secure: "",
  smtp_tls_strict: "1",
  mail_from: "",
  // Adresse qui recoit les alertes internes. Configurable, jamais codee
  // en dur : elle change selon la personne de permanence.
  alert_email: "",
  // Adresse des alertes de securite (lib/sentinelle.js). MAIL_SECURITE_TO
  // dans .env l'emporte ; vide = adresse des alertes internes.
  securite_email: "",
  // Adresses d'ou l'admin s'est deja connecte (JSON), pour reperer une
  // connexion depuis une adresse jamais vue.
  securite_ip_admin: "[]",
  event_date_label: "",
  event_date: "",
  // "1" = la fete revient chaque annee a la meme date. Le compte a rebours
  // vise alors la prochaine occurrence : passe le jour J, il bascule sur
  // l'annee suivante sans qu'on ait rien a ressaisir.
  event_annual: "0",
  wa_link: "",
  // Video montrant comment recuperer son badge, postee sur TikTok. Vide =
  // aucun bouton "voir la video" affiche, ni sur le parcours de paiement ni
  // en pied de page.
  tiktok_guide_url: "",
  chiefs_json: "[]",
  sponsors_json: "[]",
  event_items_json: "[]",
  // Artistes invites : [{name, note, poster}] ou poster est une image
  // compressee cote admin avant envoi (voir compressPoster dans admin.html).
  artists_json: "[]",
  // Disposition et animation choisies dans l'admin. Les valeurs acceptees
  // sont validees a l'ecriture, voir ARTISTS_LAYOUTS / ARTISTS_ANIMATIONS.
  artists_layout: "carrousel",
  artists_animation: "cascade",
  // Animation appliquee a tout le contenu qui arrive a l'ecran (titres,
  // cartes, sections). Voir SCROLL_ANIMATIONS.
  scroll_animation: "montee",
  logo_url: "",
  // Textes du badge (js/badge-layout.js). Valeurs de la maquette validee par
  // l'organisation ; un champ vide y retombe. Dans badge_dates, ce qui est
  // entre ** ** est ecrit en gras. badge_activites : une ligne par ligne du
  // bandeau du bas, quatre au plus.
  badge_titre: BadgeLayout.DEFAUTS.titre,
  badge_annee: BadgeLayout.DEFAUTS.annee,
  badge_edition: BadgeLayout.DEFAUTS.edition,
  badge_lieu: BadgeLayout.DEFAUTS.lieu,
  badge_dates: BadgeLayout.DEFAUTS.dates,
  badge_activites: BadgeLayout.DEFAUTS.activites,
  // Jour (JJ/MM) apres lequel le badge passe a l'annee et a l'edition
  // suivantes. Voir appliquerBasculeBadge.
  badge_bascule: BadgeLayout.BASCULE_DEFAUT,
  // Media anime en fond de l'en-tete : GIF ou video. Vide = le fond
  // actuel (rayonnement + degrade) reste seul.
  hero_media_url: "",
  // "1" = le media anime est affiche ; "0" = on revient a l'arriere-plan
  // d'origine SANS supprimer le fichier, pour pouvoir y revenir.
  hero_media_active: "1",
  // Intensite du voile pose sur le fond anime, de 0 a 100. Plus la valeur
  // est haute, plus le media est assombri et plus les textes ressortent.
  // 70 par defaut : un media clair rend le titre illisible en dessous.
  hero_media_veil: "70",
  theme_preset: "indigo",
  theme_custom_json: "{}",
  // Rotation quotidienne des couleurs : liste de presets parcourue un par
  // jour, puis on reboucle. Moins de deux entrees = pas de rotation, c'est
  // theme_preset qui fait foi.
  theme_rotation_json: "[]",
};

// Palettes proposees dans l'admin. Chaque preset ne definit que les couleurs
// "sources" : les variantes derivees (transparences, degrades) sont calculees
// dans buildThemeCss pour rester coherentes quel que soit le choix.
const THEME_PRESETS = {
  // Palette historique du site (ex-`html[data-theme="indigo"]`) : c'est le
  // rendu actuel, donc le defaut, pour que rien ne change sans decision.
  indigo: {
    label: "Indigo & Or",
    colors: { bg: "#0a0e2a", bg2: "#121845", green: "#5b6bd6", greenBr: "#8a96f0", gold: "#f0c64f", goldLt: "#ffe6a0", goldDp: "#c2942f", cream: "#f6f1e6", red: "#e08a6a" },
  },
  emeraude: {
    label: "Émeraude & Or",
    colors: { bg: "#05201a", bg2: "#082b22", green: "#1f9162", greenBr: "#3fc189", gold: "#e7bb46", goldLt: "#f7df9b", goldDp: "#b88a28", cream: "#f6f1e6", red: "#e08a6a" },
  },
  // Ex-`html[data-theme="terre"]`, conservee pour ne perdre aucune option.
  terre: {
    label: "Terre & Ambre",
    colors: { bg: "#241510", bg2: "#34201a", green: "#c2703a", greenBr: "#e0925a", gold: "#e8b563", goldLt: "#f7d8a0", goldDp: "#b9842f", cream: "#f6f1e6", red: "#e08a6a" },
  },
  bordeaux: {
    label: "Bordeaux & Or",
    colors: { bg: "#20060c", bg2: "#2e0a13", green: "#9b2242", greenBr: "#c94f6d", gold: "#e7bb46", goldLt: "#f7df9b", goldDp: "#b88a28", cream: "#f7ece9", red: "#e08a6a" },
  },
  nuit: {
    label: "Bleu nuit & Argent",
    colors: { bg: "#060f21", bg2: "#0b1832", green: "#2c5cc5", greenBr: "#5b8cf0", gold: "#c9d6e8", goldLt: "#eef4ff", goldDp: "#8fa3bf", cream: "#eef2f8", red: "#e8836a" },
  },
  violet: {
    label: "Violet & Rose",
    colors: { bg: "#150726", bg2: "#210d38", green: "#7b3fd4", greenBr: "#a874f5", gold: "#f08fc0", goldLt: "#ffc2de", goldDp: "#c05e91", cream: "#f4ecfa", red: "#ef7d8d" },
  },
  onyx: {
    label: "Noir & Or",
    colors: { bg: "#0b0b0c", bg2: "#161617", green: "#4a4a4d", greenBr: "#7c7c82", gold: "#e7bb46", goldLt: "#f7df9b", goldDp: "#b88a28", cream: "#f4f2ee", red: "#e08a6a" },
  },
  terracotta: {
    label: "Terracotta & Sable",
    colors: { bg: "#24100a", bg2: "#361a10", green: "#c05a2e", greenBr: "#e58150", gold: "#e9c07a", goldLt: "#fbe3b8", goldDp: "#b58d46", cream: "#faf0e4", red: "#e0705a" },
  },
  ocean: {
    label: "Océan & Turquoise",
    colors: { bg: "#04191f", bg2: "#07262f", green: "#0e7c86", greenBr: "#2bb3bf", gold: "#5fd6c4", goldLt: "#a8f0e5", goldDp: "#3a9e90", cream: "#e9f7f6", red: "#e88a72" },
  },
};

const DEFAULT_THEME_PRESET = "indigo";

// Dispositions et animations proposees pour les affiches des artistes. Liste
// fermee : une valeur inconnue arrivant de l'admin retombe sur le defaut,
// sinon elle atterrirait telle quelle dans un nom de classe CSS.
const ARTISTS_LAYOUTS = ["carrousel", "grille", "pleine"];
const ARTISTS_ANIMATIONS = ["cascade", "fondu", "zoom", "glisse", "aucune"];

// Animation d'apparition du contenu au defilement. Liste fermee : la valeur
// finit dans un attribut data-* lu par le CSS.
const SCROLL_ANIMATIONS = ["montee", "fondu", "zoom", "glisse", "bascule", "flou", "aucune"];

// Traduction des champs de l'admin vers les cles reellement lues par le
// serveur. DOIT couvrir tous les [data-set] de admin.html : une cle absente
// ici est ignoree (et signalee), jamais ecrite telle quelle.
// Une valeur tableau alimente plusieurs reglages a la fois.
const SETTINGS_KEY_MAP = {
  eventName:            "event_name",
  amount:               "participation_fee",
  lieu:                 "pickup_location",
  dateLabel:            "event_date_label",
  eventDate:            "event_date",
  eventAnnual:          "event_annual",
  accountName:          ["moov_nom", "mtn_nom"], // un seul champ dans l'admin, deux operateurs
  moovNumber:           "moov_numero",
  mtnNumber:            "mtn_numero",
  waLink:               "wa_link",
  email:                "vendeur_email",
  wachapKey:            "wachap_access_token",
  resendKey:            "resend_api_key",
  resendFrom:           "resend_from",
  smtpHost:             "smtp_host",
  smtpPort:             "smtp_port",
  smtpUser:             "smtp_user",
  smtpPassword:         "smtp_password",
  smtpSecure:           "smtp_secure",
  smtpTlsStrict:        "smtp_tls_strict",
  mailFrom:             "mail_from",
  alertEmail:           "alert_email",
  securiteEmail:        "securite_email",
  heroMediaActive:      "hero_media_active",
  heroMediaVeil:        "hero_media_veil",
  adminPassword:        "admin_password",
  scanPassword:         "scan_password",
  paymentSecretKey:     "payment_secret_key",
  paiementDirectPays:   "paiement_direct_pays",
  paiementDirectActif:  "paiement_direct_actif",
  paymentEnvironment:   "payment_environment",
  fedapayWebhookSecret: "fedapay_webhook_secret",
  publicBaseUrl:        "public_base_url",
  chiefs:               "chiefs_json",
  sponsors:             "sponsors_json",
  eventItems:           "event_items_json",
  artists:              "artists_json",
  artistsLayout:        "artists_layout",
  artistsAnimation:     "artists_animation",
  scrollAnimation:      "scroll_animation",
  tiktokUrl:            "tiktok_guide_url",
  badgeTitre:           "badge_titre",
  badgeAnnee:           "badge_annee",
  badgeEdition:         "badge_edition",
  badgeLieu:            "badge_lieu",
  badgeDates:           "badge_dates",
  badgeActivites:       "badge_activites",
  badgeBascule:         "badge_bascule",
};

let db;

// ---------------------------------------------------------------------------
// Surveillance (lib/sentinelle.js) : fraude, attaques, incidents couteux.
// Les alertes partent a MAIL_SECURITE_TO (.env), sinon au reglage
// securite_email, sinon a l'adresse des alertes internes.
// ---------------------------------------------------------------------------
const sentinelle = new Sentinelle({
  dossier: DATA_DIR,
  envoyer: async (sujet, lignes, note) => {
    const settings = db ? getSettings() : { ...DEFAULT_SETTINGS };
    const alerte = new mail.AlerteSecuriteEmail({
      settings,
      baseUrl: getPublicBaseUrl(settings),
      evenement: sujet,
      lignes,
      note,
    });
    if (!alerte.destinataire()) throw new Error("aucune adresse pour les alertes de sécurité");
    await alerte.send();
    return true;
  },
});
sentinelle.brancherConsole();

// Adresses d'ou l'admin s'est deja connecte (20 dernieres). Une connexion
// depuis une adresse jamais vue est le premier signe d'un mot de passe vole.
function noterConnexionAdmin(ip, settings) {
  let connues = [];
  try { connues = JSON.parse(settings.securite_ip_admin || "[]"); } catch {}
  if (connues.includes(ip)) return;
  if (connues.length) {
    sentinelle.signaler({ gravite: "alerte", type: "admin_connexion", titre: "Connexion à l'admin depuis une nouvelle adresse", ip,
      details: [["Adresses connues", connues.slice(-5).join(", ")]] });
  } else {
    sentinelle.signaler({ gravite: "info", type: "admin_connexion", titre: "Première connexion admin enregistrée", ip });
  }
  saveSettings({ securite_ip_admin: JSON.stringify([...connues, ip].slice(-20)) });
}

// Reglages dont la modification merite d'etre signalee : un compte admin
// vole servirait d'abord a detourner les paiements (numeros Mobile Money,
// cle FedaPay) ou a s'installer (mots de passe, adresse des alertes).
const REGLAGES_SENSIBLES = {
  payment_secret_key: { nom: "Clé secrète FedaPay", secret: true, critique: true },
  payment_environment: { nom: "Environnement de paiement" },
  fedapay_webhook_secret: { nom: "Secret du webhook FedaPay", secret: true },
  moov_numero: { nom: "Numéro Moov Money", critique: true },
  mtn_numero: { nom: "Numéro MTN MoMo", critique: true },
  participation_fee: { nom: "Prix du badge" },
  admin_password: { nom: "Mot de passe admin", secret: true, critique: true },
  scan_password: { nom: "Mot de passe des postes de scan", secret: true },
  public_base_url: { nom: "Adresse publique du site" },
  smtp_host: { nom: "Serveur SMTP" },
  smtp_user: { nom: "Compte SMTP" },
  smtp_password: { nom: "Mot de passe SMTP", secret: true },
  mail_from: { nom: "Expéditeur des e-mails" },
  resend_api_key: { nom: "Clé Resend", secret: true },
  alert_email: { nom: "Adresse des alertes internes" },
  securite_email: { nom: "Adresse des alertes de sécurité", critique: true },
};

function signalerReglagesSensibles(avant, apres, ip) {
  const changes = Object.entries(apres).filter(([cle, valeur]) =>
    REGLAGES_SENSIBLES[cle] && String(avant[cle] == null ? "" : avant[cle]) !== String(valeur == null ? "" : valeur));
  if (!changes.length) return;
  const critique = changes.some(([cle]) => REGLAGES_SENSIBLES[cle].critique);
  sentinelle.signaler({
    gravite: critique ? "critique" : "alerte",
    type: "reglage_sensible",
    titre: `Réglage sensible modifié : ${changes.map(([cle]) => REGLAGES_SENSIBLES[cle].nom).join(", ")}`,
    ip,
    cle: `reglages:${changes.map(([cle]) => cle).join(",")}:${Date.now()}`,
    details: changes.map(([cle, valeur]) => [
      REGLAGES_SENSIBLES[cle].nom,
      REGLAGES_SENSIBLES[cle].secret ? "modifié (valeur masquée)" : `« ${avant[cle] || "vide"} » → « ${valeur || "vide"} »`,
    ]),
  });
}

function signalerDoubleEntree(participant, ou) {
  sentinelle.signaler({
    gravite: "alerte",
    type: "double_entree",
    titre: "Badge déjà utilisé présenté à nouveau à l'entrée",
    cle: `double:${participant.code_unique}`,
    details: [
      ["Participant", `${participant.nom} — code ${participant.code_unique}`],
      ["Premier passage", participant.retrait_effectue_at ? new Date(Number(participant.retrait_effectue_at)).toLocaleString("fr-FR", { timeZone: TIMEZONE }) : "?"],
      ["Nouvelle présentation", ou],
    ],
  });
}

function signalerFraudePaiement(motif, participant, transaction, attendu) {
  sentinelle.signaler({
    gravite: "critique",
    type: "fraude_paiement",
    titre: `Tentative de fraude au paiement : ${motif}`,
    cle: `fraude:${transaction && transaction.id}`,
    details: [
      ["Inscription", participant ? `${participant.id} (${participant.nom || "?"})` : "?"],
      ["Transaction FedaPay", transaction ? String(transaction.id) : "?"],
      ["Montant reçu", transaction ? `${transaction.amount} FCFA` : "?"],
      ["Montant attendu", attendu == null ? "—" : `${attendu} FCFA`],
    ],
  });
}

// Espace libre sur le disque des donnees, mesure au plus une fois par minute.
let espaceMesure = { t: 0, octets: Infinity };
function espaceDisqueLibre() {
  if (Date.now() - espaceMesure.t > 60 * 1000) {
    try {
      const s = fs.statfsSync(DATA_DIR);
      espaceMesure = { t: Date.now(), octets: s.bavail * s.bsize };
    } catch {
      espaceMesure = { t: Date.now(), octets: Infinity };
    }
  }
  return espaceMesure.octets;
}

// Sous ce seuil, plus aucune photo n'est acceptee : un disque plein bloque la
// base elle-meme, donc TOUTES les inscriptions, y compris celles deja payees.
const ESPACE_MINIMUM = 300 * 1024 * 1024;

function inscriptionsSuspendues(request) {
  if (espaceDisqueLibre() >= ESPACE_MINIMUM) return false;
  sentinelle.signaler({
    gravite: "critique",
    type: "inscriptions_suspendues",
    titre: "Inscriptions suspendues : disque presque plein",
    cle: "disque-plein",
    ip: getClientIp(request),
    details: [["Espace libre", `${Math.round(espaceDisqueLibre() / 1048576)} Mo`]],
  });
  return true;
}

// Controles toutes les 5 minutes : ressources du serveur et reglages qui
// coutent cher s'ils restent en place par oubli.
function surveillancePeriodique() {
  try {
    const libre = espaceDisqueLibre();
    if (libre < 1024 * 1024 * 1024) {
      sentinelle.signaler({
        gravite: libre < ESPACE_MINIMUM ? "critique" : "alerte",
        type: "disque",
        titre: "Espace disque presque épuisé",
        cle: "disque",
        delai: 3 * 60 * 60 * 1000,
        details: [["Espace libre", `${Math.round(libre / 1048576)} Mo`]],
      });
    }

    const memoire = process.memoryUsage().rss;
    if (memoire > 800 * 1024 * 1024) {
      sentinelle.signaler({ gravite: "alerte", type: "memoire", titre: "Mémoire du serveur très élevée", cle: "memoire", delai: 3 * 60 * 60 * 1000,
        details: [["Mémoire utilisée", `${Math.round(memoire / 1048576)} Mo`]] });
    }

    if (!db) return;
    const settings = getSettings();
    // Rappel toutes les 6 h tant que le mode demonstration reste allume.
    if (isDemoMode(settings)) {
      sentinelle.signaler({ gravite: "alerte", type: "demo", titre: "Le mode démonstration est toujours actif",
        cle: "demo-rappel", delai: 6 * 60 * 60 * 1000 });
    }

    // Reglages dangereux une fois le site public : un rappel par jour.
    const enLigne = /^https:\/\//i.test(getPublicBaseUrl(settings) || "") && !/localhost|127\.0\.0\.1/.test(getPublicBaseUrl(settings));
    if (enLigne) {
      const problemes = [];
      const environnement = process.env.FEDAPAY_ENVIRONMENT || settings.payment_environment || "sandbox";
      if (!isDemoMode(settings) && !(process.env.FEDAPAY_SECRET_KEY || settings.payment_secret_key)) {
        problemes.push(["Paiement", "Aucune clé FedaPay : personne ne peut payer."]);
      } else if (!isDemoMode(settings) && environnement !== "live") {
        problemes.push(["Paiement", "FedaPay est en mode « sandbox » : les paiements ne sont pas réels."]);
      }
      if (!getFedapayWebhookSecret(settings)) {
        problemes.push(["Webhook FedaPay", "Aucun secret : les notifications FedaPay ne sont pas authentifiées."]);
      }
      if (verifyPassword(DEFAULT_SETTINGS.admin_password, settings.admin_password || DEFAULT_SETTINGS.admin_password).ok) {
        problemes.push(["Mot de passe admin", "Toujours « admin » : n'importe qui peut ouvrir l'administration."]);
      }
      if (problemes.length) {
        sentinelle.signaler({ gravite: "alerte", type: "config", titre: "Réglages dangereux sur le site en ligne",
          cle: "config", delai: 24 * 60 * 60 * 1000, details: problemes });
      }
    }
  } catch (error) {
    console.warn("Surveillance periodique impossible:", error.message);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

// Repertoires et fichiers qui ne doivent JAMAIS sortir par le serveur de
// fichiers. Sans cette liste, une simple requete GET /.env livrait la cle
// secrete FedaPay, et GET /data/weloveadja.sqlite toute la base (mot de passe
// admin, participants, codes d'entree). C'est la premiere barriere.
const PRIVATE_PREFIXES = [
  "data",          // base SQLite + sauvegardes
  "node_modules",
  ".git",
  ".sixth",
];

// Fichiers de la racine servis a personne, meme s'ils portent une extension
// autorisee. Tout ce qui n'est pas une page ou un asset du site public.
const PRIVATE_FILES = new Set([
  ".env",
  ".gitignore",
  "server.js",
  "server.bat",
  "package.json",
  "package-lock.json",
]);

function isPrivatePath(relativePath) {
  // Separateurs normalises : sous Windows path.normalize produit des "\\".
  const posix = relativePath.split(path.sep).join("/");
  const segments = posix.split("/").filter(Boolean);

  if (!segments.length) return true;

  // Aucun fichier ou dossier cache (.env, .git, .htaccess...).
  if (segments.some((segment) => segment.startsWith("."))) return true;

  if (PRIVATE_PREFIXES.includes(segments[0])) return true;
  if (segments.length === 1 && PRIVATE_FILES.has(segments[0].toLowerCase())) return true;

  // Les journaux ne racontent rien d'utile au public et peuvent contenir des
  // messages d'erreur bavards.
  if (posix.toLowerCase().endsWith(".log")) return true;

  return false;
}

function resolveFilePath(urlPathname) {
  let cleanPath;
  try {
    cleanPath = decodeURIComponent(urlPathname.split("?")[0]);
  } catch {
    // Sequence %XX invalide : on refuse plutot que de deviner.
    return null;
  }

  // Un octet nul tronque le nom de fichier dans certaines couches basses.
  if (cleanPath.includes("\u0000")) return null;

  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, relativePath);
  const normalized = path.normalize(filePath);

  // `startsWith(ROOT)` seul laissait passer un dossier voisin nomme
  // "WeloveAdja-old" : on exige le separateur, donc un vrai sous-chemin.
  if (normalized !== ROOT && !normalized.startsWith(ROOT + path.sep)) {
    return null;
  }

  if (isPrivatePath(path.relative(ROOT, normalized))) {
    return null;
  }

  // Liste blanche d'extensions : seuls les types que le site sert reellement.
  // Un fichier sans extension connue (script, archive, base) est refuse meme
  // s'il se trouve dans un dossier public.
  if (!MIME_TYPES[path.extname(normalized).toLowerCase()]) {
    return null;
  }

  return normalized;
}

async function serveStaticFile(request, response, pathname) {
  const filePath = resolveFilePath(pathname);

  if (!filePath) {
    // Meme reponse qu'un fichier absent : un 403 confirmerait l'existence du
    // fichier et guiderait la recherche.
    sendJson(response, 404, { error: "Fichier introuvable." });
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);

    if (!stat.isFile()) {
      sendJson(response, 404, { error: "Fichier introuvable." });
      return;
    }

    const targetPath = filePath;
    const extname = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[extname] || "application/octet-stream";
    const fileContent = await fs.promises.readFile(targetPath);

    const headers = {
      "Content-Type": contentType,
      // Les polices du badge ne changent jamais et pesent pres de 500 Ko :
      // les retelecharger a chaque badge affiche couterait cher en donnees.
      "Cache-Control": path.relative(ROOT, filePath).split(path.sep)[0] === "fonts"
        ? "public, max-age=604800"
        : "no-store",
    };

    // Les fichiers de /uploads/ sont fournis par l'organisateur ou par les
    // participants. Un SVG est un document actif : ouvert directement dans un
    // onglet, il peut executer du script sur NOTRE domaine et voler la session
    // admin. Cette politique le neutralise sans empecher son affichage en
    // <img>, et vaut pour tout ce dossier par principe.
    if (path.relative(ROOT, filePath).split(path.sep)[0] === "uploads") {
      headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }

    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : fileContent);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "Fichier introuvable." });
      return;
    }

    console.error("Erreur serveur statique:", error);
    sendJson(response, 500, { error: "Erreur serveur." });
  }
}

// Ecriture de la base sur le disque.
//
// Atomique : fichier temporaire, fsync, puis renommage. Un ecrasement direct
// laissait, en cas de coupure, un fichier tronque, donc la perte de TOUS les
// participants.
//
// Hors du fil principal et groupee : l'image de la base est prise tout de
// suite (quelques ms), mais l'ecriture et le fsync se font en arriere-plan.
// Faits en direct, ils gelaient le site ~50 ms par modification, soit
// plusieurs secondes quand 50 personnes paient en meme temps. Les demandes
// qui arrivent pendant une ecriture sont regroupees dans la suivante.
//
// La promesse rendue est tenue quand l'etat du moment est sur le disque : les
// routes l'attendent avant de repondre, comme quand l'ecriture etait directe.
let ecritureEnCours = null;
let prochaineEcriture = null;

function persistDatabase() {
  if (!prochaineEcriture) {
    let tenir, rompre;
    const promesse = new Promise((res, rej) => { tenir = res; rompre = rej; });
    // L'erreur est journalisee dans lancerEcriture ; seuls ceux qui attendent
    // la promesse la recoivent, sans « rejet non traite » pour les autres.
    promesse.catch(() => {});
    prochaineEcriture = { promesse, tenir, rompre };
  }
  const attente = prochaineEcriture.promesse;
  if (!ecritureEnCours) lancerEcriture();
  return attente;
}

function lancerEcriture() {
  const lot = prochaineEcriture;
  prochaineEcriture = null;
  const tempPath = `${DB_PATH}.tmp`;
  let data;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    data = Buffer.from(db.export());
  } catch (error) {
    console.error("Ecriture de la base impossible:", error.message);
    signalerEchecBase(error);
    lot.rompre(error);
    return;
  }
  ecritureEnCours = ecrireDurableAsync(tempPath, data)
    .then(() => fs.promises.rename(tempPath, DB_PATH))
    .then(
      () => lot.tenir(),
      (error) => {
        console.error("Ecriture de la base impossible:", error.message);
        signalerEchecBase(error);
        lot.rompre(error);
      },
    )
    .finally(() => {
      ecritureEnCours = null;
      if (prochaineEcriture) lancerEcriture();
    });
}

function signalerEchecBase(error) {
  sentinelle.signaler({ gravite: "critique", type: "base", titre: "La base de données ne s'enregistre plus sur le disque", cle: "base",
    details: [["Erreur", error.message], ["Espace disque libre", `${Math.round(espaceDisqueLibre() / 1048576)} Mo`]] });
}

async function ecrireDurableAsync(chemin, octets) {
  const fichier = await fs.promises.open(chemin, "w");
  try {
    await fichier.writeFile(octets);
    await fichier.sync();
  } finally {
    await fichier.close();
  }
}

// A l'arret, ce qui n'est pas encore sur le disque y est ecrit, de facon
// synchrone : plus rien d'asynchrone ne s'execute pendant un arret.
process.on("exit", () => {
  if (!db || (!ecritureEnCours && !prochaineEcriture)) return;
  try {
    const tempPath = `${DB_PATH}.arret.tmp`;
    ecrireDurable(tempPath, Buffer.from(db.export()));
    fs.renameSync(tempPath, DB_PATH);
  } catch (error) {
    console.error("Ecriture de la base a l'arret impossible:", error.message);
  }
});

// Ecriture forcee jusqu'au disque avant de rendre la main. Sans le fsync,
// Windows peut enregistrer la taille d'un fichier avant son contenu : apres
// une coupure de courant, la base fait la bonne taille mais ne contient que
// des zeros, et le renommage atomique ne protege de rien.
function ecrireDurable(chemin, octets) {
  const fd = fs.openSync(chemin, "w");
  try {
    let ecrit = 0;
    while (ecrit < octets.length) ecrit += fs.writeSync(fd, octets, ecrit, octets.length - ecrit);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const ENTETE_SQLITE = Buffer.from("SQLite format 3\u0000", "latin1");

function estBaseSqlite(chemin) {
  try {
    const fd = fs.openSync(chemin, "r");
    const tete = Buffer.alloc(16);
    try { fs.readSync(fd, tete, 0, 16, 0); } finally { fs.closeSync(fd); }
    return tete.equals(ENTETE_SQLITE);
  } catch {
    return false;
  }
}

// Message de demarrage quand la base est illisible. Le serveur ne la
// remplace JAMAIS de lui-meme : il indique la sauvegarde a restaurer.
function messageBaseIllisible() {
  let sauvegarde = null;
  try {
    sauvegarde = fs.readdirSync(BACKUP_DIR)
      .filter((nom) => nom.endsWith(".sqlite"))
      .sort()
      .reverse()
      .find((nom) => estBaseSqlite(path.join(BACKUP_DIR, nom)));
  } catch {}
  return [
    "data/weloveadja.sqlite est illisible (fichier vide ou abime, souvent apres une coupure de courant).",
    "Le serveur refuse de demarrer pour ne rien ecraser.",
    sauvegarde
      ? `Derniere sauvegarde valide : data/backups/${sauvegarde}. Pour la restaurer : mettre le fichier abime de cote, puis copier cette sauvegarde a sa place sous le nom data/weloveadja.sqlite.`
      : "Aucune sauvegarde valide dans data/backups/.",
  ].join("\n");
}

// Copie de securite horodatee, gardee en rotation. Sert de filet si la base
// est corrompue ou effacee par erreur la veille de l'evenement.
function backupDatabase() {
  try {
    if (!db) return;

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "");
    // Copie de la base EN MEMOIRE, et non du fichier : si le fichier sur
    // disque etait abime, la rotation remplacerait peu a peu toutes les
    // bonnes sauvegardes par des copies illisibles.
    const octets = Buffer.from(db.export());
    ecrireDurable(path.join(BACKUP_DIR, `weloveadja-${stamp}.sqlite`), octets);

    // Une copie par jour, gardee un mois. Les copies horaires ne couvrent
    // que 24 h : une erreur remarquee le surlendemain (inscriptions effacees
    // par megarde) n'aurait plus aucune sauvegarde saine.
    const jour = path.join(BACKUP_DIR, `jour-${stamp.slice(0, 8)}.sqlite`);
    if (!fs.existsSync(jour)) ecrireDurable(jour, octets);

    const tourner = (prefixe, garder) => {
      const fichiers = fs.readdirSync(BACKUP_DIR)
        .filter((name) => name.startsWith(prefixe) && name.endsWith(".sqlite"))
        .sort();
      fichiers.slice(0, Math.max(0, fichiers.length - garder)).forEach((name) => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch {}
      });
    };
    tourner("weloveadja-", MAX_BACKUPS);
    tourner("jour-", 30);
  } catch (error) {
    console.warn("Sauvegarde de la base impossible:", error.message);
    sentinelle.signaler({ gravite: "alerte", type: "sauvegarde", titre: "La sauvegarde automatique de la base a échoué", cle: "sauvegarde",
      details: [["Erreur", error.message]] });
  }
}

function statementAll(sql, params = []) {
  const statement = db.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function statementGet(sql, params = []) {
  return statementAll(sql, params)[0] || null;
}

function run(sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.run(params);
  } finally {
    statement.free();
  }
}

function ensureParticipantColumns() {
  const existingColumns = new Set(statementAll("PRAGMA table_info(participants)").map((column) => column.name));
  const requiredColumns = [
    ["participant_photo_url", "TEXT"],
    ["items_received", "TEXT"],
    ["fedapay_transaction_id", "TEXT"],
    ["fedapay_customer_id", "TEXT"],
    ["fedapay_reference", "TEXT"],
    ["fedapay_status", "TEXT"],
    ["qr_code_url", "TEXT"],
    ["scan_device_id", "TEXT"],
    // Achat groupe : un billet par personne, mais un seul paiement. Les trois
    // colonnes disent a quel achat la ligne appartient, son rang, et combien
    // de billets l'achat comptait.
    ["groupe_id", "TEXT"],
    ["groupe_index", "INTEGER"],
    ["groupe_taille", "INTEGER"],
  ];

  requiredColumns.forEach(([name, definition]) => {
    if (!existingColumns.has(name)) {
      run(`ALTER TABLE participants ADD COLUMN ${name} ${definition}`);
    }
  });

  // Cree apres les ALTER : place dans le bloc de schema, l'index porterait sur
  // une colonne qui n'existe pas encore dans les bases deja en service.
  run("CREATE INDEX IF NOT EXISTS idx_participants_groupe ON participants(groupe_id)");
}

// Les bases creees avant l'introduction des roles n'ont pas la colonne :
// ALTER TABLE la rajoute sans toucher aux sessions deja ouvertes.
function ensureSessionColumns() {
  const columns = new Set(statementAll("PRAGMA table_info(sessions)").map((column) => column.name));
  if (!columns.has("role")) {
    run("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  }
}

function getSettings() {
  const rows = statementAll("SELECT key, value FROM settings");
  return rows.reduce((accumulator, row) => {
    accumulator[row.key] = row.value;
    return accumulator;
  }, { ...DEFAULT_SETTINGS });
}

function saveSettings(settings) {
  Object.entries(settings).forEach(([key, value]) => {
    run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      value == null ? "" : String(value),
    ]);
  });
  persistDatabase();
}

// --- Un seul serveur par base ----------------------------------------------
// La base vit en memoire et chaque ecriture remplace tout le fichier. Deux
// serveurs lances sur le meme dossier (double clic sur server.bat, port 3000
// deja pris qui fait basculer le second sur 3001...) ecraseraient chacun les
// inscriptions de l'autre, sans la moindre erreur visible. Le verrou porte
// le numero du processus et un battement rafraichi toutes les 30 s : un
// verrou laisse par un serveur arrete brutalement est repris tout seul.
const VERROU_PATH = path.join(DATA_DIR, "serveur.lock");
const VERROU_DEPUIS = Date.now();

function ecrireVerrou() {
  try {
    fs.writeFileSync(VERROU_PATH, JSON.stringify({ pid: process.pid, depuis: VERROU_DEPUIS, battement: Date.now() }));
  } catch {}
}

function prendreVerrou() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let actuel = null;
  try { actuel = JSON.parse(fs.readFileSync(VERROU_PATH, "utf8")); } catch {}

  if (actuel && actuel.pid !== process.pid) {
    let vivant = false;
    try { process.kill(actuel.pid, 0); vivant = true; } catch (error) { vivant = error.code === "EPERM"; }
    const frais = Date.now() - Number(actuel.battement || 0) < 2 * 60 * 1000;
    if (vivant && frais) {
      throw new Error(
        `Un autre serveur utilise deja cette base (processus ${actuel.pid}). ` +
        "Ferme-le avant d'en lancer un second : deux serveurs sur la meme base s'ecrasent les inscriptions.",
      );
    }
  }

  ecrireVerrou();
  setInterval(ecrireVerrou, 30 * 1000).unref();

  const liberer = () => {
    try {
      const v = JSON.parse(fs.readFileSync(VERROU_PATH, "utf8"));
      if (v.pid === process.pid) fs.unlinkSync(VERROU_PATH);
    } catch {}
  };
  process.on("exit", liberer);
  ["SIGINT", "SIGTERM", "SIGBREAK"].forEach((signal) => process.on(signal, () => process.exit(0)));
}

async function initDatabase() {
  prendreVerrou();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(PARTICIPANT_PHOTOS_DIR, { recursive: true });
  fs.mkdirSync(QRCODES_DIR, { recursive: true });
  fs.mkdirSync(BRANDING_DIR, { recursive: true });

  // Reprise de l'ancien fichier de base (feja.sqlite) : on le renomme au lieu
  // de repartir de zero, sinon reglages et participants seraient perdus. Ne
  // s'execute que si la nouvelle base n'existe pas encore.
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.renameSync(LEGACY_DB_PATH, DB_PATH);
    console.log("Base migree : data/feja.sqlite -> data/weloveadja.sqlite");
  }

  const SQL = await initSqlJs();
  const existing = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  if (existing && existing.length && !estBaseSqlite(DB_PATH)) {
    throw new Error(messageBaseIllisible());
  }
  db = existing ? new SQL.Database(existing) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      evenement TEXT NOT NULL DEFAULT 'WeloveAdja',
      nom TEXT NOT NULL,
      telephone TEXT NOT NULL,
      whatsapp TEXT,
      email TEXT NOT NULL,
      montant TEXT,
      montant_valeur INTEGER,
      paiement TEXT,
      operateur_paiement_code TEXT,
      operateur_paiement TEXT,
      nom_paiement TEXT,
      numero_paiement TEXT,
      preuve_paiement TEXT,
      preuve_url TEXT,
      capture_b64 TEXT,
      participant_photo_url TEXT,
      statut_paiement TEXT NOT NULL DEFAULT 'En attente',
      code_unique TEXT UNIQUE,
      statut_code TEXT,
      fedapay_transaction_id TEXT,
      fedapay_customer_id TEXT,
      fedapay_reference TEXT,
      fedapay_status TEXT,
      qr_code_url TEXT,
      lieu_retrait TEXT,
      date TEXT,
      date_key TEXT,
      timestamp INTEGER NOT NULL,
      validation_at INTEGER,
      retrait_effectue_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_participants_timestamp ON participants(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_participants_code_unique ON participants(code_unique);
    CREATE INDEX IF NOT EXISTS idx_participants_fedapay_transaction ON participants(fedapay_transaction_id);

    -- Codes a 6 chiffres envoyes par email pour recuperer son billet.
    -- L'email est la CLE : une nouvelle demande remplace la precedente, si
    -- bien qu'un seul code est valable a la fois par adresse.
    CREATE TABLE IF NOT EXISTS ticket_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Sessions courtes ouvertes apres verification du code. On ne stocke que
    -- l'empreinte du jeton : une fuite de la base ne donnerait aucun acces.
    CREATE TABLE IF NOT EXISTS ticket_sessions (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      type TEXT,
      object_id TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  ensureParticipantColumns();
  ensureSessionColumns();

  const settings = getSettings();
  saveSettings(settings);

  // Migration du mot de passe en clair vers une empreinte scrypt. Se fait une
  // seule fois, au premier demarrage suivant la mise a jour.
  const storedPassword = String(settings.admin_password || "");
  if (storedPassword && !storedPassword.startsWith(PASSWORD_PREFIX)) {
    saveSettings({ admin_password: hashPassword(storedPassword) });
    console.log("Mot de passe admin migre vers un stockage hache.");
  }
}

function parseJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload trop volumineux."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON invalide."));
      }
    });

    request.on("error", reject);
  });
}

function parseJsonBodyWithRaw(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload trop volumineux."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({ body: {}, raw });
        return;
      }

      try {
        resolve({ body: JSON.parse(raw), raw });
      } catch {
        reject(new Error("JSON invalide."));
      }
    });

    request.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Mots de passe
//
// Le mot de passe etait stocke en clair dans la base : quiconque mettait la
// main sur le fichier .sqlite (ou sur une sauvegarde) entrait dans l'admin.
// On le stocke desormais hache avec scrypt et un sel aleatoire, au format
// "scrypt$<sel hex>$<empreinte hex>". Une valeur qui n'a pas ce prefixe est
// un ancien mot de passe en clair : il reste accepte une derniere fois, puis
// il est immediatement re-enregistre hache (migration transparente).
// ---------------------------------------------------------------------------
const PASSWORD_PREFIX = "scrypt$";

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, 64);
  return `${PASSWORD_PREFIX}${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(plain, stored) {
  const value = String(stored || "");

  if (!value.startsWith(PASSWORD_PREFIX)) {
    // Ancien format en clair. Comparaison a temps constant quand meme : sinon
    // le temps de reponse revele la longueur du prefixe commun.
    return { ok: timingSafeStringEqual(String(plain), value), needsRehash: true };
  }

  const [, saltHex, digestHex] = value.split("$");
  if (!saltHex || !digestHex) return { ok: false, needsRehash: false };

  let derived;
  try {
    derived = crypto.scryptSync(String(plain), Buffer.from(saltHex, "hex"), 64);
  } catch {
    return { ok: false, needsRehash: false };
  }

  const expected = Buffer.from(digestHex, "hex");
  const ok = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  return { ok, needsRehash: false };
}

// ---------------------------------------------------------------------------
// Limitation de debit
//
// Rien ne freinait les appels : le mot de passe admin (4 caracteres par
// defaut) tombait en quelques minutes de force brute, et /api/payments/create,
// non authentifie, ecrivait une photo sur le disque a chaque requete.
// Compteur en memoire par IP : suffisant pour un serveur unique, et remis a
// zero au redemarrage sans consequence.
// ---------------------------------------------------------------------------
const rateBuckets = new Map();

// Adresse du visiteur. X-Forwarded-For n'est cru que si la connexion vient
// d'un proxy local (meme machine ou reseau prive, cas de l'hebergeur), et on
// en prend le DERNIER maillon, celui qu'a ajoute ce proxy. Le premier
// maillon est ecrit par le client lui-meme : s'y fier laissait n'importe qui
// contourner toutes les limites en inventant une adresse a chaque requete.
const ADRESSE_LOCALE = /^(::1$|127\.|::ffff:127\.|10\.|::ffff:10\.|192\.168\.|::ffff:192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.(1[6-9]|2\d|3[01])\.|f[cd])/i;

function getClientIp(request) {
  const directe = request.socket.remoteAddress || "inconnu";
  if (!ADRESSE_LOCALE.test(directe)) return directe;
  const chaine = String(request.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return chaine.length ? chaine[chaine.length - 1] : directe;
}

// Limiteur sur une cle quelconque : sert a compter par ADRESSE EMAIL et pas
// seulement par IP. Sans cela, changer de reseau suffirait a relancer autant
// de codes qu'on veut vers la boite de quelqu'un d'autre.
function rateLimitKey(key, limit, windowMs) {
  const now = Date.now();
  const entry = rateBuckets.get(key);

  if (!entry || now > entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }

  entry.count += 1;
  if (entry.count > limit) {
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }
  return 0;
}

// Renvoie le nombre de secondes a attendre, ou 0 si la requete est autorisee.
//
// Les plafonds PAR IP sont volontairement larges : au Benin, les operateurs
// mobiles font sortir des centaines de telephones par la meme adresse IP. Un
// plafond serre bloquait des inconnus les uns par les autres (le 9e acheteur
// d'une file a l'entree, par exemple). La protection fine se fait par
// e-mail, par badge ou par participant (rateLimitKey).
function rateLimit(request, bucket, limit, windowMs) {
  const key = `${bucket}:${getClientIp(request)}`;
  const now = Date.now();
  const entry = rateBuckets.get(key);

  if (!entry || now > entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }

  entry.count += 1;
  if (entry.count > limit) {
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  return 0;
}

function purgeRateBuckets() {
  const now = Date.now();
  rateBuckets.forEach((entry, key) => {
    if (now > entry.resetAt) rateBuckets.delete(key);
  });
}

function sendRateLimited(response, retryAfter, message) {
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(retryAfter),
  });
  response.end(JSON.stringify({ error: message, retry_after: retryAfter }));
}

function createSession(role = "admin") {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  run("INSERT INTO sessions (token, expires_at, role) VALUES (?, ?, ?)", [token, expiresAt, role]);
  persistDatabase();
  return token;
}

// Routes ouvertes aux postes de scan. Tout le reste de /api/admin/ exige le
// role admin : un telephone pose a l'entree ne doit pas pouvoir lire les cles
// FedaPay ni changer les reglages de l'evenement.
const SCAN_ALLOWED_PATHS = new Set([
  "/api/admin/scan/snapshot",
  "/api/admin/scan/sync",
  "/api/admin/verify-code",
  "/api/admin/mark-item",
]);

// Renvoie le role de la session ("admin", "scan") ou null si le jeton est
// absent, inconnu ou expire.
function getSessionRole(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return null;

  const row = statementGet("SELECT expires_at, role FROM sessions WHERE token = ?", [token]);

  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) {
      run("DELETE FROM sessions WHERE token = ?", [token]);
      persistDatabase();
    }
    return null;
  }

  // Expiration glissante. On n'ecrit sur le disque que si l'echeance a
  // sensiblement bouge : sinon chaque requete de l'admin (rafraichissement
  // toutes les quelques secondes) reecrirait toute la base.
  const nextExpiry = Date.now() + SESSION_TTL_MS;
  if (nextExpiry - Number(row.expires_at) > 60 * 60 * 1000) {
    run("UPDATE sessions SET expires_at = ? WHERE token = ?", [nextExpiry, token]);
    persistDatabase();
  }

  return String(row.role || "admin");
}

function requireAdmin(request) {
  return getSessionRole(request) === "admin";
}

// Nettoyage des reglages ecrits sous leur nom camelCase par l'ancien bug de
// mapping (le serveur ne les a jamais lus). Si une valeur y a ete saisie alors
// que la cle reellement utilisee est restee vide, on la recupere : c'est ce que
// l'organisateur avait voulu enregistrer.
function migrateStraySettingKeys() {
  const settings = getSettings();
  const recovered = [];
  const removed = [];

  Object.entries(SETTINGS_KEY_MAP).forEach(([camelKey, target]) => {
    const strayValue = settings[camelKey];
    if (strayValue === undefined) return;

    const targets = Array.isArray(target) ? target : [target];
    targets.forEach((name) => {
      if (strayValue && !settings[name]) {
        run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [name, strayValue]);
        recovered.push(`${camelKey} -> ${name}`);
      }
    });

    run("DELETE FROM settings WHERE key = ?", [camelKey]);
    removed.push(camelKey);
  });

  if (recovered.length) console.log("Reglages recuperes:", recovered.join(", "));
  if (removed.length) {
    console.log("Cles de reglages obsoletes supprimees:", removed.join(", "));
    persistDatabase();
  }
}

// Les sessions expirees ne servent qu'a faire grossir la base.
function purgeExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]);
  persistDatabase();
}

function hexToRgb(hex) {
  const clean = String(hex || "").trim().replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(255,255,255,${alpha})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

// Numero du jour, base sur la date au Benin et non sur l'heure du serveur :
// la bascule doit se faire a minuit LA-BAS, pas a minuit UTC.
function getDayNumberBenin() {
  return Math.floor(Date.parse(`${getDateKeyBenin()}T00:00:00Z`) / 86400000);
}

// Presets retenus pour la rotation, filtres sur ceux qui existent vraiment.
function getRotationPresets(settings) {
  let liste = [];
  try {
    const parsed = JSON.parse(settings.theme_rotation_json || "[]");
    if (Array.isArray(parsed)) liste = parsed.filter((key) => THEME_PRESETS[key]);
  } catch {}
  // Doublons retires : deux fois la meme palette dans la liste ferait
  // simplement durer cette couleur deux jours, ce qui n'est jamais voulu.
  return [...new Set(liste)];
}

// Le theme effectif = preset choisi, surcharge par les couleurs personnalisees.
function resolveTheme(settings = getSettings()) {
  const rotation = getRotationPresets(settings);

  // Rotation active : le preset du jour l'emporte sur le preset fixe.
  const presetKey = rotation.length >= 2
    ? rotation[((getDayNumberBenin() % rotation.length) + rotation.length) % rotation.length]
    : (THEME_PRESETS[settings.theme_preset] ? settings.theme_preset : DEFAULT_THEME_PRESET);

  const preset = THEME_PRESETS[presetKey];

  let custom = {};
  try {
    const parsed = JSON.parse(settings.theme_custom_json || "{}");
    if (parsed && typeof parsed === "object") custom = parsed;
  } catch {}

  const colors = { ...preset.colors };
  if (rotation.length < 2) {
    Object.keys(preset.colors).forEach((key) => {
      if (hexToRgb(custom[key])) {
        colors[key] = String(custom[key]).trim();
      }
    });
  }

  return {
    preset: presetKey,
    label: preset.label,
    colors,
    rotating: rotation.length >= 2,
    rotation,
  };
}

// Feuille servie a toutes les pages : elle surcharge les :root inline des HTML.
function buildThemeCss(settings = getSettings()) {
  const { colors } = resolveTheme(settings);
  const c = colors;

  return `:root{
  --bg:${c.bg};--bg-2:${c.bg2};
  --green:${c.green};--green-br:${c.greenBr};
  --gold:${c.gold};--gold-lt:${c.goldLt};--gold-dp:${c.goldDp};
  --cream:${c.cream};
  --cream-72:${rgba(c.cream, 0.74)};--cream-52:${rgba(c.cream, 0.52)};--cream-32:${rgba(c.cream, 0.32)};
  --glass:rgba(255,255,255,.05);--glass-2:rgba(255,255,255,.08);
  --stroke:${rgba(c.cream, 0.12)};--stroke-gd:rgba(10,143,79,.5);
  --red:${c.red};
  --surface:${rgba(c.cream, 0.08)};--surface-strong:${rgba(c.cream, 0.12)};--surface-border:rgba(10,143,79,.14);
  --text:${c.cream};--muted:${rgba(c.cream, 0.85)};--sand:${c.goldLt};--bg-soft:${c.bg2};
}
body{background:
  radial-gradient(circle at top left, ${rgba(c.green, 0.22)}, transparent 30%),
  radial-gradient(circle at top right, ${rgba(c.gold, 0.18)}, transparent 24%),
  linear-gradient(180deg, ${c.bg} 0%, ${c.bg2} 45%, ${c.bg} 100%);
  background-attachment:fixed;
}

/* Trois points d'attente, poses par js/chargement.js. La couleur suit celle du
   bouton (currentColor) : ils restent lisibles aussi bien sur un bouton dore a
   texte sombre que sur un bouton fantome a texte clair. */
.pts{display:inline-flex;align-items:center;gap:.4em;height:1em;vertical-align:middle}
.pts i{display:block;width:.44em;height:.44em;border-radius:50%;background:currentColor;
  animation:pts-saut 1.05s ease-in-out infinite}
.pts i:nth-child(2){animation-delay:.14s}
.pts i:nth-child(3){animation-delay:.28s}
/* Saut volontairement court : le mouvement doit signaler l'attente, pas
   attirer l'oeil au point de faire oublier ce qu'on attend. */
@keyframes pts-saut{
  0%,72%,100%{transform:translateY(0);opacity:.42}
  32%{transform:translateY(-.32em);opacity:1}
}
@media (prefers-reduced-motion:reduce){
  .pts i{animation:pts-fondu 1.2s ease-in-out infinite}
  @keyframes pts-fondu{0%,100%{opacity:.32}50%{opacity:1}}
}
`;
}

// Icone de repli quand aucun logo n'a ete televerse : un monogramme genere aux
// couleurs du theme. Evite d'embarquer une image de marque en dur et garde
// l'app installable des le premier jour.
function buildDefaultIcon(settings = getSettings()) {
  const { colors } = resolveTheme(settings);
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const initial = (eventName.trim()[0] || "?").toUpperCase();
  const safeInitial = initial.replace(/[&<>"']/g, "");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${colors.bg2}"/><stop offset="1" stop-color="${colors.bg}"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <circle cx="256" cy="256" r="188" fill="none" stroke="${colors.gold}" stroke-width="12"/>
  <circle cx="256" cy="256" r="132" fill="${colors.green}"/>
  <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
        font-family="Georgia, 'Times New Roman', serif" font-size="150" font-weight="700"
        fill="${colors.cream}">${safeInitial}</text>
</svg>`;
}

// Une URL locale marche sur la machine de dev mais pas pour un client : apres
// paiement, FedaPay renvoie le visiteur sur cette adresse, et "localhost"
// designe alors SON telephone. Il paie et ne recoit jamais son code.
function isPubliclyReachableUrl(value) {
  const url = String(value || "").trim();
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
}

// Etat de preparation de l'evenement. Transforme les erreurs de configuration
// silencieuses (cle absente, URL locale, montant a zero) en liste de controle
// affichee dans l'admin.
function getConfigHealth(settings = getSettings()) {
  const checks = [];
  const add = (level, key, label, detail) => checks.push({ level, key, label, detail });

  const baseUrl = process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
  if (!baseUrl) {
    add("error", "base_url", "Adresse publique du site absente",
      "Sans elle, le participant n'est pas ramené sur le site après son paiement et ne voit jamais son code. À renseigner dans Réglages → Clés & sécurité.");
  } else if (!isPubliclyReachableUrl(baseUrl)) {
    add("error", "base_url", "Adresse publique invalide (adresse locale)",
      `« ${baseUrl} » ne fonctionne que sur cet ordinateur. Après paiement, le participant serait renvoyé vers son propre téléphone et ne verrait jamais son code. Mets l'adresse publique du site (https://…).`);
  } else {
    add("ok", "base_url", "Adresse publique configurée", baseUrl);
  }

  const secretKey = process.env.FEDAPAY_SECRET_KEY || settings.payment_secret_key || "";
  if (!secretKey) {
    add("error", "payment_key", "Clé de paiement absente", "Aucun paiement n'est possible.");
  } else if (!/^sk_/.test(secretKey) || secretKey.length < 28) {
    add("error", "payment_key", "Clé de paiement invalide",
      "Elle ne ressemble pas à une clé FedaPay complète (sk_… d'environ 33 caractères). Les paiements seront refusés.");
  } else {
    add("ok", "payment_key", "Clé de paiement présente", null);
  }

  const environment = process.env.FEDAPAY_ENVIRONMENT || settings.payment_environment || "sandbox";
  if (environment === "live") {
    add("ok", "environment", "Environnement de paiement : production", null);
  } else {
    add("warn", "environment", "Environnement de paiement : test (sandbox)",
      "Les paiements ne sont pas réels. À basculer sur « live » avant l'événement.");
  }

  if (!getFedapayWebhookSecret(settings)) {
    add("warn", "webhook", "Secret webhook absent",
      "Les notifications de paiement ne sont pas signées. Le serveur revérifie chaque paiement auprès de FedaPay, donc ce n'est pas bloquant, mais c'est recommandé.");
  } else {
    add("ok", "webhook", "Secret webhook configuré", null);
  }

  const resendKey = process.env.RESEND_API_KEY || settings.resend_api_key || "";
  if (!resendKey) {
    add("warn", "email", "Envoi d'emails non configuré",
      "Les participants ne recevront pas leur code par email. Ils le verront à l'écran après paiement.");
  } else if (resendKey.length < 20) {
    add("warn", "email", "Clé email probablement incomplète", "Les emails risquent de ne pas partir.");
  } else {
    add("ok", "email", "Envoi d'emails configuré", null);
  }

  const amount = Number(settings.participation_fee);
  if (!Number.isFinite(amount) || amount <= 0) {
    add("error", "amount", "Montant de participation invalide", "Renseigne un montant supérieur à zéro.");
  } else {
    add("ok", "amount", `Montant : ${formatMontant(amount)}`, null);
  }

  if (!settings.pickup_location) {
    add("warn", "pickup", "Lieu de retrait non renseigné", "Il apparaît sur le badge et dans l'email.");
  } else {
    add("ok", "pickup", `Lieu : ${settings.pickup_location}`, null);
  }

  // Sans date, le compte à rebours de la page d'accueil reste bloqué sur
  // 00:00:00:00, ce qui donne l'impression d'un site en panne.
  const eventDate = resolveEventDate(settings);
  const parsedDate = eventDate ? new Date(eventDate) : null;
  if (!eventDate) {
    add("warn", "date", "Date de l'événement non renseignée",
      "Le compte à rebours de la page d'accueil affiche 00:00:00:00, ce qui fait croire à un site en panne.");
  } else if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
    add("warn", "date", "Date de l'événement illisible",
      `« ${eventDate} » n'est pas une date valide. Format attendu : 2026-12-28T09:00:00`);
  } else if (parsedDate.getTime() < Date.now()) {
    add("warn", "date", "Date de l'événement déjà passée",
      "Le compte à rebours restera à zéro sur la page d'accueil.");
  } else {
    add("ok", "date", `Date : ${parsedDate.toLocaleString("fr-FR")}`, null);
  }

  if (!settings.event_date_label) {
    add("warn", "date_label", "Date affichée non renseignée", "Le bloc « Date » de la page d'accueil reste vide.");
  } else {
    add("ok", "date_label", `Date affichée : ${settings.event_date_label}`, null);
  }

  // Le mot de passe etant desormais hache, on ne peut plus mesurer sa
  // longueur : on teste s'il vaut encore le defaut de premiere installation.
  if (isDemoMode(settings)) {
    add("error", "demo", "MODE DÉMONSTRATION ACTIF",
      "Les inscriptions sont validées sans aucun paiement : n'importe qui obtient un code gratuitement. À couper avant l'ouverture des inscriptions.");
  }

  const adminPassword = settings.admin_password || "";
  if (!adminPassword) {
    add("error", "password", "Aucun mot de passe administrateur",
      "L'admin et la liste des participants sont accessibles à tout le monde.");
  } else if (verifyPassword(DEFAULT_SETTINGS.admin_password, adminPassword).ok) {
    add("error", "password", "Mot de passe administrateur encore par défaut",
      "Il vaut toujours « admin ». Change-le maintenant : il protège la liste des participants, les clés de paiement et l'app de scan.");
  } else {
    add("ok", "password", "Mot de passe administrateur personnalisé", null);
  }

  // Le logo sert de sceau au centre du QR du badge. Un PNG est reduit
  // automatiquement ; un SVG ne passe pas dans le PDF, et un JPEG trop lourd
  // est ecarte pour ne pas alourdir chaque badge envoye par e-mail.
  const logoFile = localFileFromUrl(settings.logo_url);
  if (logoFile) {
    if (getTicketLogoPath(settings)) {
      add("ok", "logo_poids", "Logo placé au centre du QR du badge", null);
    } else {
      const raison = /\.svg$/i.test(logoFile)
        ? "Un logo SVG ne peut pas être intégré au badge PDF."
        : `Ce JPEG dépasse ${Math.round(MAX_TICKET_LOGO_BYTES / 1024)} Ko.`;
      add("warn", "logo_poids", "Logo absent du centre du QR du badge",
        `${raison} Réimporte-le en PNG depuis Apparence : il sera réduit automatiquement.`);
    }
  }

  // Moyen d'envoi. Sans lui, ni le billet ni le code de recuperation ne
  // partent : c'est bloquant, pas cosmetique.
  const cfgSmtp = mail.getSmtpConfig(settings);
  const cleResend = process.env.RESEND_API_KEY || settings.resend_api_key || "";
  if (cfgSmtp) {
    add("ok", "mail", `Envoi par SMTP (${cfgSmtp.host}:${cfgSmtp.port})`, null);
  } else if (cleResend && !/X{3,}/i.test(cleResend)) {
    add("warn", "mail", "Envoi par Resend, pas par la boîte du domaine",
      "Fonctionne, mais les messages ne partent pas de ton propre domaine. Renseigne le SMTP pour une identité d'expéditeur cohérente.");
  } else {
    add("error", "mail", "Aucun moyen d'envoi d'e-mail",
      "Ni SMTP ni clé Resend. Le badge et le code de récupération ne partiront pas.");
  }

  if (!String(settings.alert_email || process.env.MAIL_ALERT_TO || "").trim()) {
    add("warn", "alert_email", "Aucune adresse d'alerte interne",
      "Tu ne recevras pas d'e-mail à chaque inscription payée. À renseigner dans Réglages.");
  } else {
    add("ok", "alert_email", "Alertes internes activées", null);
  }

  if (!settings.scan_password) {
    add("warn", "scan_password", "Pas de mot de passe dédié au scan",
      "Les téléphones à l'entrée se connectent avec le mot de passe administrateur : chacun peut alors lire les clés de paiement. Définis-en un séparé.");
  } else {
    add("ok", "scan_password", "Mot de passe de scan distinct", null);
  }

  let eventItems = [];
  try { eventItems = JSON.parse(settings.event_items_json || "[]"); } catch {}
  if (!eventItems.length) {
    add("warn", "items", "Aucun élément à remettre configuré",
      "La checklist du jour J (bracelet, kit…) sera vide lors des scans.");
  } else {
    add("ok", "items", `${eventItems.length} élément(s) à remettre`, null);
  }

  return {
    ready: !checks.some((check) => check.level === "error"),
    errors: checks.filter((check) => check.level === "error").length,
    warnings: checks.filter((check) => check.level === "warn").length,
    checks,
  };
}

// Reglages qui ne doivent jamais repartir vers le navigateur en clair. Le
// tableau de bord admin les affichait tels quels : un poste laisse ouvert, une
// capture d'ecran ou un cache de navigateur suffisait a livrer la cle FedaPay.
const SECRET_SETTING_KEYS = [
  "admin_password",
  "scan_password",
  "payment_secret_key",
  "payment_public_key",
  "fedapay_webhook_secret",
  "resend_api_key",
  "smtp_password",
  "wachap_access_token",
  "wachap_instance_id",
];

// Marqueur renvoye a la place du secret. L'admin le reaffiche tel quel ; s'il
// nous revient inchange au moment d'enregistrer, on sait qu'il ne faut pas
// ecraser la vraie valeur.
const SECRET_MASK = "********";

function maskSecretSettings(settings) {
  const masked = { ...settings };
  SECRET_SETTING_KEYS.forEach((name) => {
    if (masked[name]) masked[name] = SECRET_MASK;
  });
  // Le tableau de bord a besoin de savoir si un secret est renseigne, sans
  // connaitre sa valeur : c'est ce que sert cette carte de presence.
  masked.secrets_defined = SECRET_SETTING_KEYS.reduce((accumulator, name) => {
    accumulator[name] = Boolean(settings[name]);
    return accumulator;
  }, {});
  return masked;
}

// Date effective de l'evenement.
//
// Pour une fete annuelle, la date saisie ne sert que de MOIS et JOUR : on
// renvoie la prochaine occurrence a venir. Sans cela, le compte a rebours
// passerait a zero le 16 aout et y resterait onze mois, ce qui donne un site
// a l'abandon.
function resolveEventDate(settings = getSettings()) {
  const brut = String(settings.event_date || "").trim();
  if (!brut) return "";

  const base = new Date(brut);
  if (Number.isNaN(base.getTime())) return brut;

  if (String(settings.event_annual || "0") !== "1") return brut;

  // Comparaison a la date du Benin, pas a l'heure du serveur : c'est la-bas
  // que la fete a lieu.
  const aujourdHui = getDatePartsBenin();
  const anneeCourante = Number(aujourdHui.year);

  const mois = String(base.getMonth() + 1).padStart(2, "0");
  const jour = String(base.getDate()).padStart(2, "0");
  const heure = brut.includes("T") ? brut.slice(brut.indexOf("T")) : "T09:00:00";

  const candidat = `${anneeCourante}-${mois}-${jour}${heure}`;

  // Une occurrence deja passee bascule sur l'annee suivante. On compare des
  // dates seules : le jour meme de la fete, le compte a rebours doit encore
  // viser aujourd'hui et non l'an prochain.
  const cleJour = `${anneeCourante}-${mois}-${jour}`;
  const cleAujourdHui = `${aujourdHui.year}-${aujourdHui.month}-${aujourdHui.day}`;

  if (cleJour < cleAujourdHui) {
    return `${anneeCourante + 1}-${mois}-${jour}${heure}`;
  }
  return candidat;
}

// Media de l'en-tete, tel que la page doit l'afficher. On renvoie le TYPE en
// plus de l'URL : la page doit choisir entre <img> et <video>, et deviner
// depuis l'extension cote client serait fragile.
function buildHeroMedia(settings) {
  const url = String(settings.hero_media_url || "").trim();
  if (!url) return null;

  // Interrupteur : le fichier reste sur le disque, il n'est simplement plus
  // affiche. Supprimer le media pour revenir a l'ancien fond obligerait a le
  // reimporter pour faire marche arriere.
  if (String(settings.hero_media_active || "1") !== "1") return null;

  // Voile : borne entre 20 et 99. En dessous de 20 le texte devient illisible
  // sur un media clair ; 99 plutot que 100 pour qu'un reste de mouvement du
  // media transparaisse toujours derriere le voile.
  const brut = Number(settings.hero_media_veil);
  const veil = Number.isFinite(brut) ? Math.min(99, Math.max(20, Math.round(brut))) : 70;
  const extension = (url.split("?")[0].match(/\.(\w+)$/) || [])[1] || "";
  return {
    url,
    type: extension.toLowerCase() === "gif" ? "image" : "video",
    veil,
  };
}

function publicSettings(settings = getSettings()) {
  let chiefs = [], sponsors = [], eventItems = [], artists = [];
  try { chiefs = JSON.parse(settings.chiefs_json || "[]"); } catch {}
  try { sponsors = JSON.parse(settings.sponsors_json || "[]"); } catch {}
  try { eventItems = JSON.parse(settings.event_items_json || "[]"); } catch {}
  try { artists = JSON.parse(settings.artists_json || "[]"); } catch {}
  return {
    eventName:   settings.event_name     || DEFAULT_SETTINGS.event_name,
    amount:      Number(settings.participation_fee) || 10000,
    currency:    "XOF",
    accountName: settings.moov_nom || settings.mtn_nom || "",
    lieu:        settings.pickup_location || "À confirmer",
    dateLabel:   settings.event_date_label || "",
    eventDate:   resolveEventDate(settings),
    moovNumber:  settings.moov_numero || "",
    mtnNumber:   settings.mtn_numero || "",
    waLink:      settings.wa_link || "",
    email:       settings.vendeur_email || "",
    tiktokUrl:   settings.tiktok_guide_url || "",
    logoUrl:     settings.logo_url || "",
    // Ce que la toile du navigateur doit savoir pour dessiner le meme badge
    // que le PDF : memes textes, meme sceau (la version reduite du logo).
    badge:       Object.assign(textesBadge(settings), {
      sceauUrl: urlSceauBadge(settings),
      bascule: settings.badge_bascule || BadgeLayout.BASCULE_DEFAUT,
    }),
    demoMode:    isDemoMode(settings),
    // Le formulaire s'en sert pour savoir quel chemin proposer selon le pays.
    paiementDirect: {
      pays: paysPaiementDirect(settings),
      operateurs: Object.entries(OPERATEURS_DIRECTS).map(([code, o]) => ({ code, label: o.label })),
    },
    heroMedia:   buildHeroMedia(settings),
    theme:       resolveTheme(settings),
    chiefs,
    sponsors,
    eventItems,
    artists,
    artistsLayout: ARTISTS_LAYOUTS.includes(settings.artists_layout) ? settings.artists_layout : ARTISTS_LAYOUTS[0],
    artistsAnimation: ARTISTS_ANIMATIONS.includes(settings.artists_animation) ? settings.artists_animation : ARTISTS_ANIMATIONS[0],
    scrollAnimation: SCROLL_ANIMATIONS.includes(settings.scroll_animation) ? settings.scroll_animation : SCROLL_ANIMATIONS[0],
  };
}

function getDatePartsBenin(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return parts.reduce((accumulator, part) => {
    if (part.type !== "literal") {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});
}

function getDateKeyBenin() {
  const parts = getDatePartsBenin();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateFormatee() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function formatMontant(value) {
  return `${Number(value || 0).toLocaleString("fr-FR")} FCFA`;
}

function normalizePhoneNumber(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function getParticipationAmount(settings) {
  const raw = Number(settings.participation_fee);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

/* Operateurs joignables sans redirection.
 *
 * La route est le segment d'API de l'operateur chez FedaPay : on y poste le
 * jeton de la transaction et le numero, et le client recoit la demande sur son
 * telephone. Si l'un de ces noms changeait, la creation retomberait d'elle-meme
 * sur la page hebergee (voir /api/payments/create) : personne ne reste bloque.
 */
const OPERATEURS_DIRECTS = {
  mtn:     { label: "MTN",     route: "mtn_open" },
  moov:    { label: "Moov",    route: "moov" },
  celtiis: { label: "Celtiis", route: "celtiis_bj" },
};

/* Pays qui paient sans quitter le site. */
function paysPaiementDirect(settings) {
  if (String(settings.paiement_direct_actif || "1") !== "1") return [];
  return String(settings.paiement_direct_pays || "")
    .split(/[,;\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

function paiementDirectPossible(pays, operateur, settings) {
  if (!OPERATEURS_DIRECTS[operateur]) return false;
  return paysPaiementDirect(settings).includes(String(pays || "").toUpperCase());
}

/* Envoie la demande de paiement sur le telephone du client.
 *
 * Le numero part sans indicatif : FedaPay attend le numero local et le pays
 * separement. Coller les deux ferait echouer la demande sans message clair.
 */
async function demanderPaiementMobile(settings, jeton, operateur, telephone, pays) {
  const op = OPERATEURS_DIRECTS[operateur];
  if (!op) throw new Error("Operateur inconnu.");

  const numero = String(telephone || "").replace(/\D/g, "");
  if (numero.length < 8) throw new Error("Numero de telephone invalide.");

  return fedapayRequest(settings, "POST", `/${op.route}`, {
    token: jeton,
    phone_number: { number: numero, country: String(pays || "BJ").toLowerCase() },
  });
}

function getOperatorMeta(settings, operator) {
  if (operator === "mtn") {
    return {
      code: "mtn",
      shortLabel: "MTN",
      holder: settings.mtn_nom || "",
      number: settings.mtn_numero || "",
    };
  }

  return {
    code: "moov",
    shortLabel: "Moov",
    holder: settings.moov_nom || "",
    number: settings.moov_numero || "",
  };
}

// L'identifiant sert de reference dans l'URL de retour de paiement, et
// /api/payments/status renvoie le code d'entree a qui le presente. Avec les
// 5 chiffres tires par Math.random() d'avant, il n'y avait que 100 000
// combinaisons par jour : on pouvait toutes les essayer et recolter les codes
// de tous les participants. On passe donc a 12 caracteres tires par le
// generateur cryptographique, soit un espace hors d'atteinte.
// Nombre de billets qu'un seul achat peut couvrir. Au-dela on n'est plus dans
// l'achat entre proches mais dans la vente de groupe, qui doit passer par
// l'organisation : elle seule peut verifier autant d'identites a l'entree.
const MAX_BILLETS_PAR_ACHAT = 10;

function generateParticipantId() {
  const dateKey = getDateKeyBenin().replace(/-/g, "");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symboles, sans O/0/I/1

  for (let index = 0; index < 12; index += 1) {
    const bytes = crypto.randomBytes(12);
    let random = "";
    // 256 est un multiple de 32 : le modulo ne favorise aucun symbole.
    bytes.forEach((value) => { random += alphabet[value % alphabet.length]; });

    const id = `WLA-${dateKey}-${random}`;
    if (!statementGet("SELECT id FROM participants WHERE id = ?", [id])) {
      return id;
    }
  }

  throw new Error("Impossible de generer un identifiant participant.");
}

// Codes deja tires par ce processus. Entre le tirage et l'ecriture en base, la
// creation du QR rend la main : deux achats valides au meme moment ne doivent
// pas pouvoir tirer le meme code avant que l'un l'ait enregistre.
const codesTires = new Set();

function generateUniqueCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    const bytes = crypto.randomBytes(6);
    bytes.forEach((value) => {
      code += alphabet[value % alphabet.length];
    });

    if (!codesTires.has(code) && !statementGet("SELECT id FROM participants WHERE code_unique = ?", [code])) {
      codesTires.add(code);
      return code;
    }
  }

  throw new Error("Impossible de generer un code unique.");
}

// Supprime les fichiers deja ecrits pour ce participant dans ce dossier. Sans
// cela, chaque nouvel enregistrement laissait l'ancienne image en place, donc
// une accumulation sur le disque et une photo perimee toujours accessible.
function removeStaleUploads(targetDir, filenamePrefix) {
  try {
    if (!fs.existsSync(targetDir)) return;
    fs.readdirSync(targetDir)
      .filter((name) => name.startsWith(`${filenamePrefix}-`) || name.startsWith(`${filenamePrefix}.`))
      .forEach((name) => {
        try { fs.unlinkSync(path.join(targetDir, name)); } catch {}
      });
  } catch {}
}

function saveImageUpload(dataUrl, targetDir, filenamePrefix, errorLabel) {
  const match = String(dataUrl || "").match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/);
  if (!match) {
    throw new Error(`${errorLabel} invalide.`);
  }

  const extension = match[1].includes("png") ? "png" : match[1].includes("webp") ? "webp" : "jpg";
  const bytes = Buffer.from(match[2], "base64");

  if (!bytes.length || bytes.length > MAX_BODY_BYTES) {
    throw new Error(`${errorLabel} trop volumineuse.`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  removeStaleUploads(targetDir, filenamePrefix);
  // Un nom base sur le seul identifiant participant (WLA-20260906-00042) se
  // devine : on pouvait parcourir /uploads/participants/ et recuperer les
  // photos de tout le monde sans etre connecte. Le suffixe aleatoire rend
  // l'URL impossible a trouver autrement qu'en etant admin.
  const filename = `${filenamePrefix}-${crypto.randomBytes(12).toString("hex")}.${extension}`;
  const filePath = path.join(targetDir, filename);
  fs.writeFileSync(filePath, bytes);
  return `/uploads/${path.basename(targetDir)}/${filename}`;
}

function saveReceiptProof(dataUrl, participantId) {
  return saveImageUpload(dataUrl, UPLOADS_DIR, participantId, "Preuve de paiement");
}

function saveParticipantPhoto(dataUrl, participantId) {
  return saveImageUpload(dataUrl, PARTICIPANT_PHOTOS_DIR, participantId, "Photo du participant");
}

// Efface le logo reduit du badge : sans cela, le badge continuerait
// d'afficher l'ancien logo apres un remplacement.
function clearTicketCache() {
  const f = path.join(BRANDING_DIR, TICKET_LOGO_CACHE);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

// Enregistre le passage a l'edition suivante des que le jour de bascule est
// passe. Le dessin l'applique deja de lui-meme (textesBadge) ; l'ecrire en
// base garde l'admin coherent : il affiche l'annee et l'edition reellement
// imprimees, et une retouche ne repart pas d'une annee perimee.
function appliquerBasculeBadge() {
  try {
    const settings = getSettings();
    const D = BadgeLayout.DEFAUTS;
    const anneeEnregistree = String(settings.badge_annee || "").trim() || D.annee;
    const enCours = textesBadge(settings);
    if (enCours.annee === anneeEnregistree) return false;

    saveSettings({
      badge_annee: enCours.annee,
      badge_edition: enCours.edition,
      badge_dates: enCours.dates,
    });
    console.log(`Badge : passage a l'edition ${enCours.edition} (${enCours.annee}).`);
    // Les jours du festival changent d'une annee a l'autre : l'organisation
    // doit les verifier, le changement d'annee seul ne suffit pas toujours.
    sendInternalAlert(
      `Badge : passage à l'édition ${enCours.edition}`,
      [["Année", enCours.annee], ["Édition", enCours.edition], ["Dates imprimées", enCours.dates.replace(/\*\*/g, "")]],
      getSettings(),
      "Vérifie les jours dans Admin → Réglages → Badge : seule l'année a été changée automatiquement.",
    ).catch(() => {});
    return true;
  } catch (error) {
    console.warn("Passage a l'edition suivante impossible:", error.message);
    return false;
  }
}

// Adresse du sceau du QR (logo reduit) pour la toile du navigateur. Le logo
// d'origine pese plus d'un Mo : le recharger a chaque badge affiche coutait
// cher en donnees mobiles. Version = date du fichier, pour suivre un
// remplacement malgre les caches.
function urlSceauBadge(settings) {
  const chemin = getTicketLogoPath(settings);
  if (!chemin) return "";
  try {
    const relatif = path.relative(ROOT, chemin).split(path.sep).join("/");
    return `/${relatif}?v=${Math.round(fs.statSync(chemin).mtimeMs)}`;
  } catch {
    return "";
  }
}

// Le logo accepte aussi le SVG, contrairement aux autres uploads. Le nom de
// fichier est stable, donc on suffixe une version pour casser les caches.
function saveBrandingLogo(dataUrl, base = "logo", autoriserSvg = true) {
  const motif = autoriserSvg
    ? /^data:(image\/(?:jpeg|jpg|png|webp|svg\+xml));base64,(.+)$/
    : /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/;
  const match = String(dataUrl || "").match(motif);
  if (!match) {
    throw new Error(`Image invalide. Formats acceptes : PNG, JPG, WEBP${autoriserSvg ? ", SVG" : ""}.`);
  }

  const mime = match[1];
  const extension = mime.includes("svg") ? "svg" : mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const bytes = Buffer.from(match[2], "base64");

  if (!bytes.length || bytes.length > MAX_BODY_BYTES) {
    throw new Error("Logo trop volumineux (5 Mo maximum).");
  }

  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  // On purge les anciennes extensions pour ne pas laisser d'image orpheline.
  ["png", "jpg", "webp", "svg"].forEach((ext) => {
    const stale = path.join(BRANDING_DIR, `${base}.${ext}`);
    if (ext !== extension && fs.existsSync(stale)) {
      try { fs.unlinkSync(stale); } catch {}
    }
  });

  fs.writeFileSync(path.join(BRANDING_DIR, `${base}.${extension}`), bytes);
  return `/uploads/branding/${base}.${extension}?v=${Date.now()}`;
}

// Media de fond de l'en-tete. Separe de saveBrandingLogo : les formats
// acceptes n'ont rien a voir, et une video ne peut pas etre reduite cote
// navigateur comme on le fait pour les images.
const HERO_MEDIA_FORMATS = {
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

// 12 Mo : au-dela, le visiteur en donnees mobiles paie l'en-tete plus cher que
// tout le reste du site. Le format MP4 pese environ dix fois moins qu'un GIF
// de meme duree, c'est ce qu'il faut privilegier.
const MAX_HERO_MEDIA_BYTES = 12 * 1024 * 1024;

function saveHeroMedia(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/gif|video\/mp4|video\/webm);base64,(.+)$/);
  if (!match) {
    throw new Error("Format non accepté. Choisis un GIF, un MP4 ou un WEBM.");
  }

  const extension = HERO_MEDIA_FORMATS[match[1]];
  const bytes = Buffer.from(match[2], "base64");

  if (!bytes.length) throw new Error("Fichier vide.");
  if (bytes.length > MAX_HERO_MEDIA_BYTES) {
    throw new Error(`Fichier trop lourd (${Math.round(bytes.length / 1048576)} Mo). Maximum 12 Mo.`);
  }

  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  // On purge les autres extensions : sinon un ancien GIF resterait a cote du
  // nouveau MP4 et continuerait d'etre servi selon l'ordre de lecture.
  Object.values(HERO_MEDIA_FORMATS).forEach((ext) => {
    const vieux = path.join(BRANDING_DIR, `hero-media.${ext}`);
    if (ext !== extension && fs.existsSync(vieux)) {
      try { fs.unlinkSync(vieux); } catch {}
    }
  });

  fs.writeFileSync(path.join(BRANDING_DIR, `hero-media.${extension}`), bytes);
  return {
    url: `/uploads/branding/hero-media.${extension}?v=${Date.now()}`,
    type: extension === "gif" ? "image" : "video",
    octets: bytes.length,
  };
}

function removeHeroMedia() {
  Object.values(HERO_MEDIA_FORMATS).forEach((ext) => {
    const cible = path.join(BRANDING_DIR, `hero-media.${ext}`);
    if (fs.existsSync(cible)) {
      try { fs.unlinkSync(cible); } catch {}
    }
  });
}

function removeBrandingLogo(base = "logo") {
  ["png", "jpg", "webp", "svg"].forEach((ext) => {
    const target = path.join(BRANDING_DIR, `${base}.${ext}`);
    if (fs.existsSync(target)) {
      try { fs.unlinkSync(target); } catch {}
    }
  });
}

// Chemin sur disque d'une image servie par une URL du site, ou null. Utilisee
// ici pour le controle de sante de la config (logo trop lourd) ; la version
// dont se sert la construction du badge vit desormais dans lib/ticket-pdf.js.
function localFileFromUrl(url) {
  const clean = String(url || "").split("?")[0].replace(/^\/+/, "");
  if (!clean) return null;
  const filePath = path.join(ROOT, clean);
  // Ne jamais sortir de uploads/ : cette fonction recoit une valeur de reglage.
  if (!filePath.startsWith(path.join(ROOT, "uploads"))) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

// ---------------------------------------------------------------------------
// Badge PDF
//
// La construction elle-meme (pdfkit) vit dans lib/ticket-pdf.js, executee
// dans des threads separes : elle est synchrone, et executee ici dans le
// thread principal elle gelerait tout le site pendant qu'un badge se dessine.
//
// Plusieurs threads, pas un seul : un badge coute ~75 ms de calcul, et a 50
// paiements simultanes (badges des e-mails + telechargements), une file
// unique faisait attendre le dernier plus de 7 s. Chaque thread est relance
// automatiquement s'il plante.
// ---------------------------------------------------------------------------
const TAILLE_POOL_PDF = Math.max(1, Math.min(3, os.cpus().length - 1));
const poolPdf = Array.from({ length: TAILLE_POOL_PDF }, () => ({ worker: null, enAttente: new Map() }));
let ticketWorkerReqId = 0;

function lancerThreadPdf(place) {
  const worker = new Worker(path.join(__dirname, "lib", "ticket-pdf-worker.js"));

  worker.on("message", (msg) => {
    const pending = place.enAttente.get(msg.id);
    if (!pending) return;
    place.enAttente.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(Buffer.from(msg.buffer));
  });

  // Le thread ne repondra plus : ses demandes en attente echouent, et la
  // prochaine demande en relancera un neuf a cette place.
  const abandonner = (error) => {
    for (const pending of place.enAttente.values()) pending.reject(error);
    place.enAttente.clear();
    if (place.worker === worker) place.worker = null;
  };
  worker.on("error", (error) => {
    console.error("Thread badge PDF en erreur:", error.message);
    abandonner(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) console.warn(`Thread badge PDF arrete (code ${code}), relance a la prochaine demande.`);
    abandonner(new Error("Thread badge PDF arrete."));
  });

  place.worker = worker;
}

function demarrerPoolPdf() {
  poolPdf.forEach((place) => { if (!place.worker) lancerThreadPdf(place); });
}

function renderTicketPdf(participant, settings = getSettings()) {
  // Le thread le moins charge prend la demande.
  const place = poolPdf.reduce((a, b) => (b.enAttente.size < a.enAttente.size ? b : a));
  if (!place.worker) lancerThreadPdf(place);

  const id = ++ticketWorkerReqId;
  return new Promise((resolve, reject) => {
    place.enAttente.set(id, { resolve, reject });
    place.worker.postMessage({ id, participant, settings });
  });
}

async function saveQrCode(code, participantId) {
  fs.mkdirSync(QRCODES_DIR, { recursive: true });
  // Meme raison que pour les photos, en plus grave : le QR encode le code
  // d'entree. Un nom previsible laissait deviner des billets valides.
  removeStaleUploads(QRCODES_DIR, participantId);
  const filename = `${participantId}-${crypto.randomBytes(12).toString("hex")}.png`;
  const filePath = path.join(QRCODES_DIR, filename);
  const buffer = await QRCode.toBuffer(code, {
    errorCorrectionLevel: "M",
    margin: 2,
    // 512 et non 360 : affiche sur 150 points dans le billet, il faut de la
    // marge pour rester net a l'impression. Un QR compresse tres bien, le
    // surcout en octets est negligeable.
    width: 512,
    type: "png",
  });
  fs.writeFileSync(filePath, buffer);
  return `/uploads/qrcodes/${filename}`;
}

function insertParticipant(participant) {
  run(
    `
      INSERT INTO participants (
        id, evenement, nom, telephone, whatsapp, email, montant, montant_valeur, paiement,
        operateur_paiement_code, operateur_paiement, nom_paiement, numero_paiement,
        preuve_paiement, preuve_url, capture_b64, participant_photo_url, statut_paiement, code_unique, statut_code,
        fedapay_transaction_id, fedapay_customer_id, fedapay_reference, fedapay_status, qr_code_url,
        lieu_retrait, date, date_key, timestamp, validation_at, retrait_effectue_at,
        groupe_id, groupe_index, groupe_taille
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `,
    [
      participant.id,
      participant.evenement,
      participant.nom,
      participant.telephone,
      participant.whatsapp,
      participant.email,
      participant.montant,
      participant.montant_valeur,
      participant.paiement,
      participant.operateur_paiement_code,
      participant.operateur_paiement,
      participant.nom_paiement,
      participant.numero_paiement,
      participant.preuve_paiement,
      participant.preuve_url,
      participant.capture_b64,
      participant.participant_photo_url,
      participant.statut_paiement,
      participant.code_unique,
      participant.statut_code,
      participant.fedapay_transaction_id,
      participant.fedapay_customer_id,
      participant.fedapay_reference,
      participant.fedapay_status,
      participant.qr_code_url,
      participant.lieu_retrait,
      participant.date,
      participant.date_key,
      participant.timestamp,
      participant.validation_at,
      participant.retrait_effectue_at,
      participant.groupe_id || null,
      participant.groupe_index || null,
      participant.groupe_taille || null,
    ],
  );
  persistDatabase();
}

function getParticipantById(id) {
  return statementGet("SELECT * FROM participants WHERE id = ?", [id]);
}

function getParticipantByFedapayTransactionId(transactionId) {
  return statementGet("SELECT * FROM participants WHERE fedapay_transaction_id = ?", [String(transactionId)]);
}

function getWebhookEventById(id) {
  return statementGet("SELECT id FROM webhook_events WHERE id = ?", [String(id)]);
}

function insertWebhookEvent(event) {
  run(
    "INSERT INTO webhook_events (id, type, object_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    [event.id, event.type, event.object_id, event.payload, event.created_at],
  );
  persistDatabase();
}

function getParticipantByCode(code) {
  return statementGet("SELECT * FROM participants WHERE code_unique = ?", [code]);
}

function getParticipants() {
  return statementAll("SELECT * FROM participants ORDER BY timestamp DESC");
}

function getStats(participants = getParticipants()) {
  return {
    total: participants.length,
    attente: participants.filter(
      (participant) => participant.statut_paiement !== "Valide" && participant.statut_code !== "utilise",
    ).length,
    actifs: participants.filter((participant) => participant.statut_code === "actif").length,
    utilises: participants.filter((participant) => participant.statut_code === "utilise").length,
  };
}

// ---------------------------------------------------------------------------
// Statistiques
//
// Tout est calcule ici plutot que dans le navigateur : l'admin telecharge
// deja la liste complete, mais les agregats doivent etre les memes pour tout
// le monde et survivre a un futur affichage ailleurs (export, email...).
// ---------------------------------------------------------------------------

// Cle de jour au format AAAA-MM-JJ pour un horodatage, en heure du Benin.
function dayKeyFromTimestamp(ms) {
  if (!ms) return null;
  const d = getDatePartsBenin(new Date(Number(ms)));
  if (!d.year) return null;
  return `${d.year}-${d.month}-${d.day}`;
}

function buildStats(settings = getSettings()) {
  const participants = getParticipants();
  const montantUnitaire = getParticipationAmount(settings);

  let eventItems = [];
  try { eventItems = JSON.parse(settings.event_items_json || "[]"); } catch {}

  const valides = participants.filter((p) => p.statut_paiement === "Valide");
  const utilises = valides.filter((p) => p.statut_code === "utilise");
  const demo = participants.filter((p) => String(p.paiement || "") === DEMO_PAYMENT_TAG);

  // Compteurs par cle, tries par valeur decroissante.
  const compter = (liste, cle) => {
    const carte = new Map();
    liste.forEach((p) => {
      const k = cle(p);
      if (!k) return;
      carte.set(k, (carte.get(k) || 0) + 1);
    });
    return [...carte.entries()].sort((a, b) => b[1] - a[1]);
  };

  // Serie journaliere : on remplit TOUS les jours entre la premiere et la
  // derniere inscription, y compris ceux a zero. Sans cela, un graphique
  // sauterait les jours creux et laisserait croire a une activite continue.
  const jours = new Map();
  participants.forEach((p) => {
    const j = dayKeyFromTimestamp(p.timestamp);
    if (!j) return;
    if (!jours.has(j)) jours.set(j, { date: j, inscriptions: 0, validations: 0 });
    jours.get(j).inscriptions += 1;
  });
  valides.forEach((p) => {
    const j = dayKeyFromTimestamp(p.validation_at || p.timestamp);
    if (!j) return;
    if (!jours.has(j)) jours.set(j, { date: j, inscriptions: 0, validations: 0 });
    jours.get(j).validations += 1;
  });

  let parJour = [...jours.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (parJour.length > 1) {
    const complet = [];
    const debut = Date.parse(`${parJour[0].date}T00:00:00Z`);
    const fin = Date.parse(`${parJour[parJour.length - 1].date}T00:00:00Z`);
    for (let t = debut; t <= fin; t += 86400000) {
      const j = new Date(t).toISOString().slice(0, 10);
      complet.push(jours.get(j) || { date: j, inscriptions: 0, validations: 0 });
    }
    // Au-dela de 60 jours le graphique devient illisible : on garde la fin.
    parJour = complet.slice(-60);
  }

  // Scans par heure, toutes journees confondues : sert a reperer l'affluence
  // a l'entree et a dimensionner les postes de controle.
  const heures = Array.from({ length: 24 }, (_, h) => ({ heure: h, scans: 0 }));
  utilises.forEach((p) => {
    if (!p.retrait_effectue_at) return;
    const h = Number(getDatePartsBenin(new Date(Number(p.retrait_effectue_at))).hour);
    if (Number.isFinite(h)) heures[h].scans += 1;
  });

  // Elements remis : on compte les cases cochees, item par item.
  const remis = eventItems.map((item) => ({ id: item.id, name: item.name || item.id, n: 0 }));
  valides.forEach((p) => {
    let recus = {};
    try { recus = JSON.parse(p.items_received || "{}"); } catch {}
    remis.forEach((r) => { if (recus[r.id] === true) r.n += 1; });
  });

  return {
    totaux: {
      inscrits: participants.length,
      valides: valides.length,
      en_attente: participants.length - valides.length,
      utilises: utilises.length,
      demo: demo.length,
    },
    // Recette reellement encaissee : on somme le montant enregistre AVEC
    // chaque inscription, pas le tarif du jour. Le tarif a pu changer entre
    // deux inscriptions, et multiplier par le tarif actuel serait faux.
    recette: valides.reduce((somme, p) => somme + (Number(p.montant_valeur) || montantUnitaire), 0),
    devise: "FCFA",
    taux_presence: valides.length ? Math.round((utilises.length / valides.length) * 100) : 0,
    par_jour: parJour,
    par_heure: heures,
    par_operateur: compter(valides, (p) => p.operateur_paiement || "Non precise")
      .map(([nom, n]) => ({ nom, n })),
    par_poste: compter(utilises, (p) => p.scan_device_id).map(([nom, n]) => ({ nom, n })),
    elements: remis,
    genere_le: Date.now(),
  };
}

// Champs exportes, dans l'ordre des colonnes du fichier.
const EXPORT_COLUMNS = [
  ["id", "Reference"],
  ["nom", "Nom"],
  ["telephone", "Telephone"],
  ["email", "Email"],
  ["statut_paiement", "Statut paiement"],
  ["code_unique", "Code d'acces"],
  ["statut_code", "Statut du code"],
  ["montant", "Montant"],
  ["operateur_paiement", "Moyen de paiement"],
  ["fedapay_reference", "Reference transaction"],
  ["lieu_retrait", "Lieu"],
  ["date", "Date d'inscription"],
  ["validation_at", "Validation"],
  ["retrait_effectue_at", "Scanne le"],
  ["scan_device_id", "Poste de scan"],
];

function formatExportValue(participant, cle) {
  const brut = participant[cle];
  if (brut === null || brut === undefined) return "";
  // Les horodatages sont stockes en millisecondes : illisibles tels quels
  // dans un tableur.
  if (cle === "validation_at" || cle === "retrait_effectue_at") {
    if (!brut) return "";
    const d = getDatePartsBenin(new Date(Number(brut)));
    return `${d.day}/${d.month}/${d.year} ${d.hour}:${d.minute}`;
  }
  return String(brut);
}

function buildParticipantsCsv() {
  // Point-virgule et non virgule : c'est le separateur attendu par Excel en
  // configuration francaise, ou la virgule est le separateur decimal.
  const SEP = ";";
  const echapper = (valeur) => {
    const v = String(valeur);
    return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };

  const lignes = [EXPORT_COLUMNS.map(([, titre]) => echapper(titre)).join(SEP)];
  getParticipants().forEach((p) => {
    lignes.push(EXPORT_COLUMNS.map(([cle]) => echapper(formatExportValue(p, cle))).join(SEP));
  });

  // BOM UTF-8 : sans lui, Excel lit le fichier en ANSI et massacre les accents.
  return "\ufeff" + lignes.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Rapport exportable
//
// Le CSV sert a retraiter les donnees ; le rapport sert a les MONTRER : a un
// comite, a un partenaire, ou simplement a etre imprime et archive. D'ou deux
// formats, le PDF pour diffuser tel quel et le Word pour annoter.
// ---------------------------------------------------------------------------

// Lignes du tableau, communes aux deux formats : un seul endroit a modifier
// pour que PDF et Word restent identiques.
const RAPPORT_COLONNES = [
  { titre: "Nom", largeur: 150, valeur: (p) => texteP(p.nom) || "-" },
  { titre: "Téléphone", largeur: 92, valeur: (p) => texteP(p.telephone) || "-" },
  { titre: "Code", largeur: 66, valeur: (p) => p.code_unique || "-" },
  { titre: "Statut", largeur: 74, valeur: (p) => (p.statut_paiement === "Valide" ? "Validé" : "En attente") },
  { titre: "Entrée", largeur: 62, valeur: (p) => (p.statut_code === "utilise" ? "Scanné" : "-") },
  { titre: "Inscrit le", largeur: 76, valeur: (p) => p.date || "-" },
];

// toLocaleString("fr-FR") separe les milliers par une espace insecable ETROITE
// (U+202F). Les polices standard du PDF sont encodees en WinAnsi, qui ne
// connait pas ce caractere : "50 000" s'imprimait "50 /000". On repasse donc
// tout texte destine au PDF par ce filtre.
function texteP(valeur) {
  return String(valeur == null ? "" : valeur)
    .replace(/[    ]/g, " ");
}

function statsResume(stats, settings) {
  return [
    ["Inscrits", String(stats.totaux.inscrits)],
    ["Paiements validés", String(stats.totaux.valides)],
    ["En attente", String(stats.totaux.en_attente)],
    ["Entrées scannées", String(stats.totaux.utilises)],
    ["Taux de présence", stats.taux_presence + " %"],
    ["Recette", texteP(formatMontant(stats.recette))],
  ];
}

function buildRapportPdf(settings = getSettings()) {
  const stats = buildStats(settings);
  const participants = getParticipants();
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const d = getDatePartsBenin();
  const genere = `${d.day}/${d.month}/${d.year} à ${d.hour}:${d.minute}`;

  const M = 40;                       // marge
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: `Rapport ${eventName}`, Author: eventName } });
  const L = doc.page.width - M * 2;    // largeur utile

  const VERT = "#12662c", SOMBRE = "#0c2b17", GRIS = "#6b7280", TRAIT = "#d8dfd9";

  // -- En-tete de la premiere page
  const logo = getTicketLogoPath(settings);
  if (logo) {
    try { doc.image(logo, M, M - 4, { fit: [46, 46] }); } catch {}
  }
  const titreX = logo ? M + 58 : M;
  doc.fillColor(SOMBRE).font("Helvetica-Bold").fontSize(19).text(eventName.toUpperCase(), titreX, M);
  doc.fillColor(GRIS).font("Helvetica").fontSize(9.5)
     .text(`Rapport des participants — établi le ${genere}`, titreX, M + 24);
  doc.moveTo(M, M + 52).lineTo(M + L, M + 52).lineWidth(1.4).strokeColor(VERT).stroke();

  // -- Chiffres cles, en trois colonnes de deux lignes
  let y = M + 70;
  doc.fillColor(SOMBRE).font("Helvetica-Bold").fontSize(12).text("Chiffres clés", M, y);
  y += 20;

  const resume = statsResume(stats, settings);
  const colL = L / 3;
  resume.forEach((ligne, i) => {
    const cx = M + (i % 3) * colL;
    const cy = y + Math.floor(i / 3) * 46;
    doc.roundedRect(cx, cy, colL - 10, 38, 7).lineWidth(1).fillAndStroke("#f4f7f2", TRAIT);
    doc.fillColor(GRIS).font("Helvetica").fontSize(7.5)
       .text(ligne[0].toUpperCase(), cx + 10, cy + 7, { characterSpacing: 0.8 });
    doc.fillColor(SOMBRE).font("Helvetica-Bold").fontSize(14).text(ligne[1], cx + 10, cy + 18);
  });
  y += 46 * Math.ceil(resume.length / 3) + 14;

  if (isDemoMode(settings)) {
    doc.roundedRect(M, y, L, 26, 6).fillAndStroke("#fdecea", "#e0b4ae");
    doc.fillColor("#8a2b12").font("Helvetica-Bold").fontSize(8.5)
       .text("Mode démonstration actif : ces chiffres comptent des inscriptions d'essai.", M + 10, y + 9);
    y += 36;
  }

  // -- Tableau des participants
  doc.fillColor(SOMBRE).font("Helvetica-Bold").fontSize(12)
     .text(`Participants (${participants.length})`, M, y);
  y += 20;

  const LIGNE_H = 18;
  const BAS = doc.page.height - M - 24;

  function enteteTableau(yy) {
    doc.rect(M, yy, L, LIGNE_H).fill(SOMBRE);
    let x = M + 8;
    RAPPORT_COLONNES.forEach((c) => {
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8)
         .text(c.titre.toUpperCase(), x, yy + 5.5, { width: c.largeur - 8, lineBreak: false });
      x += c.largeur;
    });
    return yy + LIGNE_H;
  }

  y = enteteTableau(y);

  participants.forEach((part, i) => {
    if (y + LIGNE_H > BAS) {
      doc.addPage();
      y = M;
      y = enteteTableau(y);
    }
    // Alternance de fond : sur un tableau long, l'oeil perd sa ligne sans elle.
    if (i % 2 === 1) doc.rect(M, y, L, LIGNE_H).fill("#f6f8f6");
    let x = M + 8;
    RAPPORT_COLONNES.forEach((c) => {
      doc.fillColor(SOMBRE).font("Helvetica").fontSize(8)
         .text(String(c.valeur(part)), x, y + 5.5, { width: c.largeur - 8, lineBreak: false, ellipsis: true });
      x += c.largeur;
    });
    doc.moveTo(M, y + LIGNE_H).lineTo(M + L, y + LIGNE_H).lineWidth(0.5).strokeColor(TRAIT).stroke();
    y += LIGNE_H;
  });

  if (!participants.length) {
    doc.fillColor(GRIS).font("Helvetica-Oblique").fontSize(9)
       .text("Aucune inscription enregistrée.", M + 8, y + 6);
  }

  // -- Pieds de page, numerotes une fois toutes les pages connues
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    // Le pied s'ecrit SOUS la marge basse. Sans annuler cette marge, pdfkit
    // considere que le texte deborde et ajoute une page pour l'accueillir :
    // c'est ainsi que le rapport sortait avec deux pages vides a la fin.
    doc.page.margins.bottom = 0;
    doc.fillColor(GRIS).font("Helvetica").fontSize(7.5)
       .text(`${eventName} - ${genere}`, M, doc.page.height - M + 4, { width: L / 2, lineBreak: false });
    doc.text(`Page ${i + 1} sur ${pages.count}`, M + L / 2, doc.page.height - M + 4,
             { width: L / 2, align: "right", lineBreak: false });
  }

  return doc;
}

function renderRapportPdf(settings = getSettings()) {
  return new Promise((resolve, reject) => {
    try {
      const doc = buildRapportPdf(settings);
      const morceaux = [];
      doc.on("data", (m) => morceaux.push(m));
      doc.on("end", () => resolve(Buffer.concat(morceaux)));
      doc.on("error", reject);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// -- Version Word du meme rapport ------------------------------------------
async function renderRapportDocx(settings = getSettings()) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, WidthType, AlignmentType, BorderStyle, ShadingType,
  } = require("docx");

  const stats = buildStats(settings);
  const participants = getParticipants();
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const d = getDatePartsBenin();
  const genere = `${d.day}/${d.month}/${d.year} à ${d.hour}:${d.minute}`;

  const VERT = "12662C", SOMBRE = "0C2B17", GRIS = "6B7280";

  const cellule = (texte, opts = {}) => new TableCell({
    shading: opts.fond ? { type: ShadingType.CLEAR, fill: opts.fond } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({
      children: [new TextRun({
        text: String(texte),
        bold: !!opts.gras,
        size: opts.taille || 17,
        color: opts.couleur || SOMBRE,
      })],
    })],
  });

  const enfants = [
    new Paragraph({
      children: [new TextRun({ text: eventName.toUpperCase(), bold: true, size: 38, color: SOMBRE })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: `Rapport des participants — établi le ${genere}`, size: 19, color: GRIS })],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: "Chiffres clés", bold: true, size: 26, color: VERT })],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: statsResume(stats, settings).map((ligne) => new TableRow({
        children: [cellule(ligne[0], { couleur: GRIS }), cellule(ligne[1], { gras: true })],
      })),
    }),
  ];

  if (isDemoMode(settings)) {
    enfants.push(new Paragraph({
      spacing: { before: 200 },
      children: [new TextRun({
        text: "Mode démonstration actif : ces chiffres comptent des inscriptions d'essai.",
        bold: true, size: 18, color: "8A2B12",
      })],
    }));
  }

  enfants.push(new Paragraph({
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text: `Participants (${participants.length})`, bold: true, size: 26, color: VERT })],
  }));

  enfants.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: RAPPORT_COLONNES.map((c) =>
          cellule(c.titre.toUpperCase(), { gras: true, couleur: "FFFFFF", fond: SOMBRE, taille: 15 })),
      }),
      ...participants.map((part, i) => new TableRow({
        children: RAPPORT_COLONNES.map((c) =>
          cellule(c.valeur(part), { fond: i % 2 ? "F6F8F6" : undefined, taille: 16 })),
      })),
    ],
  }));

  if (!participants.length) {
    enfants.push(new Paragraph({
      children: [new TextRun({ text: "Aucune inscription enregistrée.", italics: true, color: GRIS, size: 18 })],
    }));
  }

  const doc = new Document({ sections: [{ children: enfants }] });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Recuperation de billet par email
//
// Le billet porte le QR d'entree : le remettre a la mauvaise personne, c'est
// laisser entrer un inconnu. Tout ce bloc part donc du principe que le
// demandeur ment jusqu'a preuve du contraire, et la seule preuve acceptee est
// qu'il recoive un code sur l'adresse email utilisee a l'inscription.
// ---------------------------------------------------------------------------
const TICKET_CODE_TTL_MS = 10 * 60 * 1000;      // duree de vie du code
const TICKET_CODE_MAX_ATTEMPTS = 5;             // essais avant destruction
const TICKET_SESSION_TTL_MS = 15 * 60 * 1000;   // duree de la session ouverte

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Empreinte du jeton de session. SHA-256 suffit ici : le jeton fait deja
// 32 octets aleatoires, il n'y a rien a deviner, on protege seulement contre
// une lecture de la base.
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function generateTicketCode() {
  // randomInt et non Math.random : ce code garde une entree d'evenement.
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Inscriptions validees rattachees a une adresse. Une meme adresse peut avoir
// servi a plusieurs inscriptions (une famille, un groupe d'amis) : on les
// renvoie toutes plutot que d'en choisir une au hasard.
function getValidatedParticipantsByEmail(email) {
  const cible = normalizeEmail(email);
  if (!cible) return [];
  return getParticipants().filter(
    (p) => normalizeEmail(p.email) === cible && p.statut_paiement === "Valide" && p.code_unique,
  );
}

function purgeTicketAccess() {
  const maintenant = Date.now();
  run("DELETE FROM ticket_codes WHERE expires_at < ?", [maintenant]);
  run("DELETE FROM ticket_sessions WHERE expires_at < ?", [maintenant]);
  persistDatabase();
}

function createTicketSession(email) {
  const token = crypto.randomBytes(32).toString("hex");
  run(
    "INSERT INTO ticket_sessions (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [hashToken(token), normalizeEmail(email), Date.now() + TICKET_SESSION_TTL_MS, Date.now()],
  );
  persistDatabase();
  return token;
}

// Renvoie l'email de la session, ou null. Ne prolonge JAMAIS la session :
// quinze minutes suffisent a telecharger un billet, et une session qui se
// renouvelle toute seule finit par ne plus expirer du tout.
function getTicketSessionEmail(token) {
  const brut = String(token || "").trim();
  if (!/^[a-f0-9]{64}$/.test(brut)) return null;

  const ligne = statementGet(
    "SELECT email, expires_at FROM ticket_sessions WHERE token_hash = ?",
    [hashToken(brut)],
  );
  if (!ligne) return null;

  if (Number(ligne.expires_at) < Date.now()) {
    run("DELETE FROM ticket_sessions WHERE token_hash = ?", [hashToken(brut)]);
    persistDatabase();
    return null;
  }
  return String(ligne.email || "");
}

// Retrouve un participant a partir d'une session ET d'un identifiant. Les deux
// sont verifies : un jeton valide ne doit pas permettre de telecharger le
// billet d'une AUTRE adresse en changeant simplement l'identifiant dans l'URL.
function getParticipantForTicketSession(token, participantId) {
  const email = getTicketSessionEmail(token);
  if (!email) return { erreur: "session" };

  const participant = getParticipantById(String(participantId || "").trim());
  if (!participant) return { erreur: "introuvable" };

  if (normalizeEmail(participant.email) !== email) return { erreur: "interdit" };
  if (participant.statut_paiement !== "Valide" || !participant.code_unique) {
    return { erreur: "non_valide" };
  }
  return { participant };
}

async function sendTicketCodeEmail(email, code, settings) {
  await new mail.CodeVerificationEmail({
    settings,
    baseUrl: getPublicBaseUrl(settings),
    email,
    code,
    dureeMinutes: Math.round(TICKET_CODE_TTL_MS / 60000),
  }).send();
  return true;
}

function getPaymentApiBaseUrl(environment) {
  return environment === "live" ? "https://api.fedapay.com/v1" : "https://sandbox-api.fedapay.com/v1";
}

function getPaymentCredentials(settings) {
  const secretKey = process.env.FEDAPAY_SECRET_KEY || settings.payment_secret_key;
  const environment = process.env.FEDAPAY_ENVIRONMENT || settings.payment_environment || "sandbox";

  if (!secretKey) {
    throw new Error("Cle secrete de paiement non configuree.");
  }

  return {
    secretKey,
    environment: environment === "live" ? "live" : "sandbox",
  };
}

async function fedapayRequest(settings, method, routePath, body = null) {
  const credentials = getPaymentCredentials(settings);
  let response;
  let text;
  try {
    response = await fetch(`${getPaymentApiBaseUrl(credentials.environment)}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.secretKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await response.text();
  } catch (error) {
    noterPanneFedapay(`réseau : ${error.message}`);
    throw error;
  }
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    // 4xx : requete refusee (souvent une cle fausse) ; 5xx : panne chez FedaPay.
    // Les deux empechent de payer, d'ou l'alerte au-dela de quelques echecs.
    noterPanneFedapay(`HTTP ${response.status} sur ${method} ${routePath.split("?")[0]}`);
    throw new Error(`FedaPay HTTP ${response.status}: ${text}`);
  }

  return data;
}

function noterPanneFedapay(detail) {
  const exemples = sentinelle.retenirExemple("fedapay", detail);
  if (sentinelle.franchit("fedapay", 5, 10 * 60 * 1000)) {
    sentinelle.signaler({ gravite: "alerte", type: "fedapay", titre: "FedaPay répond en erreur (5 échecs en 10 min)", cle: "fedapay",
      details: [["Derniers échecs", exemples.join("  |  ")]] });
  }
}

function splitFullName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstname: parts.slice(0, -1).join(" ") || parts[0] || "",
    lastname: parts.slice(-1).join(" ") || parts[0] || "",
  };
}

// Pays acceptes pour le numero du client. La page de paiement hebergee gere
// le reste du monde via la carte bancaire, mais FedaPay veut un pays valide
// pour rattacher le numero de telephone.
const SUPPORTED_PHONE_COUNTRIES = new Set(["BJ", "TG", "CI", "SN", "NE", "BF", "ML", "GN"]);

function resolvePhoneCountry(value) {
  const code = String(value || "").trim().toUpperCase();
  return SUPPORTED_PHONE_COUNTRIES.has(code) ? code : "BJ";
}

async function createPaymentCustomer(settings, participant) {
  const names = splitFullName(participant.nom);
  const payload = await fedapayRequest(settings, "POST", "/customers", {
    firstname: names.firstname,
    lastname: names.lastname,
    email: participant.email,
    phone_number: {
      number: normalizePhoneNumber(participant.telephone),
      country: resolvePhoneCountry(participant.pays),
    },
  });

  return payload.customer || payload;
}

async function createPaymentTransaction(settings, participant, customer, nombreBillets = 1) {
  // Un achat groupe est un seul paiement. Facturer billet par billet
  // obligerait l'acheteur a repasser autant de fois par Mobile Money.
  const amount = getParticipationAmount(settings) * Math.max(1, Number(nombreBillets) || 1);
  const callbackBase = process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const body = {
    description: nombreBillets > 1
      ? `${nombreBillets} badges ${eventName} ${settings.event_year || DEFAULT_SETTINGS.event_year}`
      : `Participation ${eventName} ${settings.event_year || DEFAULT_SETTINGS.event_year}`,
    amount,
    currency: { iso: "XOF" },
    customer: { id: customer.id },
    merchant_reference: participant.id,
    custom_metadata: {
      participant_id: participant.id,
      evenement: eventName,
      nom: participant.nom,
      telephone: participant.telephone,
      email: participant.email,
      billets: nombreBillets,
    },
  };

  // callback_url = page de RETOUR du client apres paiement (pas le webhook :
  // celui-ci se configure dans le tableau de bord FedaPay et arrive sur
  // /api/fedapay/webhook). On y renvoie l'id participant pour finaliser.
  if (callbackBase) {
    body.callback_url = `${callbackBase.replace(/\/+$/, "")}/retour-paiement.html?p=${encodeURIComponent(participant.id)}`;
  }

  const payload = await fedapayRequest(settings, "POST", "/transactions", body);
  return payload.transaction || payload;
}

// Le montant attendu est celui de TOUT l'achat : prix d'un badge multiplie
// par le nombre de badges du groupe. Compare au prix d'un seul badge, tout
// achat groupe etait refuse comme « montant incorrect » par le webhook.
async function verifyPaymentTransaction(transactionId, participant, settings) {
  if (!transactionId) {
    throw new Error("Transaction de paiement manquante.");
  }

  const payload = await fedapayRequest(settings, "GET", `/transactions/${encodeURIComponent(transactionId)}`);
  const transaction = payload.transaction || payload;
  const status = String(transaction.status || "").toLowerCase();
  const transactionAmount = Number(transaction.amount || 0);
  const attendu = Number(getParticipationAmount(settings)) * getParticipantsDuGroupe(participant).length;

  if (status !== "approved") {
    throw new Error("Paiement non confirme.");
  }

  if (transactionAmount !== attendu) {
    signalerFraudePaiement("Montant payé différent du prix", participant, transaction, attendu);
    throw new Error("Montant du paiement incorrect.");
  }

  return transaction;
}

async function getPaymentTransaction(transactionId, settings) {
  if (!transactionId) {
    throw new Error("Transaction de paiement manquante.");
  }

  const payload = await fedapayRequest(settings, "GET", `/transactions/${encodeURIComponent(transactionId)}`);
  return payload.transaction || payload;
}

function updateParticipantPaymentStatus(participantId, transaction) {
  run(
    `
      UPDATE participants
      SET preuve_paiement = COALESCE(?, preuve_paiement),
          preuve_url = COALESCE(?, preuve_url),
          fedapay_reference = COALESCE(?, fedapay_reference),
          fedapay_status = COALESCE(?, fedapay_status)
      WHERE id = ?
    `,
    [
      transaction.receipt_url || null,
      transaction.receipt_url || null,
      transaction.reference || transaction.merchant_reference || null,
      transaction.status || null,
      participantId,
    ],
  );
  persistDatabase();
}

// FedaPay renvoie ici le jeton ET l'URL de sa page de paiement hebergee.
// C'est cette page qui ouvre tous les pays : elle propose la carte bancaire
// (Visa/Mastercard, international) en plus des Mobile Money regionaux, et
// s'adapte au pays du client. On redirige donc l'utilisateur dessus.
async function createPaymentToken(settings, transactionId) {
  const payload = await fedapayRequest(settings, "POST", `/transactions/${encodeURIComponent(transactionId)}/token`);
  const tokenObject = payload.token ? payload : payload.data || payload;
  const token = tokenObject.token || tokenObject.value || tokenObject.id;
  const url = payload.url || tokenObject.url || "";

  if (!token) {
    throw new Error("Token de paiement non genere.");
  }

  return {
    token,
    url: url || `https://${getPaymentCredentials(settings).environment === "live" ? "process" : "sandbox-process"}.fedapay.com/${token}`,
  };
}

// Reglages lus a la demande quand l'appelant n'en passe pas : la route du QR
// d'installation l'appelait sans argument et repondait une erreur 500.
function getPublicBaseUrl(settings = getSettings()) {
  return process.env.PUBLIC_BASE_URL || (settings && settings.public_base_url) || "";
}

// ---------------------------------------------------------------------------
// Mode demonstration
//
// Permet d'essayer le parcours d'inscription de bout en bout sans cle de
// paiement : le formulaire cree un vrai participant, le retour de paiement le
// valide aussitot, le code et le QR sont generes pour de bon.
//
// Les inscriptions ainsi creees portent DEMO_PAYMENT_TAG dans la colonne
// `paiement`, ce qui permet de les reconnaitre et de les effacer toutes quand
// le mode s'eteint. DANGER : tant qu'il est actif, n'importe qui s'inscrit
// sans payer. Le bandeau public, l'avertissement au demarrage et le controle
// [BLOQUANT] de l'etat de preparation sont la pour que l'oubli se remarque.
// ---------------------------------------------------------------------------
const DEMO_PAYMENT_TAG = "demonstration";

function isDemoMode(settings = getSettings()) {
  return String(settings.demo_mode || "0") === "1";
}

// Fabrique la transaction que FedaPay aurait renvoyee pour un paiement
// accepte. finalizePaidParticipant verifie le statut ET le montant : on fournit
// donc les deux, sinon la validation echouerait.
function buildDemoTransaction(participant, settings) {
  // Le montant doit couvrir tout l'achat : finalizePaidParticipant refuse une
  // transaction dont le montant ne correspond pas au nombre de billets.
  const billets = getParticipantsDuGroupe(participant).length;
  return {
    id: `demo-${participant.id}`,
    status: "approved",
    amount: getParticipationAmount(settings) * billets,
    reference: `DEMO-${participant.id}`,
  };
}

// Efface les inscriptions de demonstration et les fichiers qu'elles ont laisses
// (photo, QR code). Sans le menage des fichiers, chaque essai laisserait une
// image orpheline sur le disque.
function purgeDemoParticipants() {
  const rows = statementAll(
    "SELECT id, participant_photo_url, qr_code_url FROM participants WHERE paiement = ?",
    [DEMO_PAYMENT_TAG],
  );

  rows.forEach((row) => {
    [row.participant_photo_url, row.qr_code_url].forEach((url) => {
      if (!url) return;
      const filePath = path.join(ROOT, String(url).split("?")[0].replace(/^\/+/, ""));
      // Garde-fou : on ne supprime que sous uploads/, jamais ailleurs.
      if (filePath.startsWith(path.join(ROOT, "uploads"))) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    });
  });

  run("DELETE FROM participants WHERE paiement = ?", [DEMO_PAYMENT_TAG]);
  persistDatabase();
  return rows.length;
}

// Verifie les champs saisis par le public. Renvoie un message d'erreur en
// francais, ou null si tout est bon.
function validateParticipantInput({ nom, telephone, email }) {
  if (nom.length < 2 || nom.length > 120) {
    return "Le nom doit contenir entre 2 et 120 caracteres.";
  }

  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return "Adresse email invalide.";
  }

  const digits = normalizePhoneNumber(telephone);
  if (digits.length < 8 || digits.length > 15) {
    return "Numero de telephone invalide.";
  }

  return null;
}

/* Billets demandes par un achat.
 *
 * Accepte encore l'ancien format a un seul billet (nom + photo a la racine du
 * corps) : une page gardee en cache par un navigateur continuerait sinon a
 * echouer sans que personne comprenne pourquoi.
 */
function lireBilletsDemandes(body) {
  const liste = Array.isArray(body.billets) && body.billets.length
    ? body.billets
    : [{ nom: body.nom, photo_base64: body.participant_photo_base64 }];

  return liste.map((b) => ({
    nom: String((b && b.nom) || "").trim(),
    photo: (b && (b.photo_base64 || b.participant_photo_base64)) || "",
  }));
}

/* Toutes les lignes d'un meme achat, dans l'ordre de saisie.
 *
 * Les inscriptions d'avant l'achat groupe n'ont pas de groupe_id : elles sont
 * leur propre groupe d'une seule ligne, ce qui evite d'avoir a distinguer les
 * deux cas partout ailleurs.
 */
function getParticipantsDuGroupe(participant) {
  if (!participant) return [];
  if (!participant.groupe_id) return [participant];

  const lignes = statementAll(
    "SELECT * FROM participants WHERE groupe_id = ? ORDER BY groupe_index ASC, timestamp ASC",
    [participant.groupe_id],
  );
  return lignes.length ? lignes : [participant];
}

function buildPendingParticipant(body, settings, billet, groupe) {
  const amount = getParticipationAmount(settings);
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const id = generateParticipantId();
  // Le nom et la photo viennent du billet ; le telephone et l'email restent
  // ceux de l'acheteur, sur chaque ligne : c'est par son adresse qu'il
  // retrouvera plus tard TOUS les billets qu'il a payes.
  const b = billet || { nom: body.nom, photo: body.participant_photo_base64 };
  const g = groupe || { id: null, index: 1, taille: 1 };
  const nom = String(b.nom || "").trim();
  const telephone = String(body.telephone || "").trim();
  const email = String(body.email || "").trim();
  const participantPhotoUrl = saveParticipantPhoto(b.photo, id);

  return {
    id,
    evenement: eventName,
    nom,
    telephone,
    whatsapp: telephone,
    email,
    pays: resolvePhoneCountry(body.pays || body.country),
    montant: formatMontant(amount),
    montant_valeur: amount,
    paiement: "paiement_securise",
    operateur_paiement_code: null,
    operateur_paiement: "Paiement securise",
    nom_paiement: null,
    numero_paiement: null,
    preuve_paiement: null,
    preuve_url: null,
    capture_b64: null,
    participant_photo_url: participantPhotoUrl,
    statut_paiement: "En attente",
    code_unique: null,
    statut_code: null,
    fedapay_transaction_id: null,
    fedapay_customer_id: null,
    fedapay_reference: null,
    fedapay_status: "pending",
    qr_code_url: null,
    lieu_retrait: settings.pickup_location || DEFAULT_SETTINGS.pickup_location,
    date: dateFormatee(),
    date_key: getDateKeyBenin(),
    timestamp: Date.now(),
    validation_at: null,
    retrait_effectue_at: null,
    groupe_id: g.id,
    groupe_index: g.index,
    groupe_taille: g.taille,
  };
}

function getFedapayWebhookSecret(settings) {
  return process.env.FEDAPAY_WEBHOOK_SECRET || settings.fedapay_webhook_secret || "";
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyFedapayWebhookSignature(request, rawBody, settings) {
  const secret = getFedapayWebhookSecret(settings);
  if (!secret) {
    return true;
  }

  const signature =
    request.headers["x-fedapay-signature"] ||
    request.headers["fedapay-signature"] ||
    request.headers["x-signature"] ||
    "";
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  return timingSafeStringEqual(signature, digest) || timingSafeStringEqual(signature, `sha256=${digest}`);
}

function extractFedapayTransaction(payload) {
  const candidates = [
    payload?.transaction,
    payload?.entity,
    payload?.object,
    payload?.data?.transaction,
    payload?.data?.object,
    payload?.data,
  ];

  return candidates.find((candidate) => candidate && typeof candidate === "object" && candidate.id) || null;
}

async function sendWaChapMessage(payload, settings) {
  const accountId = settings.wachap_instance_id;
  const accessToken = settings.wachap_access_token;

  if (!accountId || !accessToken) {
    return false;
  }

  const response = await fetch("https://api.wachap.com/v1/whatsapp/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ data: { accountId, ...payload } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WaChap HTTP ${response.status}: ${text}`);
  }

  return true;
}

async function notifyOrganizer(participant, settings) {
  const organizerWhatsapp = normalizePhoneNumber(settings.vendeur_whatsapp);
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  if (!organizerWhatsapp) {
    return false;
  }

  await sendWaChapMessage(
    {
      to: `+${organizerWhatsapp}`,
      type: "text",
      content:
        `Nouvelle participation ${eventName}\n\n` +
        `ID: ${participant.id}\n` +
        `Nom: ${participant.nom}\n` +
        `WhatsApp: ${participant.telephone}\n` +
        `Email: ${participant.email}\n` +
        `Paiement: ${participant.operateur_paiement || "Mobile Money"}\n` +
        `Montant: ${participant.montant}\n` +
        `Retrait: ${participant.lieu_retrait}`,
    },
    settings,
  );

  if (participant.preuve_url) {
    await sendWaChapMessage(
      {
        to: `+${organizerWhatsapp}`,
        type: "image",
        imageUrl: participant.preuve_url,
        caption: `Preuve de paiement ${eventName}`,
      },
      settings,
    );
  }

  return true;
}

// Le nom vient du formulaire public : injecte tel quel, il permettait de
// glisser du HTML (voire un lien de hameconnage) dans l'email envoye depuis
// notre domaine. Tout ce qui est variable passe donc par escapeHtml.
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

async function sendValidationEmail(participantOuGroupe, settings) {
  // Accepte une ligne seule ou tout un achat : l'admin renvoie le billet d'un
  // participant, le paiement en valide parfois plusieurs d'un coup.
  const billets = Array.isArray(participantOuGroupe) ? participantOuGroupe : [participantOuGroupe];
  const acheteur = billets[0];
  if (!acheteur || !acheteur.email) return false;

  const baseUrl = getPublicBaseUrl(settings);
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const nomFichier = eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const attachments = [];

  for (const billet of billets) {
    // Le QR en PNG n'accompagne que l'achat d'un seul billet. Au-dela, il
    // doublerait le nombre de pieces jointes sans rien apporter : le QR de
    // chacun figure deja sur son billet PDF.
    if (billets.length === 1 && billet.qr_code_url) {
      const qrPath = path.join(ROOT, billet.qr_code_url.split("?")[0].replace(/^\/+/, ""));
      if (fs.existsSync(qrPath)) {
        attachments.push({
          filename: `code-${nomFichier}-${billet.code_unique}.png`,
          content: fs.readFileSync(qrPath),
        });
      }
    }

    // Billet PDF. Un echec de generation ne doit jamais empecher l'e-mail de
    // partir : le code y figure deja, le billet est un confort.
    try {
      attachments.push({
        filename: `badge-${nomFichier}-${billet.code_unique}.pdf`,
        content: await renderTicketPdf(billet, settings),
      });
    } catch (error) {
      console.warn("Billet PDF non genere:", error.message);
    }
  }

  await new mail.PaiementConfirmeEmail({ settings, baseUrl, participant: acheteur, billets, attachments }).send();
  return true;
}
// Alerte "nouvelle inscription payee". Volontairement NON attendue : le
// participant ne doit pas patienter pendant qu'un e-mail interne part, et un
// echec d'alerte ne doit jamais faire echouer son inscription.
function alerterInscriptionPayee(participantOuGroupe, settings) {
  const billets = Array.isArray(participantOuGroupe) ? participantOuGroupe : [participantOuGroupe];
  const acheteur = billets[0];
  if (!acheteur) return;

  const lignes = [
    ["Acheteur", acheteur.nom || "—"],
    ["Téléphone", acheteur.telephone || "—"],
    ["Email", acheteur.email || "—"],
  ];

  if (billets.length > 1) {
    // Un achat groupe se lit mal en une seule ligne : on liste chaque nom avec
    // son code, c'est ce qu'on aura sous les yeux a l'entree.
    lignes.push(["Badges", String(billets.length)]);
    lignes.push(["Total", formatMontant(getParticipationAmount(settings) * billets.length)]);
    billets.forEach((b, i) => {
      lignes.push([`${i + 1}. ${b.nom || "—"}`, b.code_unique || "—"]);
    });
  } else {
    lignes.push(["Montant", acheteur.montant || "—"]);
    lignes.push(["Code d'accès", acheteur.code_unique || "—"]);
  }

  lignes.push(["Référence", acheteur.groupe_id || acheteur.id || "—"]);

  sendInternalAlert(
    billets.length > 1 ? `Nouvel achat de ${billets.length} badges` : "Nouvelle inscription payée",
    lignes,
    settings,
  ).catch(() => { /* deja journalise dans sendInternalAlert */ });
}

// Avis interne a l'organisation. Ne bloque jamais le parcours du participant :
// une alerte qui ne part pas est ennuyeuse, une inscription qui echoue l'est
// beaucoup plus.
async function sendInternalAlert(evenement, lignes, settings = getSettings(), note = "") {
  const alerte = new mail.AlerteInterneEmail({
    settings,
    baseUrl: getPublicBaseUrl(settings),
    evenement,
    lignes,
    note,
  });

  if (!alerte.destinataire()) return false;

  try {
    await alerte.send();
    return true;
  } catch (error) {
    console.warn("Alerte interne non envoyee:", error.message);
    return false;
  }
}

// Forme publique d'un billet. Volontairement etroite : la ligne participant
// porte aussi le telephone et les references de paiement, qui n'ont rien a
// faire dans une reponse lue par le navigateur.
function billetPublic(b) {
  return {
    id: b.id,
    nom: b.nom,
    code_unique: b.code_unique,
    qr_code_url: b.qr_code_url,
    lieu_retrait: b.lieu_retrait,
    montant: b.montant,
    groupe_index: b.groupe_index || 1,
    groupe_taille: b.groupe_taille || 1,
    // Ce qu'il faut a la page pour dessiner l'image du badge : la photo du
    // porteur et la matrice du QR (le navigateur n'a pas de generateur QR).
    photo: b.participant_photo_url || "",
    qr_matrice: qrMatrice(b.code_unique),
  };
}

// Validations en cours, par achat. Le webhook FedaPay et la page de retour
// confirment souvent le MEME paiement au meme instant : sans file d'attente,
// les deux passaient le controle « deja valide ? » avant que l'un ait ecrit
// (la creation du QR est asynchrone), chacun tirait un code different et
// l'acheteur recevait deux e-mails, dont un avec un code refuse a l'entree.
const finalisationsEnCours = new Map();

function finalizePaidParticipant(participant, transaction, settings) {
  if (!participant) {
    return Promise.reject(new Error("Participant introuvable."));
  }

  const cle = participant.groupe_id || participant.id;
  const precedente = finalisationsEnCours.get(cle) || Promise.resolve();
  // La suivante relit la ligne : si la precedente a valide, elle le verra.
  const suivante = precedente
    .catch(() => {})
    .then(() => finaliserAchat(getParticipantById(participant.id) || participant, transaction, settings));

  finalisationsEnCours.set(cle, suivante);
  suivante
    .finally(() => { if (finalisationsEnCours.get(cle) === suivante) finalisationsEnCours.delete(cle); })
    .catch(() => {});
  return suivante;
}

async function finaliserAchat(participant, transaction, settings) {
  // Un achat couvre un ou plusieurs billets, mais toujours un seul paiement :
  // on valide le groupe entier ou rien. Valider ligne par ligne laisserait un
  // acheteur avec trois billets sur cinq si l'envoi echouait au milieu.
  const groupe = getParticipantsDuGroupe(participant);

  if (groupe.every((b) => b.statut_paiement === "Valide" && b.code_unique)) {
    return {
      participant: getParticipantById(participant.id),
      billets: groupe,
      emailSent: false,
      alreadyFinalized: true,
    };
  }

  const amount = getParticipationAmount(settings);
  const status = String(transaction.status || "").toLowerCase();
  const transactionAmount = Number(transaction.amount || 0);

  if (status !== "approved") {
    throw new Error("Paiement non confirme.");
  }

  // Le montant attendu depend du nombre de billets : sans cette
  // multiplication, payer un seul billet en delivrerait cinq.
  if (transactionAmount !== Number(amount) * groupe.length) {
    signalerFraudePaiement("Montant payé différent du prix", participant, transaction, Number(amount) * groupe.length);
    throw new Error("Montant du paiement incorrect.");
  }

  // La transaction appartient bien a cet achat. Un identifiant deja utilise
  // par un AUTRE groupe signalerait un rejeu.
  const dejaLiee = getParticipantByFedapayTransactionId(transaction.id);
  if (dejaLiee && !groupe.some((b) => b.id === dejaLiee.id)) {
    signalerFraudePaiement("Transaction déjà utilisée par une autre inscription", participant, transaction, null);
    throw new Error("Cette transaction est deja liee a une inscription.");
  }

  const validationAt = Date.now();
  const reference = transaction.reference || transaction.merchant_reference || participant.fedapay_reference || null;

  for (const billet of groupe) {
    if (billet.statut_paiement === "Valide" && billet.code_unique) continue;

    const codeUnique = generateUniqueCode();
    const qrCodeUrl = await saveQrCode(codeUnique, billet.id);

    run(
      `
        UPDATE participants
        SET statut_paiement = ?, code_unique = ?, statut_code = ?, preuve_paiement = ?, preuve_url = ?,
            fedapay_reference = ?, fedapay_status = ?, qr_code_url = ?, validation_at = ?
        WHERE id = ?
      `,
      [
        "Valide",
        codeUnique,
        "actif",
        transaction.receipt_url || billet.preuve_paiement || null,
        transaction.receipt_url || billet.preuve_url || null,
        reference,
        transaction.status || "approved",
        qrCodeUrl,
        validationAt,
        billet.id,
      ],
    );
  }
  await persistDatabase();

  const billets = getParticipantsDuGroupe(getParticipantById(participant.id));
  const updatedParticipant = billets.find((b) => b.id === participant.id) || billets[0];

  // Un seul e-mail pour tout l'achat : cinq messages pour cinq billets
  // ressembleraient a une erreur d'envoi.
  const emailSent = await sendValidationEmail(billets, settings).catch((error) => {
    console.error("Email de validation non envoye:", error.message);
    const exemples = sentinelle.retenirExemple("email-badge", error.message);
    if (sentinelle.franchit("email-badge", 3, 30 * 60 * 1000)) {
      sentinelle.signaler({ gravite: "alerte", type: "email_echec", titre: "Les e-mails de badge ne partent pas (3 échecs en 30 min)",
        cle: "email-badge", details: [["Erreurs", exemples.join("  |  ")]] });
    }
    return false;
  });

  // Point de passage unique de TOUT paiement valide, quel que soit le chemin
  // (retour de paiement, webhook, mode demonstration). Accrochee ailleurs,
  // l'alerte manquait le parcours de demonstration.
  alerterInscriptionPayee(billets, settings);

  return { participant: updatedParticipant, billets, emailSent, alreadyFinalized: false };
}

function normalizeParticipant(p) {
  return {
    ref:      p.id,
    nom:      p.nom,
    wa:       p.whatsapp || p.telephone || "",
    email:    p.email || "",
    method:   p.operateur_paiement_code || "",
    amount:   p.montant || "",
    status:   p.statut_paiement === "Valide" ? "validated" : "pending",
    code:     p.code_unique || "",
    codeUsed: p.statut_code === "utilise",
    proof:    p.preuve_url || "",
    date:     p.date || "",
    ...p,
  };
}

async function handleApi(request, response, url) {
  try {
    if (url.pathname === "/api/public-config" && request.method === "GET") {
      sendJson(response, 200, publicSettings());
      return;
    }

    // QR code d'installation : encode l'adresse a ouvrir sur le telephone.
    // On privilegie l'adresse publique (HTTPS) ; a defaut on retombe sur l'hote
    // de la requete, utile en test sur le reseau local.
    if (url.pathname === "/api/install/qr.png" && request.method === "GET") {
      const target = String(url.searchParams.get("target") || "scan");
      const pagePath = target === "admin" ? "/admin.html" : "/scan.html";
      const base = (getPublicBaseUrl() || `http://${request.headers.host}`).replace(/\/+$/, "");
      const installUrl = `${base}${pagePath}`;

      const buffer = await QRCode.toBuffer(installUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
        color: { dark: "#0b1020", light: "#ffffff" },
      });

      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
      response.end(buffer);
      return;
    }

    // Icone par defaut (monogramme aux couleurs du theme), servie tant qu'aucun
    // logo n'a ete televerse depuis l'admin.
    if (url.pathname === "/api/branding/default-icon.svg" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      response.end(buildDefaultIcon());
      return;
    }

    // Manifests PWA generes a la volee : l'icone de l'app installee suit le
    // logo choisi dans l'admin, et le nom suit celui de l'evenement.
    if (url.pathname.startsWith("/api/manifest/") && request.method === "GET") {
      const settings = getSettings();
      const theme = resolveTheme(settings);
      const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
      const icon = settings.logo_url || "/api/branding/default-icon.svg";
      const isScan = url.pathname === "/api/manifest/scan.webmanifest";

      // Le logo est fourni par l'organisateur : on ignore ses dimensions et son
      // format reels. On declare donc sizes:"any" (le navigateur redimensionne,
      // et "any" satisfait les criteres d'installation) plutot que d'annoncer un
      // 192x192 mensonger, et on deduit le type de l'extension.
      const iconExtension = (icon.split("?")[0].match(/\.(\w+)$/) || [])[1] || "png";
      const iconType = MIME_TYPES[`.${iconExtension.toLowerCase()}`] || "image/png";

      response.writeHead(200, {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      response.end(
        JSON.stringify({
          name: isScan ? `${eventName} — Scan` : `${eventName} — Admin`,
          short_name: isScan ? "Scan" : "Admin",
          description: isScan
            ? "Controle des QR codes a l'entree, meme sans reseau."
            : "Administration de l'evenement.",
          start_url: isScan ? "/scan.html" : "/admin.html",
          scope: "/",
          display: "standalone",
          orientation: isScan ? "portrait" : "any",
          background_color: theme.colors.bg,
          theme_color: theme.colors.bg,
          // Pas de purpose "maskable" : un logo quelconque n'a pas la marge de
          // securite requise et se ferait rogner par le systeme.
          icons: [{ src: icon, sizes: "any", type: iconType, purpose: "any" }],
        }),
      );
      return;
    }

    // Feuille de style du theme, liee dans le <head> de chaque page : les
    // couleurs sont donc appliquees au premier rendu, sans clignotement.
    if (url.pathname === "/api/theme.css" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      response.end(buildThemeCss());
      return;
    }

    if (url.pathname === "/api/public-stats" && request.method === "GET") {
      sendJson(response, 200, { participants: getStats().total });
      return;
    }

    if (url.pathname === "/api/public/contact" && request.method === "POST") {
      // Plafond large mais present : un formulaire ouvert peut etre soumis
      // en boucle par un script, jamais par une vraie personne qui ecrit un
      // message.
      const retryAfter = rateLimit(request, "contact", 5, 30 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop de messages envoyes. Patiente un instant.");
        return;
      }

      const body = await parseJsonBody(request);
      const email = String(body.email || "").trim();
      const whatsapp = String(body.whatsapp || "").trim();
      const message = String(body.message || "").trim();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
        sendJson(response, 400, { error: "Adresse email invalide." });
        return;
      }
      if (!message || message.length < 5) {
        sendJson(response, 400, { error: "Decris un peu le probleme rencontre." });
        return;
      }
      if (message.length > 4000 || whatsapp.length > 40) {
        sendJson(response, 400, { error: "Message trop long." });
        return;
      }

      const settings = getSettings();
      const sent = await sendInternalAlert(
        "Nouveau message de contact",
        [["Email", email], ["WhatsApp", whatsapp || "—"]],
        settings,
        message,
      );

      sendJson(response, 200, { ok: true, sent });
      return;
    }

    if (url.pathname === "/api/public/verify-code" && request.method === "POST") {
      // Le code fait 6 caracteres : sans plafond, on peut le deviner par
      // essais successifs et decouvrir le nom du participant associe.
      const retryAfter = rateLimit(request, "verify", 60, 5 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop de vérifications. Patiente quelques minutes.");
        return;
      }

      const body = await parseJsonBody(request);
      const code = String(body.code || "").trim().toUpperCase();

      if (!code) {
        sendJson(response, 400, { error: "Code obligatoire." });
        return;
      }

      const participant = getParticipantByCode(code);
      if (!participant || participant.statut_paiement !== "Valide") {
        const ipCode = getClientIp(request);
        if (sentinelle.franchit(`codes-faux:${ipCode}`, 25, 10 * 60 * 1000)) {
          sentinelle.signaler({ gravite: "alerte", type: "codes_devines", titre: "25 codes d'accès faux essayés en 10 min", ip: ipCode });
        }
        sendJson(response, 404, { status: "not_found", error: "Code introuvable ou paiement non confirme." });
        return;
      }

      let itemsReceived = {};
      try { itemsReceived = JSON.parse(participant.items_received || "{}"); } catch {}
      const settings2 = getSettings();
      let eventItems2 = [];
      try { eventItems2 = JSON.parse(settings2.event_items_json || "[]"); } catch {}
      sendJson(response, 200, {
        status: participant.statut_code === "utilise" ? "already_used" : "valid",
        participant: {
          nom: participant.nom,
          code_unique: participant.code_unique,
          statut_code: participant.statut_code,
          statut_paiement: participant.statut_paiement,
          montant: participant.montant,
          lieu_retrait: participant.lieu_retrait,
          date: participant.date,
          items_received: itemsReceived,
        },
        event_items: eventItems2,
      });
      return;
    }

    if (url.pathname === "/api/public/register" && request.method === "POST" && false) { // désactivé – inscription via paiement automatique uniquement
      const body = await parseJsonBody(request);
      const nom   = String(body.nom   || "").trim();
      const wa    = String(body.wa    || "").trim();
      const email = String(body.email || "").trim();
      const method = String(body.method || "").trim();
      const proof  = String(body.proof  || "").trim();

      if (nom.length < 2 || !wa || !email || !proof) {
        sendJson(response, 400, { error: "Nom (≥2 car.), WhatsApp, email et preuve de paiement sont obligatoires." });
        return;
      }

      const settings = getSettings();
      const id = generateParticipantId();
      const proofUrl = saveReceiptProof(proof, id);
      const opMeta = getOperatorMeta(settings, method === "mtn" ? "mtn" : "moov");
      const amount = getParticipationAmount(settings);

      const participant = {
        id,
        evenement:              settings.event_name || DEFAULT_SETTINGS.event_name,
        nom,
        telephone:              wa,
        whatsapp:               wa,
        email,
        montant:                formatMontant(amount),
        montant_valeur:         amount,
        paiement:               "manuel",
        operateur_paiement_code: opMeta.code,
        operateur_paiement:     opMeta.shortLabel + " Money",
        nom_paiement:           opMeta.holder,
        numero_paiement:        opMeta.number,
        preuve_paiement:        null,
        preuve_url:             proofUrl,
        capture_b64:            null,
        participant_photo_url:  null,
        statut_paiement:        "En attente",
        code_unique:            null,
        statut_code:            null,
        fedapay_transaction_id: null,
        fedapay_customer_id:    null,
        fedapay_reference:      null,
        fedapay_status:         null,
        qr_code_url:            null,
        lieu_retrait:           settings.pickup_location || DEFAULT_SETTINGS.pickup_location,
        date:                   dateFormatee(),
        date_key:               getDateKeyBenin(),
        timestamp:              Date.now(),
        validation_at:          null,
        retrait_effectue_at:    null,
      };

      insertParticipant(participant);
      await persistDatabase();

      const base = process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
      const participantForNotif = { ...participant, preuve_url: base ? base + proofUrl : null };
      notifyOrganizer(participantForNotif, settings).catch((err) => {
        console.warn("Notification WaChap non envoyée (register):", err.message);
      });

      sendJson(response, 201, { ref: id, nom: participant.nom });
      return;
    }

    // ---------------------------------------------------------------------
    // Recuperation de billet : demande du code
    //
    // La reponse est VOLONTAIREMENT identique que l'adresse existe ou non.
    // Repondre "inconnue" transformerait cette route en annuaire : on pourrait
    // tester des milliers d'adresses et apprendre qui participe.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/public/ticket/request" && request.method === "POST") {
      const attenteIp = rateLimit(request, "ticket-req", 60, 60 * 60 * 1000);
      if (attenteIp) {
        sendRateLimited(response, attenteIp, "Trop de demandes. Réessaie dans un moment.");
        return;
      }

      const body = await parseJsonBody(request);
      const email = normalizeEmail(body.email);
      const settings = getSettings();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
        sendJson(response, 400, { error: "Adresse email invalide." });
        return;
      }

      // Plafond par ADRESSE : protege la boite de la personne visee, meme si
      // l'attaquant change d'IP entre chaque demande.
      const attenteEmail = rateLimitKey(`ticket-req-mail:${email}`, 3, 15 * 60 * 1000);
      if (attenteEmail) {
        sendRateLimited(response, attenteEmail, "Un code a déjà été envoyé récemment. Vérifie ta boîte mail.");
        return;
      }

      const trouves = getValidatedParticipantsByEmail(email);

      if (trouves.length) {
        const code = generateTicketCode();
        // Le code est stocke HACHE : une lecture de la base ne donne pas
        // acces aux billets. Une nouvelle demande ecrase la precedente.
        run(
          `INSERT INTO ticket_codes (email, code_hash, expires_at, attempts, created_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(email) DO UPDATE SET
             code_hash = excluded.code_hash,
             expires_at = excluded.expires_at,
             attempts = 0,
             created_at = excluded.created_at`,
          [email, hashPassword(code), Date.now() + TICKET_CODE_TTL_MS, Date.now()],
        );
        // Pas d'attente ici non plus, pour la meme raison de temps de reponse.
        // Perdu sur une coupure, le code se redemande en un clic.
        persistDatabase();

        // Envoi sans l'attendre : une reponse plus lente pour une adresse
        // connue que pour une inconnue revelait qui participe, malgre le
        // message identique.
        sendTicketCodeEmail(email, code, settings).catch((error) => {
          console.warn("Code de billet non envoye:", error.message);
          // En demonstration seulement, et dans la CONSOLE DU SERVEUR
          // uniquement : jamais dans la reponse au navigateur, sinon
          // n'importe qui recupererait le code sans acceder a la boite.
          if (isDemoMode(settings)) {
            console.log(`[DEMO] Code de billet pour ${email} : ${code}`);
          }
        });
      }

      // Meme reponse dans tous les cas, y compris si l'adresse est inconnue.
      sendJson(response, 200, {
        sent: true,
        message: "Si une inscription existe avec cette adresse, un code vient d'être envoyé.",
        expires_in: Math.round(TICKET_CODE_TTL_MS / 1000),
      });
      return;
    }

    // ---------------------------------------------------------------------
    // Recuperation de billet : verification du code
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/public/ticket/verify" && request.method === "POST") {
      const attenteIp = rateLimit(request, "ticket-verify", 100, 15 * 60 * 1000);
      if (attenteIp) {
        sendRateLimited(response, attenteIp, "Trop d'essais. Réessaie dans quelques minutes.");
        return;
      }

      const body = await parseJsonBody(request);
      const email = normalizeEmail(body.email);
      const code = String(body.code || "").trim();

      // Message unique pour tous les echecs : un message different selon que
      // l'adresse est inconnue, le code expire ou le code faux renseignerait
      // l'attaquant a chaque tentative.
      const echec = () => {
        const ipCode = getClientIp(request);
        if (sentinelle.franchit(`codes-email-faux:${ipCode}`, 15, 15 * 60 * 1000)) {
          sentinelle.signaler({ gravite: "alerte", type: "codes_devines", titre: "15 codes de récupération de badge faux en 15 min", ip: ipCode });
        }
        sendJson(response, 401, { error: "Code incorrect ou expiré." });
      };

      if (!email || !/^\d{6}$/.test(code)) { echec(); return; }

      const ligne = statementGet(
        "SELECT code_hash, expires_at, attempts FROM ticket_codes WHERE email = ?",
        [email],
      );
      if (!ligne) { echec(); return; }

      if (Number(ligne.expires_at) < Date.now()) {
        run("DELETE FROM ticket_codes WHERE email = ?", [email]);
        await persistDatabase();
        echec();
        return;
      }

      const essais = Number(ligne.attempts) + 1;
      if (essais > TICKET_CODE_MAX_ATTEMPTS) {
        // Le code est detruit : la force brute sur six chiffres s'arrete a
        // cinq essais, il faut redemander un code et donc acceder a la boite.
        run("DELETE FROM ticket_codes WHERE email = ?", [email]);
        await persistDatabase();
        sendJson(response, 429, { error: "Trop d'essais. Demande un nouveau code." });
        return;
      }

      run("UPDATE ticket_codes SET attempts = ? WHERE email = ?", [essais, email]);
      await persistDatabase();

      // Comparaison a temps constant, assuree par verifyPassword.
      if (!verifyPassword(code, ligne.code_hash).ok) { echec(); return; }

      // Code juste : usage unique, il disparait immediatement.
      run("DELETE FROM ticket_codes WHERE email = ?", [email]);
      const token = createTicketSession(email);

      const billets = getValidatedParticipantsByEmail(email).map((p) => ({
        id: p.id,
        nom: p.nom,
        code: p.code_unique,
        montant: p.montant,
        lieu: p.lieu_retrait,
        date: p.date,
        qr: p.qr_code_url,
        utilise: p.statut_code === "utilise",
        photo: p.participant_photo_url || "",
        qr_matrice: qrMatrice(p.code_unique),
      }));

      sendJson(response, 200, {
        token,
        expires_in: Math.round(TICKET_SESSION_TTL_MS / 1000),
        billets,
      });
      return;
    }

    // ---------------------------------------------------------------------
    // Recuperation de billet : telechargement du PDF
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/public/ticket/pdf" && request.method === "GET") {
      const attenteIp = rateLimit(request, "ticket-pdf", 400, 15 * 60 * 1000)
        || rateLimitKey(`ticket-pdf-jeton:${url.searchParams.get("token") || ""}`, 60, 15 * 60 * 1000);
      if (attenteIp) {
        sendRateLimited(response, attenteIp, "Trop de téléchargements. Patiente un instant.");
        return;
      }

      // `ids` (separes par des virgules) : tous les badges d'un achat dans un
      // seul PDF, une page par badge. `id` : un seul badge.
      const ids = String(url.searchParams.get("ids") || url.searchParams.get("id") || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_BILLETS_PAR_ACHAT);
      const participants = [];
      for (const id of ids.length ? ids : [""]) {
        const resultat = getParticipantForTicketSession(url.searchParams.get("token"), id);
        if (resultat.erreur === "session") {
          sendJson(response, 401, { error: "Session expirée. Redemande un code." });
          return;
        }
        if (resultat.erreur) {
          // Meme reponse pour "introuvable", "interdit" et "non valide" : dire
          // que le billet existe mais appartient a un autre serait deja trop.
          sendJson(response, 404, { error: "Badge introuvable." });
          return;
        }
        participants.push(resultat.participant);
      }

      const pdf = await renderTicketPdf(participants.length === 1 ? participants[0] : participants);
      const nomFichier = participants.length === 1
        ? `badge-${participants[0].code_unique}.pdf`
        : `badges-feja-${participants.length}.pdf`;
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${nomFichier}"`,
        "Content-Length": pdf.length,
        "Cache-Control": "no-store",
      });
      response.end(pdf);
      return;
    }

    if (url.pathname === "/api/payments/create" && request.method === "POST") {
      // Chaque appel ecrit une photo sur le disque et cree un client chez
      // FedaPay. Sans plafond, une boucle remplissait le disque du serveur et
      // polluait le compte de paiement.
      const retryAfter = rateLimit(request, "payment", 60, 10 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop d'inscriptions depuis cet appareil. Réessaie dans quelques minutes.");
        return;
      }

      if (inscriptionsSuspendues(request)) {
        sendJson(response, 503, { error: "Les inscriptions sont momentanément suspendues. Réessaie dans un moment." });
        return;
      }

      const body = await parseJsonBody(request);
      const settings = getSettings();
      const telephone = String(body.telephone || "").trim();
      const email = String(body.email || "").trim();

      // Plafond par acheteur : c'est lui qui protege du remplissage du disque,
      // le plafond par IP restant large a cause des IP partagees.
      const attenteAcheteur = rateLimitKey(`payment-mail:${email.toLowerCase()}`, 6, 10 * 60 * 1000);
      if (attenteAcheteur) {
        sendRateLimited(response, attenteAcheteur, "Trop d'inscriptions avec cette adresse. Réessaie dans quelques minutes.");
        return;
      }
      const billetsDemandes = lireBilletsDemandes(body);

      if (!billetsDemandes.length) {
        sendJson(response, 400, { error: "Aucun badge demande." });
        return;
      }

      if (billetsDemandes.length > MAX_BILLETS_PAR_ACHAT) {
        sendJson(response, 400, {
          error: "Maximum " + MAX_BILLETS_PAR_ACHAT + " badges par achat. Pour un groupe plus grand, contacte l'organisation.",
        });
        return;
      }

      if (!telephone || !email) {
        sendJson(response, 400, { error: "Telephone et email de l'acheteur sont obligatoires." });
        return;
      }

      // Chaque billet doit porter un nom ET une photo : c'est ce couple qui
      // permet de verifier a l'entree que le porteur est bien la personne.
      for (let i = 0; i < billetsDemandes.length; i += 1) {
        const b = billetsDemandes[i];
        const rang = billetsDemandes.length > 1 ? " du badge " + (i + 1) : "";
        if (!b.nom || !b.photo) {
          sendJson(response, 400, { error: "Nom et photo" + rang + " sont obligatoires." });
          return;
        }
        // Bornes de saisie : rien ne les verifiait, on pouvait stocker un nom de
        // plusieurs megaoctets ou une adresse email qui n'en est pas une (et le
        // participant ne recevait alors jamais son code).
        const invalid = validateParticipantInput({ nom: b.nom, telephone, email });
        if (invalid) {
          // Le rang est indispensable des qu'il y a plusieurs noms : sans lui,
          // l'acheteur de cinq billets ne sait pas lequel corriger.
          sendJson(response, 400, {
            error: billetsDemandes.length > 1 ? "Badge " + (i + 1) + " : " + invalid : invalid,
            billet: i + 1,
          });
          return;
        }
      }

      // Un identifiant commun a tout l'achat. Genere avant les lignes : elles
      // doivent toutes le porter des l'insertion, sinon un paiement confirme
      // entre-temps ne validerait qu'une partie du groupe.
      const groupeId = "GRP-" + crypto.randomBytes(9).toString("hex").toUpperCase();
      const construire = (billet, index) =>
        buildPendingParticipant(body, settings, billet, {
          id: groupeId,
          index: index + 1,
          taille: billetsDemandes.length,
        });

      const resume = (ligne) => ({
        id: ligne.id,
        nom: ligne.nom,
        telephone: ligne.telephone,
        email: ligne.email,
        montant: ligne.montant,
        statut_paiement: ligne.statut_paiement,
      });

      // En demonstration, on n'appelle jamais l'operateur : getPaymentCredentials
      // leverait "Cle secrete de paiement non configuree" et bloquerait tout.
      if (isDemoMode(settings)) {
        const demos = billetsDemandes.map((billet, index) => {
          const d = construire(billet, index);
          d.paiement = DEMO_PAYMENT_TAG;
          d.operateur_paiement = "Démonstration";
          d.fedapay_status = "demo_pending";
          insertParticipant(d);
          return d;
        });
        await persistDatabase();

        // La premiere ligne porte le paiement : c'est son identifiant que la
        // page de retour interroge, et c'est par elle qu'on retrouve le groupe.
        const demoParticipant = demos[0];

        const operateurDemo = String(body.operateur || "").trim();
        const directDemo = paiementDirectPossible(body.pays || body.country, operateurDemo, settings);

        sendJson(response, 201, {
          demo: true,
          // En demonstration on simule les deux chemins, pour pouvoir essayer
          // l'attente sur place sans cle de paiement.
          mode: directDemo ? "direct" : "redirect",
          operateur: directDemo ? operateurDemo : null,
          participant: resume(demoParticipant),
          billets: demos.map(resume),
          transaction: { id: `demo-${demoParticipant.id}`, reference: `DEMO-${demoParticipant.id}`, status: "pending" },
          // On renvoie directement la page de retour : c'est elle qui
          // interroge /api/payments/status, lequel validera le paiement.
          checkout_url: `/retour-paiement.html?p=${encodeURIComponent(demoParticipant.id)}`,
        });
        return;
      }

      getPaymentCredentials(settings);
      const groupe = billetsDemandes.map(construire);
      const participant = groupe[0];   // porte le paiement pour tout l'achat
      const customer = await createPaymentCustomer(settings, participant);
      const transaction = await createPaymentTransaction(settings, participant, customer, groupe.length);
      const transactionId = String(transaction.id || "");

      if (!transactionId) {
        throw new Error("Transaction de paiement non creee.");
      }

      if (getParticipantByFedapayTransactionId(transactionId)) {
        throw new Error("Cette transaction est deja liee a une inscription.");
      }

      // Toutes les lignes portent la meme transaction : la finalisation les
      // valide ensemble, et un rejeu sur une autre inscription reste detecte.
      groupe.forEach((ligne) => {
        ligne.fedapay_transaction_id = transactionId;
        ligne.fedapay_customer_id = customer.id ? String(customer.id) : null;
        ligne.fedapay_reference = transaction.reference || transaction.merchant_reference || participant.id;
        ligne.fedapay_status = transaction.status || "pending";
        insertParticipant(ligne);
      });

      // Le jeton sert aux deux chemins : la page hebergee s'ouvre avec lui, et
      // la demande envoyee au telephone le porte aussi.
      const checkout = await createPaymentToken(settings, transactionId);

      // Paiement sans redirection. Le client recoit la demande sur son
      // telephone et valide avec son code : il ne quitte jamais le site.
      const operateur = String(body.operateur || "").trim();
      if (paiementDirectPossible(body.pays || body.country, operateur, settings)) {
        try {
          await demanderPaiementMobile(settings, checkout.token, operateur, telephone, body.pays || body.country);

          sendJson(response, 201, {
            mode: "direct",
            operateur,
            participant: resume(participant),
            billets: groupe.map(resume),
            transaction: {
              id: transactionId,
              reference: participant.fedapay_reference,
              status: participant.fedapay_status,
            },
          });
          return;
        } catch (erreur) {
          // On ne laisse jamais un acheteur sans issue : la page hebergee
          // couvre les memes operateurs. L'echec est journalise pour qu'une
          // route d'operateur devenue fausse finisse par se voir.
          console.warn("Paiement direct impossible, retour a la page hebergee:", erreur.message);
        }
      }

      sendJson(response, 201, {
        mode: "redirect",
        participant: resume(participant),
        billets: groupe.map(resume),
        transaction: {
          id: transactionId,
          reference: participant.fedapay_reference,
          status: participant.fedapay_status,
        },
        checkout_url: checkout.url,
      });
      return;
    }

    if (url.pathname === "/api/payments/status" && request.method === "POST") {
      // Cette route renvoie le code d'entree du participant : sans plafond,
      // elle permettait de moissonner les codes en essayant des identifiants.
      // La page de retour interroge jusqu'a 10 fois, d'ou une limite large.
      const retryAfter = rateLimit(request, "status", 600, 10 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop de requêtes. Patiente quelques minutes.");
        return;
      }

      const body = await parseJsonBody(request);
      const settings = getSettings();
      const participantId = String(body.participant_id || "").trim();
      const requestedTransactionId = String(body.fedapay_transaction_id || body.transaction_id || "").trim();

      if (!participantId) {
        sendJson(response, 400, { error: "Participant obligatoire." });
        return;
      }

      // Plafond par achat : chaque appel peut interroger FedaPay. L'attente
      // d'un paiement (une requete toutes les 3 a 6 s) reste tres en dessous.
      const attenteAchat = rateLimitKey(`status-achat:${participantId}`, 120, 10 * 60 * 1000);
      if (attenteAchat) {
        sendRateLimited(response, attenteAchat, "Trop de requêtes. Patiente quelques minutes.");
        return;
      }

      const participant = getParticipantById(participantId);
      if (!participant) {
        sendJson(response, 404, { error: "Participant introuvable." });
        return;
      }

      // Inscription de demonstration : on valide sur place. Interroger FedaPay
      // n'aurait aucun sens, la transaction n'existe pas chez eux.
      if (String(participant.paiement || "") === DEMO_PAYMENT_TAG) {
        const result = await finalizePaidParticipant(
          participant,
          buildDemoTransaction(participant, settings),
          settings,
        );
        sendJson(response, 200, {
          status: "approved",
          demo: true,
          participant: result.participant,
          // Tous les billets de l'achat : la page de retour les aligne pour
          // que l'acheteur telecharge celui de chacun.
          billets: (result.billets || [result.participant]).map(billetPublic),
          email_sent: result.emailSent,
          already_finalized: result.alreadyFinalized,
          // Jeton de telechargement du billet. Le participant vient de payer
          // et se trouve sur SA page de retour : lui faire redemander un code
          // par e-mail pour un billet qu'il vient d'acheter serait absurde.
          ticket_token: createTicketSession(result.participant.email),
        });
        return;
      }

      // Au retour de FedaPay on ne dispose que de l'id participant : on
      // retombe alors sur la transaction deja enregistree a l'inscription.
      const fedapayTransactionId = requestedTransactionId || String(participant.fedapay_transaction_id || "");

      if (!fedapayTransactionId) {
        sendJson(response, 400, { error: "Aucune transaction associee a ce participant." });
        return;
      }

      if (String(participant.fedapay_transaction_id || "") !== fedapayTransactionId) {
        sendJson(response, 400, { error: "Transaction non associee a ce participant." });
        return;
      }

      const transaction = await getPaymentTransaction(fedapayTransactionId, settings);
      updateParticipantPaymentStatus(participant.id, transaction);

      if (String(transaction.status || "").toLowerCase() === "approved") {
        const result = await finalizePaidParticipant(participant, transaction, settings);
        if (!result.alreadyFinalized) {
          notifyOrganizer(result.participant, settings).catch((error) => {
            console.warn("Notification WaChap non envoyee:", error.message);
          });
        }

        sendJson(response, 200, {
          status: "approved",
          participant: result.participant,
          billets: (result.billets || [result.participant]).map(billetPublic),
          email_sent: result.emailSent,
          already_finalized: result.alreadyFinalized,
          ticket_token: createTicketSession(result.participant.email),
        });
        return;
      }

      sendJson(response, 200, {
        status: transaction.status || "pending",
        reference: transaction.reference || participant.fedapay_reference,
      });
      return;
    }

    if (url.pathname === "/api/participants" && request.method === "POST") {
      const retryAfter = rateLimit(request, "status", 600, 10 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop de requêtes. Patiente quelques minutes.");
        return;
      }

      const body = await parseJsonBody(request);
      const settings = getSettings();
      const participantId = String(body.participant_id || body.id || "").trim();
      const fedapayTransactionId = String(body.fedapay_transaction_id || body.transaction_id || "").trim();

      if (!participantId || !fedapayTransactionId) {
        sendJson(response, 400, { error: "Participant et transaction de paiement obligatoires." });
        return;
      }

      const participant = getParticipantById(participantId);
      if (!participant) {
        sendJson(response, 404, { error: "Participant introuvable." });
        return;
      }

      if (String(participant.fedapay_transaction_id || "") !== fedapayTransactionId) {
        sendJson(response, 400, { error: "Transaction non associee a ce participant." });
        return;
      }

      const paymentTransaction = await verifyPaymentTransaction(fedapayTransactionId, participant, settings);
      const result = await finalizePaidParticipant(participant, paymentTransaction, settings);

      if (!result.alreadyFinalized) {
        notifyOrganizer(result.participant, settings).catch((error) => {
          console.warn("Notification WaChap non envoyee:", error.message);
        });
      }

      sendJson(response, 200, {
        participant: result.participant,
        email_sent: result.emailSent,
        already_finalized: result.alreadyFinalized,
      });

      return;
    }

    if (url.pathname === "/api/fedapay/webhook" && request.method === "POST") {
      // FedaPay n'envoie que quelques notifications par paiement ; au-dela,
      // c'est un robot qui tente de remplir la base.
      const attenteWebhook = rateLimit(request, "webhook", 300, 10 * 60 * 1000);
      if (attenteWebhook) {
        sendRateLimited(response, attenteWebhook, "Trop de notifications.");
        return;
      }

      const settings = getSettings();
      const { body, raw } = await parseJsonBodyWithRaw(request);

      if (!verifyFedapayWebhookSignature(request, raw, settings)) {
        sentinelle.signaler({ gravite: "critique", type: "webhook_signature", titre: "Fausse notification FedaPay refusée (signature invalide)",
          ip: getClientIp(request) });
        sendJson(response, 401, { error: "Signature webhook invalide." });
        return;
      }

      const transaction = extractFedapayTransaction(body);
      const eventType = String(body.name || body.type || body.event || "");
      const eventId = String(body.id || body.event_id || `${eventType || "fedapay"}-${transaction?.id || Date.now()}`);

      if (getWebhookEventById(eventId)) {
        sendJson(response, 200, { received: true, duplicate: true });
        return;
      }

      const isApprovedEvent =
        transaction &&
        (String(transaction.status || "").toLowerCase() === "approved" || eventType.toLowerCase().includes("approved"));

      const participantConnu = transaction && transaction.id ? getParticipantByFedapayTransactionId(transaction.id) : null;

      if (isApprovedEvent && participantConnu) {
        const verifiedTransaction = await verifyPaymentTransaction(transaction.id, participantConnu, settings);
        const result = await finalizePaidParticipant(participantConnu, verifiedTransaction, settings);
        if (!result.alreadyFinalized) {
          notifyOrganizer(result.participant, settings).catch((error) => {
            console.warn("Notification WaChap non envoyee:", error.message);
          });
        }
      }

      // Seules les notifications d'une transaction du site sont gardees, et
      // tronquees : sans secret configure, n'importe qui peut poster ici, et
      // chaque message de 5 Mo gonflait la base reecrite a chaque inscription.
      if (participantConnu) {
        insertWebhookEvent({
          id: eventId,
          type: eventType,
          object_id: String(transaction.id),
          payload: JSON.stringify(body).slice(0, 20000),
          created_at: Date.now(),
        });
        await persistDatabase();
      } else if (sentinelle.franchit(`webhook-inconnu:${getClientIp(request)}`, 5, 60 * 60 * 1000)) {
        sentinelle.signaler({ gravite: "alerte", type: "webhook_inconnu", titre: "Notifications FedaPay pour des transactions inconnues",
          ip: getClientIp(request), details: [["Exemple", `${eventType || "?"} / transaction ${transaction && transaction.id}`]] });
      }

      sendJson(response, 200, { received: true });
      return;
    }

    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      // 10 essais par quart d'heure et par adresse : un humain qui se trompe
      // n'est pas gene, une force brute est arretee net.
      const retryAfter = rateLimit(request, "login", 10, 15 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop de tentatives. Reessayez dans quelques minutes.");
        return;
      }

      const body = await parseJsonBody(request);
      const settings = getSettings();
      const submitted = String(body.password || "");

      const adminCheck = verifyPassword(submitted, settings.admin_password || DEFAULT_SETTINGS.admin_password);

      if (adminCheck.ok) {
        if (adminCheck.needsRehash) {
          saveSettings({ admin_password: hashPassword(submitted) });
        }
        noterConnexionAdmin(getClientIp(request), settings);
        sendJson(response, 200, { token: createSession("admin"), role: "admin" });
        return;
      }

      // Mot de passe dedie aux postes de scan. Tant qu'il n'est pas defini,
      // seul le mot de passe admin ouvre l'app de scan : le comportement
      // d'avant, pour ne pas bloquer une installation existante.
      const scanPassword = String(settings.scan_password || "");
      if (scanPassword) {
        const scanCheck = verifyPassword(submitted, scanPassword);
        if (scanCheck.ok) {
          if (scanCheck.needsRehash) {
            saveSettings({ scan_password: hashPassword(submitted) });
          }
          sendJson(response, 200, { token: createSession("scan"), role: "scan" });
          return;
        }
      }

      const ipEchec = getClientIp(request);
      if (sentinelle.franchit(`admin-echec:${ipEchec}`, 5, 15 * 60 * 1000)) {
        sentinelle.signaler({ gravite: "alerte", type: "admin_echecs", titre: "Mots de passe admin faux en série (5 en 15 min)", ip: ipEchec });
      }
      // Beaucoup d'echecs depuis des adresses differentes : force brute
      // distribuee, que la limite par IP ne voit pas.
      if (sentinelle.franchit("admin-echec-total", 20, 60 * 60 * 1000)) {
        sentinelle.signaler({ gravite: "critique", type: "admin_echecs", titre: "20 mots de passe admin faux en une heure", cle: "admin-echec-total" });
      }
      sendJson(response, 401, { error: "Mot de passe incorrect." });
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const role = getSessionRole(request);

      if (!role) {
        sendJson(response, 401, { error: "Session admin invalide." });
        return;
      }

      // Un jeton de scan ne donne acces qu'aux ecrans de controle a l'entree.
      if (role !== "admin" && !SCAN_ALLOWED_PATHS.has(url.pathname)) {
        sendJson(response, 403, { error: "Cette action demande le compte administrateur." });
        return;
      }

      if (url.pathname === "/api/admin/participants" && request.method === "GET") {
        const participants = getParticipants();
        const normalized = participants.map(normalizeParticipant);
        sendJson(response, 200, { participants: normalized, stats: getStats(participants) });
        return;
      }

      if (url.pathname === "/api/admin/settings" && request.method === "GET") {
        sendJson(response, 200, maskSecretSettings(getSettings()));
        return;
      }

      if (url.pathname === "/api/admin/settings" && request.method === "PUT") {
        const body = await parseJsonBody(request);
        const toSave = {};
        const ignored = [];

        Object.entries(body).forEach(([key, value]) => {
          const target = SETTINGS_KEY_MAP[key];

          // Liste blanche stricte. L'ancien code retombait sur la cle brute
          // quand elle etait absente du map : les champs non traduits (cle
          // FedaPay, environnement, URL publique...) etaient alors ecrits dans
          // une cle camelCase que le serveur ne lit jamais. L'admin affichait
          // "enregistre" sans aucun effet.
          if (!target) {
            ignored.push(key);
            return;
          }

          if (Array.isArray(target)) {
            target.forEach((name) => { toSave[name] = value; });
          } else {
            toSave[target] = value;
          }
        });

        if (ignored.length) {
          console.warn("Reglages ignores (cles inconnues):", ignored.join(", "));
        }

        // Les textes du badge sont dessines tels quels : un texte demesure ne
        // casserait rien (il serait reduit) mais n'a aucune raison d'exister.
        Object.keys(toSave).filter((k) => k.startsWith("badge_")).forEach((k) => {
          toSave[k] = String(toSave[k] == null ? "" : toSave[k]).slice(0, 400);
        });
        // Date de bascule ramenee a JJ/MM ; une saisie illisible reprend le 30/08.
        if (toSave.badge_bascule !== undefined) {
          const b = BadgeLayout.lireBascule(toSave.badge_bascule);
          toSave.badge_bascule = `${String(b.jour).padStart(2, "0")}/${String(b.mois).padStart(2, "0")}`;
        }

        // Les champs secrets reviennent masques du navigateur quand ils n'ont
        // pas ete retouches : les reecrire tels quels effacerait la vraie
        // valeur. On ignore donc toute valeur strictement egale au masque.
        SECRET_SETTING_KEYS.forEach((name) => {
          if (toSave[name] === SECRET_MASK) delete toSave[name];
        });

        // Un mot de passe n'est jamais stocke en clair.
        ["admin_password", "scan_password"].forEach((name) => {
          if (typeof toSave[name] !== "string") return;
          const value = toSave[name];
          if (!value) {
            // Champ laisse vide : on ne touche pas au mot de passe existant.
            // Seul scan_password peut etre remis a vide volontairement.
            if (name === "admin_password") delete toSave[name];
            return;
          }
          toSave[name] = hashPassword(value);
        });

        signalerReglagesSensibles(getSettings(), toSave, getClientIp(request));
        saveSettings(toSave);
        // Un changement de parametre SMTP doit prendre effet tout de suite :
        // sans cela, le transporteur en cache garderait l'ancienne connexion.
        if (Object.keys(toSave).some((k) => k.startsWith("smtp_") || k === "mail_from")) {
          mail.resetTransport();
        }
        // Une annee de badge saisie en retard sur l'edition en cours est
        // avancee aussitot, pour que l'admin affiche ce qui sera imprime.
        if (Object.keys(toSave).some((k) => k.startsWith("badge_"))) appliquerBasculeBadge();
        sendJson(response, 200, maskSecretSettings(getSettings()));
        return;
      }

      // Media anime de l'en-tete. Route separee : la limite de corps est bien
      // plus haute que pour une image, et le fichier n'est pas retraite.
      if (url.pathname === "/api/admin/branding/hero-media") {
        if (request.method === "POST") {
          // 20 Mo : le base64 gonfle le fichier d'environ un tiers, il faut
          // donc plus que la limite de 12 Mo appliquee au fichier lui-meme.
          const body = await parseJsonBody(request, 20 * 1024 * 1024);
          const media = saveHeroMedia(body.media_base64);
          // Un nouvel import reactive l'affichage : sans cela, on televerse un
          // fichier et rien ne change a l'ecran, ce qui laisse croire a un bug.
          saveSettings({ hero_media_url: media.url, hero_media_active: "1" });
          sendJson(response, 200, media);
          return;
        }

        if (request.method === "DELETE") {
          removeHeroMedia();
          saveSettings({ hero_media_url: "" });
          sendJson(response, 200, { url: "" });
          return;
        }
      }

      if (url.pathname === "/api/admin/branding/logo" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const logoUrl = saveBrandingLogo(body.logo_base64);
        clearTicketCache();
        saveSettings({ logo_url: logoUrl });
        // Reduction faite ici, pendant que l'organisateur attend : sinon le
        // premier visiteur suivant paierait le decodage du logo d'origine.
        getTicketLogoPath(getSettings());
        sendJson(response, 200, { logo_url: logoUrl });
        return;
      }

      // Journal de securite et destinataire des alertes.
      if (url.pathname === "/api/admin/securite" && request.method === "GET") {
        const settings = getSettings();
        const source = String(process.env.MAIL_SECURITE_TO || "").trim()
          ? "fichier .env (MAIL_SECURITE_TO)"
          : String(settings.securite_email || "").trim() ? "réglage ci-dessus" : "adresse des alertes internes";
        sendJson(response, 200, {
          destinataire: new mail.AlerteSecuriteEmail({ settings }).destinataire() || "",
          source,
          dernierEnvoi: sentinelle.dernierEnvoi,
          evenements: sentinelle.journal(150),
        });
        return;
      }

      if (url.pathname === "/api/admin/securite/test" && request.method === "POST") {
        const resultat = await sentinelle.tester(getClientIp(request));
        sendJson(response, resultat.ok ? 200 : 502, resultat);
        return;
      }

      // Donnees d'exemple pour l'apercu du badge dans l'admin : la page n'a
      // pas de quoi calculer un QR elle-meme.
      if (url.pathname === "/api/admin/badge/exemple" && request.method === "GET") {
        sendJson(response, 200, { code: "K7MQ2X", qr_matrice: qrMatrice("K7MQ2X") });
        return;
      }

      if (url.pathname === "/api/admin/branding/logo" && request.method === "DELETE") {
        removeBrandingLogo();
        clearTicketCache();
        saveSettings({ logo_url: "" });
        sendJson(response, 200, { logo_url: "" });
        return;
      }

      // Mode demonstration. L'extinction efface les inscriptions d'essai :
      // c'est le comportement demande, on previent donc dans la reponse
      // combien de lignes ont ete supprimees.
      if (url.pathname === "/api/admin/demo" && request.method === "GET") {
        const current = getSettings();
        sendJson(response, 200, {
          enabled: isDemoMode(current),
          demo_participants: statementGet(
            "SELECT COUNT(*) AS n FROM participants WHERE paiement = ?", [DEMO_PAYMENT_TAG],
          ).n,
        });
        return;
      }

      if (url.pathname === "/api/admin/demo" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const enabled = body.enabled === true || body.enabled === "1";
        let purged = 0;

        if (!enabled) {
          purged = purgeDemoParticipants();
        }

        const etaitActif = isDemoMode(getSettings());
        saveSettings({ demo_mode: enabled ? "1" : "0" });
        if (enabled && !etaitActif) {
          sentinelle.signaler({ gravite: "critique", type: "demo", titre: "Mode démonstration ACTIVÉ : badges délivrés sans paiement",
            ip: getClientIp(request), cle: `demo-on:${Date.now()}` });
        } else if (!enabled && etaitActif) {
          sentinelle.signaler({ gravite: "info", type: "demo", titre: `Mode démonstration désactivé (${purged} inscription(s) d'essai supprimée(s))`,
            ip: getClientIp(request) });
        }
        console.log(enabled
          ? "MODE DEMONSTRATION ACTIVE : les inscriptions ne sont plus payees."
          : `Mode demonstration desactive. ${purged} inscription(s) d'essai supprimee(s).`);

        sendJson(response, 200, { enabled, purged });
        return;
      }

      // Billet PDF d'un participant, pour l'imprimer ou le montrer sur place.
      if (url.pathname === "/api/admin/ticket.pdf" && request.method === "GET") {
        const participantId = String(url.searchParams.get("id") || "").trim();
        const participant = participantId ? getParticipantById(participantId) : null;

        if (!participant) {
          sendJson(response, 404, { error: "Participant introuvable." });
          return;
        }

        if (!participant.code_unique) {
          sendJson(response, 400, { error: "Ce participant n'a pas encore de code : valide d'abord son paiement." });
          return;
        }

        const pdf = await renderTicketPdf(participant);
        const nom = `badge-${participant.code_unique}.pdf`;
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          // inline : le billet s'ouvre dans l'onglet, donc montrable tout de
          // suite au participant sans passer par le dossier de telechargement.
          "Content-Disposition": `inline; filename="${nom}"`,
          "Content-Length": pdf.length,
          "Cache-Control": "no-store",
        });
        response.end(pdf);
        return;
      }

      if (url.pathname === "/api/admin/stats" && request.method === "GET") {
        sendJson(response, 200, buildStats());
        return;
      }

      // Export tableur de la liste des participants.
      if (url.pathname === "/api/admin/export.csv" && request.method === "GET") {
        const csv = buildParticipantsCsv();
        const settings = getSettings();
        const base = (settings.event_name || DEFAULT_SETTINGS.event_name)
          .toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const nom = `${base}-participants-${getDateKeyBenin()}.csv`;

        response.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${nom}"`,
          "Content-Length": Buffer.byteLength(csv, "utf8"),
          "Cache-Control": "no-store",
        });
        response.end(csv);
        return;
      }

      // Rapport a montrer ou a imprimer, en PDF ou en Word. Le CSV sert a
      // retraiter les donnees, le rapport a les presenter.
      const rapportMatch = url.pathname.match(/^\/api\/admin\/rapport\.(pdf|docx)$/);
      if (rapportMatch && request.method === "GET") {
        const format = rapportMatch[1];
        const settings = getSettings();
        const base = (settings.event_name || DEFAULT_SETTINGS.event_name)
          .toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const nom = `${base}-rapport-${getDateKeyBenin()}.${format}`;

        const fichier = format === "pdf"
          ? await renderRapportPdf(settings)
          : await renderRapportDocx(settings);

        response.writeHead(200, {
          "Content-Type": format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          // Le PDF s'ouvre dans l'onglet pour etre montre tout de suite ; le
          // Word n'a aucun interet a l'ecran, il part en telechargement.
          "Content-Disposition": `${format === "pdf" ? "inline" : "attachment"}; filename="${nom}"`,
          "Content-Length": fichier.length,
          "Cache-Control": "no-store",
        });
        response.end(fichier);
        return;
      }

      // Diagnostic SMTP : teste la connexion et l'authentification SANS
      // envoyer de message. Permet de distinguer un probleme de connexion
      // d'un probleme de remise.
      if (url.pathname === "/api/admin/mail/verify" && request.method === "GET") {
        const settings = getSettings();
        const resultat = await mail.verifySmtp(settings);
        const cfg = mail.getSmtpConfig(settings);
        sendJson(response, 200, {
          ok: resultat.ok,
          raison: resultat.raison || null,
          // Jamais le mot de passe : cette reponse part vers un navigateur.
          hote: cfg ? cfg.host : null,
          port: cfg ? cfg.port : null,
          chiffrement: cfg ? (cfg.secure ? "TLS implicite (465)" : "STARTTLS") : null,
          utilisateur: cfg ? cfg.user : null,
          expediteur: mail.getFromAddress(settings, settings.event_name) || null,
          voie: cfg ? "smtp" : (settings.resend_api_key || process.env.RESEND_API_KEY ? "resend" : "aucune"),
        });
        return;
      }

      // Envoi reel d'un message de test.
      if (url.pathname === "/api/admin/mail/test" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const settings = getSettings();
        const destinataire = String(body.email || "").trim() ||
          String(settings.alert_email || "").trim() ||
          String(settings.vendeur_email || "").trim();

        if (!destinataire || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(destinataire)) {
          sendJson(response, 400, { error: "Adresse de destination invalide." });
          return;
        }

        try {
          let envoi;
          if (body.modele === "confirmation") {
            // Exemple de l'e-mail que recoit un participant, badge PDF compris,
            // pour juger le rendu reel dans une vraie messagerie.
            const exemple = {
              id: "EXEMPLE",
              nom: "Participant Exemple",
              email: destinataire,
              code_unique: "K7MQ2X",
              montant: `${getParticipationAmount(settings).toLocaleString("fr-FR").replace(/[  ]/g, " ")} FCFA`,
              montant_valeur: getParticipationAmount(settings),
              lieu_retrait: settings.pickup_location || "",
              validation_at: Date.now(),
            };
            envoi = await new mail.PaiementConfirmeEmail({
              settings,
              baseUrl: getPublicBaseUrl(settings),
              participant: exemple,
              billets: [exemple],
              attachments: [{ filename: "badge-exemple.pdf", content: await renderTicketPdf(exemple, settings) }],
            }).send();
          } else {
            envoi = await new mail.EmailDeTest({
              settings,
              baseUrl: getPublicBaseUrl(settings),
              email: destinataire,
            }).send();
          }
          sendJson(response, 200, { ok: true, destinataire, voie: envoi.voie });
        } catch (error) {
          sendJson(response, 502, { error: error.message });
        }
        return;
      }

      if (url.pathname === "/api/admin/health" && request.method === "GET") {
        sendJson(response, 200, getConfigHealth());
        return;
      }

      if (url.pathname === "/api/admin/theme" && request.method === "GET") {
        sendJson(response, 200, {
          current: resolveTheme(),
          presets: Object.entries(THEME_PRESETS).map(([key, preset]) => ({
            key,
            label: preset.label,
            colors: preset.colors,
          })),
        });
        return;
      }

      if (url.pathname === "/api/admin/theme" && request.method === "PUT") {
        const body = await parseJsonBody(request);
        const preset = THEME_PRESETS[body.preset] ? body.preset : DEFAULT_THEME_PRESET;
        const custom = {};

        if (body.custom && typeof body.custom === "object") {
          Object.entries(body.custom).forEach(([key, value]) => {
            // On ne garde que des cles connues et des couleurs valides : le
            // theme est reinjecte tel quel dans du CSS.
            if (THEME_PRESETS[preset].colors[key] !== undefined && hexToRgb(value)) {
              custom[key] = String(value).trim().toLowerCase();
            }
          });
        }

        // Rotation : on ne garde que des presets connus, sans doublon.
        let rotation = [];
        if (Array.isArray(body.rotation)) {
          rotation = [...new Set(body.rotation.filter((key) => THEME_PRESETS[key]))];
        }

        saveSettings({
          theme_preset: preset,
          theme_custom_json: JSON.stringify(custom),
          theme_rotation_json: JSON.stringify(rotation),
        });
        sendJson(response, 200, { current: resolveTheme() });
        return;
      }

      if (url.pathname === "/api/admin/validate-payment" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const participant = getParticipantById(body.id);
        const settings = getSettings();

        if (!participant) {
          sendJson(response, 404, { error: "Participant introuvable." });
          return;
        }

        if (participant.statut_paiement === "Valide") {
          sendJson(response, 200, { participant, email_sent: false });
          return;
        }

        const codeUnique = generateUniqueCode();
        const qrCodeUrl = await saveQrCode(codeUnique, participant.id);
        const validationAt = Date.now();
        run(
          `
            UPDATE participants
            SET statut_paiement = ?, code_unique = ?, statut_code = ?, qr_code_url = ?, lieu_retrait = ?, validation_at = ?
            WHERE id = ?
          `,
          ["Valide", codeUnique, "actif", qrCodeUrl, participant.lieu_retrait || settings.pickup_location, validationAt, participant.id],
        );
        await persistDatabase();
        sentinelle.signaler({
          gravite: "alerte",
          type: "validation_manuelle",
          titre: "Badge validé à la main dans l'admin (sans paiement FedaPay)",
          ip: getClientIp(request),
          cle: `manuel:${participant.id}`,
          details: [["Participant", `${participant.nom} (${participant.id})`], ["Code délivré", codeUnique]],
        });

        const updatedParticipant = getParticipantById(participant.id);
        const emailSent = await sendValidationEmail(updatedParticipant, settings).catch((error) => {
          console.error("Email Resend non envoye:", error.message);
          return false;
        });

        sendJson(response, 200, { participant: updatedParticipant, email_sent: emailSent });
        return;
      }

      if (url.pathname === "/api/admin/mark-item" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const participantId = String(body.participant_id || "").trim();
        const itemId = String(body.item_id || "").trim();
        const received = body.received !== false; // true par défaut
        if (!participantId || !itemId) {
          sendJson(response, 400, { error: "participant_id et item_id obligatoires." });
          return;
        }
        const p = getParticipantById(participantId);
        if (!p) { sendJson(response, 404, { error: "Participant introuvable." }); return; }
        let items = {};
        try { items = JSON.parse(p.items_received || "{}"); } catch {}
        items[itemId] = received;
        run("UPDATE participants SET items_received = ? WHERE id = ?", [JSON.stringify(items), participantId]);
        await persistDatabase();
        sendJson(response, 200, { participant_id: participantId, item_id: itemId, received, items_received: items });
        return;
      }

      // Instantane telecharge par l'app de scan pour fonctionner sans reseau.
      // On n'envoie que le strict necessaire a l'ecran de controle.
      if (url.pathname === "/api/admin/scan/snapshot" && request.method === "GET") {
        const settings = getSettings();
        let eventItems = [];
        try { eventItems = JSON.parse(settings.event_items_json || "[]"); } catch {}

        const codes = getParticipants()
          .filter((p) => p.statut_paiement === "Valide" && p.code_unique)
          .map((p) => {
            let itemsReceived = {};
            try { itemsReceived = JSON.parse(p.items_received || "{}"); } catch {}
            return {
              code: String(p.code_unique).toUpperCase(),
              id: p.id,
              nom: p.nom,
              // Photo du participant : c'est elle qui permet au controleur de
              // verifier que le porteur du billet est bien la personne
              // inscrite. L'app de scan la telecharge et la garde en local
              // pour rester utilisable sans reseau.
              photo: p.participant_photo_url || "",
              montant: p.montant,
              lieu_retrait: p.lieu_retrait,
              used: p.statut_code === "utilise",
              used_at: p.retrait_effectue_at || null,
              items_received: itemsReceived,
            };
          });

        sendJson(response, 200, {
          version: Date.now(),
          event_name: settings.event_name || DEFAULT_SETTINGS.event_name,
          event_items: eventItems,
          codes,
        });
        return;
      }

      // Remontee des scans faits hors-ligne. Chaque scan est idempotent : si le
      // code a deja ete consomme AILLEURS (autre telephone), on ne l'ecrase pas
      // et on renvoie "conflict" pour que l'agent soit alerte.
      if (url.pathname === "/api/admin/scan/sync" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const scans = Array.isArray(body.scans) ? body.scans : [];
        const deviceId = String(body.device_id || "").trim() || "inconnu";
        const results = [];

        for (const scan of scans) {
          const code = String(scan.code || "").trim().toUpperCase();
          const scannedAt = Number(scan.scanned_at) || Date.now();

          if (!code) {
            results.push({ code, status: "invalid" });
            continue;
          }

          const participant = getParticipantByCode(code);

          if (!participant || participant.statut_paiement !== "Valide") {
            results.push({ code, status: "not_found" });
            continue;
          }

          if (participant.statut_code === "utilise") {
            const sameDevice = String(participant.scan_device_id || "") === deviceId;
            if (!sameDevice) signalerDoubleEntree(participant, `poste ${deviceId}`);
            results.push({
              code,
              status: sameDevice ? "applied" : "conflict",
              nom: participant.nom,
              used_at: participant.retrait_effectue_at || null,
              used_by: participant.scan_device_id || null,
            });
            continue;
          }

          run(
            "UPDATE participants SET statut_code = ?, retrait_effectue_at = ?, scan_device_id = ? WHERE id = ?",
            ["utilise", scannedAt, deviceId, participant.id],
          );

          if (scan.items && typeof scan.items === "object") {
            let items = {};
            try { items = JSON.parse(participant.items_received || "{}"); } catch {}
            Object.entries(scan.items).forEach(([itemId, received]) => {
              items[String(itemId)] = received !== false;
            });
            run("UPDATE participants SET items_received = ? WHERE id = ?", [JSON.stringify(items), participant.id]);
          }

          results.push({ code, status: "applied", nom: participant.nom });
        }

        if (scans.length) {
          await persistDatabase();
        }

        sendJson(response, 200, {
          synced: results.filter((r) => r.status === "applied").length,
          conflicts: results.filter((r) => r.status === "conflict").length,
          results,
        });
        return;
      }

      if (url.pathname === "/api/admin/verify-code" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const code = String(body.code || "").trim().toUpperCase();
        const participant = getParticipantByCode(code);

        if (!participant) {
          sendJson(response, 404, { status: "not_found", error: "Code incorrect." });
          return;
        }

        if (participant.statut_code === "utilise") {
          signalerDoubleEntree(participant, "vérification manuelle");
          sendJson(response, 200, { status: "already_used", participant });
          return;
        }

        // Consultation seule. L'app de scan doit pouvoir afficher la photo du
        // participant AVANT que le controleur ne decide : consommer des la
        // lecture rendrait tout refus impossible a annuler.
        if (body.peek === true) {
          sendJson(response, 200, { status: "valid", peek: true, participant });
          return;
        }

        run("UPDATE participants SET statut_code = ?, retrait_effectue_at = ? WHERE id = ?", [
          "utilise",
          Date.now(),
          participant.id,
        ]);
        await persistDatabase();
        sendJson(response, 200, { status: "valid", participant: getParticipantById(participant.id) });
        return;
      }
    }

    sendJson(response, 404, { error: "Route API introuvable." });
  } catch (error) {
    console.error("Erreur API:", error);
    // `error.message` peut etre absent (throw d'une valeur non-Error) : le lire
    // directement faisait planter le gestionnaire d'erreurs lui-meme.
    const raw = String((error && error.message) || "");
    const message =
      !url.pathname.startsWith("/api/admin/") && raw.includes("FedaPay")
        ? "Paiement indisponible pour le moment."
        : raw || "Erreur serveur.";
    sendJson(response, raw.includes("Payload") ? 413 : 500, {
      error: message,
    });
  }
}

// En-tetes envoyes sur TOUTES les reponses. Ils ne coutent rien et ferment
// des classes entieres d'attaques : chargement du site dans une iframe pour
// pieger un clic, reinterpretation d'un fichier televerse comme du HTML,
// fuite de l'URL de l'admin vers un site tiers.
function applySecurityHeaders(response, { isHtml }) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "geolocation=(), microphone=(), payment=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  if (!isHtml) return;

  // La politique reste permissive sur 'unsafe-inline' : les pages portent
  // encore leurs scripts et styles en ligne. Elle bloque deja l'essentiel,
  // c'est-a-dire le chargement de code depuis un domaine tiers.
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );
}

const server = http.createServer(async (request, response) => {
  const debut = Date.now();
  response.on("finish", () => {
    try {
      sentinelle.observerRequete({
        ip: getClientIp(request),
        methode: request.method,
        chemin: String(request.url || ""),
        statut: response.statusCode,
        duree: Date.now() - debut,
      });
    } catch { /* la surveillance ne doit jamais casser une reponse */ }
  });

  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch {
    // Une ligne de requete malformee ne doit pas faire tomber le serveur.
    sendJson(response, 400, { error: "Requete invalide." });
    return;
  }

  applySecurityHeaders(response, {
    isHtml: !url.pathname.startsWith("/api/") && /(^\/$|\.html$)/.test(url.pathname),
  });

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Methode non autorisee." });
    return;
  }

  await serveStaticFile(request, response, url.pathname);
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT && port === 3000) {
      console.warn("Le port 3000 est occupe, bascule sur 3001.");
      listen(3001);
      return;
    }

    console.error("Impossible de demarrer le serveur:", error);
    process.exit(1);
  });

  server.listen(port, () => {
    const settings = getSettings();
    console.log(`${settings.event_name || DEFAULT_SETTINGS.event_name} disponible sur http://localhost:${port}`);

    // Les erreurs de configuration sont annoncees au demarrage : sinon elles ne
    // se manifestent que le jour de l'evenement, au premier paiement reel.
    if (isDemoMode(settings)) {
      console.log("");
      console.log("  ##############################################################");
      console.log("  #  MODE DEMONSTRATION ACTIF                                  #");
      console.log("  #  Les inscriptions sont validees SANS PAIEMENT.             #");
      console.log("  #  A couper dans l'admin avant d'ouvrir les inscriptions.    #");
      console.log("  ##############################################################");
      console.log("");
    }

    const health = getConfigHealth(settings);
    const problems = health.checks.filter((check) => check.level !== "ok");

    if (problems.length) {
      console.log("");
      console.log("--- Preparation de l'evenement ---");
      problems.forEach((check) => {
        console.log(`${check.level === "error" ? "[BLOQUANT]" : "[a verifier]"} ${check.label}`);
        if (check.detail) console.log(`             ${check.detail}`);
      });
      console.log(`Detail complet dans l'admin, onglet Reglages.`);
      console.log("");
    }
  });
}

// Une erreur imprevue dans un traitement ne doit pas eteindre le site pour
// tout le monde : chaque ecriture en base est deja sur le disque, l'etat reste
// coherent. On journalise et on continue. Une rafale d'erreurs signale en
// revanche un etat casse : on s'arrete pour que l'hebergeur relance proprement.
let erreursRecentes = [];

function signalerErreurImprevue(erreur) {
  const message = String((erreur && (erreur.stack || erreur.message)) || erreur).split("\n").slice(0, 3).join(" ").slice(0, 400);
  sentinelle.signaler({ gravite: "alerte", type: "erreurs_serveur", titre: "Erreur imprévue dans le serveur", cle: "exception",
    details: [["Erreur", message]] });
}
process.on("unhandledRejection", (raison) => {
  console.error("Promesse rejetee sans traitement:", raison);
  signalerErreurImprevue(raison);
});
process.on("uncaughtException", (error) => {
  console.error("Erreur non rattrapee:", error);
  signalerErreurImprevue(error);
  const maintenant = Date.now();
  erreursRecentes = erreursRecentes.filter((t) => maintenant - t < 60 * 1000);
  erreursRecentes.push(maintenant);
  if (erreursRecentes.length > 10) {
    console.error("Plus de 10 erreurs en une minute : arret du serveur.");
    process.exit(1);
  }
});

initDatabase()
  .then(() => {
    migrateStraySettingKeys();
    purgeExpiredSessions();
    appliquerBasculeBadge();
    setInterval(appliquerBasculeBadge, 15 * 60 * 1000).unref();
    surveillancePeriodique();
    setInterval(surveillancePeriodique, 5 * 60 * 1000).unref();
    // Logo reduit du badge prepare des maintenant : le premier visiteur
    // n'attend pas le decodage du logo d'origine (plus d'un Mo).
    getTicketLogoPath(getSettings());
    backupDatabase();
    setInterval(backupDatabase, 60 * 60 * 1000).unref();
    setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();
    setInterval(purgeRateBuckets, 10 * 60 * 1000).unref();
    // Codes et sessions de billet expires : ils ne servent qu'a faire
    // grossir la base, et un code perime ne doit pas trainer.
    purgeTicketAccess();
    setInterval(purgeTicketAccess, 15 * 60 * 1000).unref();
    // Demarre tout de suite : sinon le tout premier badge genere paierait le
    // cout de lancement du thread (chargement des polices, etc.) en plus de
    // son propre dessin.
    demarrerPoolPdf();
    listen(PORT);
  })
  .catch((error) => {
    console.error("Impossible de demarrer la base SQL:", error);
    process.exit(1);
  });
