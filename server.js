require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const initSqlJs = require("sql.js");
const { Resend } = require("resend");
const QRCode = require("qrcode");

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
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
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
  fedapay_webhook_secret: "",
  public_base_url: "",
  wachap_instance_id: "",
  wachap_access_token: "",
  resend_api_key: "",
  resend_from: "",
  event_date_label: "",
  event_date: "",
  wa_link: "",
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
  accountName:          ["moov_nom", "mtn_nom"], // un seul champ dans l'admin, deux operateurs
  moovNumber:           "moov_numero",
  mtnNumber:            "mtn_numero",
  waLink:               "wa_link",
  email:                "vendeur_email",
  wachapKey:            "wachap_access_token",
  resendKey:            "resend_api_key",
  resendFrom:           "resend_from",
  adminPassword:        "admin_password",
  scanPassword:         "scan_password",
  paymentSecretKey:     "payment_secret_key",
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
};

let db;

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
      "Cache-Control": "no-store",
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

// Ecriture atomique : on ecrit dans un fichier temporaire puis on le renomme.
// Un writeFileSync direct sur la base laisse une fenetre pendant laquelle une
// coupure de courant ou un arret brutal donne un fichier tronque, donc la perte
// de TOUS les participants. Le rename, lui, est atomique sur un meme disque.
function persistDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = Buffer.from(db.export());
  const tempPath = `${DB_PATH}.tmp`;

  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, DB_PATH);
}

// Copie de securite horodatee, gardee en rotation. Sert de filet si la base
// est corrompue ou effacee par erreur la veille de l'evenement.
function backupDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "");
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `weloveadja-${stamp}.sqlite`));

    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith(".sqlite"))
      .sort();

    backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS)).forEach((name) => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch {}
    });
  } catch (error) {
    console.warn("Sauvegarde de la base impossible:", error.message);
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
  ];

  requiredColumns.forEach(([name, definition]) => {
    if (!existingColumns.has(name)) {
      run(`ALTER TABLE participants ADD COLUMN ${name} ${definition}`);
    }
  });
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

async function initDatabase() {
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

function parseJsonBody(request) {
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

function getClientIp(request) {
  // Derriere un tunnel ou un reverse proxy, l'adresse de la socket est celle
  // du proxy : on prend le premier maillon de X-Forwarded-For quand il existe.
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "inconnu";
}

// Renvoie le nombre de secondes a attendre, ou 0 si la requete est autorisee.
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
  --stroke:${rgba(c.cream, 0.12)};--stroke-gd:${rgba(c.gold, 0.36)};
  --red:${c.red};
  --surface:${rgba(c.cream, 0.08)};--surface-strong:${rgba(c.cream, 0.12)};--surface-border:${rgba(c.gold, 0.12)};
  --text:${c.cream};--muted:${rgba(c.cream, 0.85)};--sand:${c.goldLt};--bg-soft:${c.bg2};
}
body{background:
  radial-gradient(circle at top left, ${rgba(c.green, 0.22)}, transparent 30%),
  radial-gradient(circle at top right, ${rgba(c.gold, 0.18)}, transparent 24%),
  linear-gradient(180deg, ${c.bg} 0%, ${c.bg2} 45%, ${c.bg} 100%);
  background-attachment:fixed;
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
    add("warn", "pickup", "Lieu de retrait non renseigné", "Il apparaît sur le billet et dans l'email.");
  } else {
    add("ok", "pickup", `Lieu : ${settings.pickup_location}`, null);
  }

  // Sans date, le compte à rebours de la page d'accueil reste bloqué sur
  // 00:00:00:00, ce qui donne l'impression d'un site en panne.
  const eventDate = settings.event_date || "";
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
    eventDate:   settings.event_date || "",
    moovNumber:  settings.moov_numero || "",
    mtnNumber:   settings.mtn_numero || "",
    waLink:      settings.wa_link || "",
    email:       settings.vendeur_email || "",
    logoUrl:     settings.logo_url || "",
    demoMode:    isDemoMode(settings),
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

function generateUniqueCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    const bytes = crypto.randomBytes(6);
    bytes.forEach((value) => {
      code += alphabet[value % alphabet.length];
    });

    if (!statementGet("SELECT id FROM participants WHERE code_unique = ?", [code])) {
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

// Le logo accepte aussi le SVG, contrairement aux autres uploads. Le nom de
// fichier est stable, donc on suffixe une version pour casser les caches.
function saveBrandingLogo(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/(?:jpeg|jpg|png|webp|svg\+xml));base64,(.+)$/);
  if (!match) {
    throw new Error("Logo invalide. Formats acceptes : PNG, JPG, WEBP, SVG.");
  }

  const mime = match[1];
  const extension = mime.includes("svg") ? "svg" : mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const bytes = Buffer.from(match[2], "base64");

  if (!bytes.length || bytes.length > MAX_BODY_BYTES) {
    throw new Error("Logo trop volumineux (5 Mo maximum).");
  }

  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  // On purge les anciennes extensions pour ne pas laisser de logo orphelin.
  ["png", "jpg", "webp", "svg"].forEach((ext) => {
    const stale = path.join(BRANDING_DIR, `logo.${ext}`);
    if (ext !== extension && fs.existsSync(stale)) {
      try { fs.unlinkSync(stale); } catch {}
    }
  });

  fs.writeFileSync(path.join(BRANDING_DIR, `logo.${extension}`), bytes);
  return `/uploads/branding/logo.${extension}?v=${Date.now()}`;
}

function removeBrandingLogo() {
  ["png", "jpg", "webp", "svg"].forEach((ext) => {
    const target = path.join(BRANDING_DIR, `logo.${ext}`);
    if (fs.existsSync(target)) {
      try { fs.unlinkSync(target); } catch {}
    }
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
    width: 360,
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
        lieu_retrait, date, date_key, timestamp, validation_at, retrait_effectue_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
  const response = await fetch(`${getPaymentApiBaseUrl(credentials.environment)}${routePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.secretKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`FedaPay HTTP ${response.status}: ${text}`);
  }

  return data;
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

async function createPaymentTransaction(settings, participant, customer) {
  const amount = getParticipationAmount(settings);
  const callbackBase = process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const body = {
    description: `Participation ${eventName} ${settings.event_year || DEFAULT_SETTINGS.event_year}`,
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

async function verifyPaymentTransaction(transactionId, amount, settings) {
  if (!transactionId) {
    throw new Error("Transaction de paiement manquante.");
  }

  const payload = await fedapayRequest(settings, "GET", `/transactions/${encodeURIComponent(transactionId)}`);
  const transaction = payload.transaction || payload;
  const status = String(transaction.status || "").toLowerCase();
  const transactionAmount = Number(transaction.amount || 0);

  if (status !== "approved") {
    throw new Error("Paiement non confirme.");
  }

  if (transactionAmount !== Number(amount)) {
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

function getPublicBaseUrl(settings) {
  return process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
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
  return {
    id: `demo-${participant.id}`,
    status: "approved",
    amount: getParticipationAmount(settings),
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

function buildPendingParticipant(body, settings) {
  const amount = getParticipationAmount(settings);
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const id = generateParticipantId();
  const nom = String(body.nom || "").trim();
  const telephone = String(body.telephone || "").trim();
  const email = String(body.email || "").trim();
  const participantPhotoUrl = saveParticipantPhoto(body.participant_photo_base64, id);

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

function buildValidationEmailHtml(participant, publicBaseUrl = "") {
  const eventName = escapeHtml(participant.evenement || DEFAULT_SETTINGS.event_name);
  const qrImage =
    participant.qr_code_url && publicBaseUrl
      ? `<p><img src="${escapeHtml(publicBaseUrl + participant.qr_code_url)}" alt="QR code ${eventName}" style="width:180px;height:180px"></p>`
      : "";
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h1>Votre paiement ${eventName} est valide</h1>
      <p>Bonjour ${escapeHtml(participant.nom || "")},</p>
      <p>Votre paiement est confirme. Voici votre code ${eventName} :</p>
      <p style="font-size:34px;font-weight:700;letter-spacing:6px">${escapeHtml(participant.code_unique)}</p>
      ${qrImage}
      <p>Lieu de retrait : <strong>${escapeHtml(participant.lieu_retrait || "Terrain Omnisports CEG2 AZOVÈ")}</strong></p>
      <p>Presentez ce code ou le QR code joint le jour de l'evenement.</p>
    </div>
  `;
}

async function sendValidationEmail(participant, settings) {
  const apiKey = process.env.RESEND_API_KEY || settings.resend_api_key;
  const eventName = settings.event_name || DEFAULT_SETTINGS.event_name;
  const from = process.env.RESEND_FROM || settings.resend_from || `${eventName} <onboarding@resend.dev>`;

  if (!apiKey || !participant.email) {
    return false;
  }

  const resend = new Resend(apiKey);
  const baseUrl = process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
  const qrPath = participant.qr_code_url ? path.join(ROOT, participant.qr_code_url.replace(/^\/+/, "")) : "";
  const attachments = [];

  if (qrPath && fs.existsSync(qrPath)) {
    attachments.push({
      filename: `code-${eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${participant.code_unique}.png`,
      content: fs.readFileSync(qrPath).toString("base64"),
    });
  }

  await resend.emails.send(
    {
      from,
      to: participant.email,
      subject: `Votre code ${eventName} : ${participant.code_unique}`,
      html: buildValidationEmailHtml(participant, baseUrl),
      text:
        `Bonjour ${participant.nom || ""},\n\n` +
        `Votre paiement ${eventName} est confirme.\n` +
        `Code : ${participant.code_unique}\n` +
        `Lieu de retrait : ${participant.lieu_retrait || "Terrain Omnisports CEG2 AZOVÈ"}\n`,
      attachments,
    },
    {
      headers: {
        "Idempotency-Key": `validation-${participant.id}`,
      },
    },
  );

  return true;
}

async function finalizePaidParticipant(participant, transaction, settings) {
  if (!participant) {
    throw new Error("Participant introuvable.");
  }

  if (participant.statut_paiement === "Valide" && participant.code_unique) {
    return { participant, emailSent: false, alreadyFinalized: true };
  }

  const amount = getParticipationAmount(settings);
  const status = String(transaction.status || "").toLowerCase();
  const transactionAmount = Number(transaction.amount || 0);

  if (status !== "approved") {
    throw new Error("Paiement non confirme.");
  }

  if (transactionAmount !== Number(amount)) {
    throw new Error("Montant du paiement incorrect.");
  }

  const existingTransaction = getParticipantByFedapayTransactionId(transaction.id);
  if (existingTransaction && existingTransaction.id !== participant.id) {
    throw new Error("Cette transaction est deja liee a une inscription.");
  }

  const codeUnique = generateUniqueCode();
  const qrCodeUrl = await saveQrCode(codeUnique, participant.id);
  const validationAt = Date.now();

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
      transaction.receipt_url || participant.preuve_paiement || null,
      transaction.receipt_url || participant.preuve_url || null,
      transaction.reference || transaction.merchant_reference || participant.fedapay_reference || null,
      transaction.status || "approved",
      qrCodeUrl,
      validationAt,
      participant.id,
    ],
  );
  persistDatabase();

  const updatedParticipant = getParticipantById(participant.id);
  const emailSent = await sendValidationEmail(updatedParticipant, settings).catch((error) => {
    console.error("Email Resend non envoye:", error.message);
    return false;
  });

  return { participant: updatedParticipant, emailSent, alreadyFinalized: false };
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

    if (url.pathname === "/api/public/verify-code" && request.method === "POST") {
      // Le code fait 6 caracteres : sans plafond, on peut le deviner par
      // essais successifs et decouvrir le nom du participant associe.
      const retryAfter = rateLimit(request, "verify", 20, 5 * 60 * 1000);
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

      const base = process.env.PUBLIC_BASE_URL || settings.public_base_url || "";
      const participantForNotif = { ...participant, preuve_url: base ? base + proofUrl : null };
      notifyOrganizer(participantForNotif, settings).catch((err) => {
        console.warn("Notification WaChap non envoyée (register):", err.message);
      });

      sendJson(response, 201, { ref: id, nom: participant.nom });
      return;
    }

    if (url.pathname === "/api/payments/create" && request.method === "POST") {
      // Chaque appel ecrit une photo sur le disque et cree un client chez
      // FedaPay. Sans plafond, une boucle remplissait le disque du serveur et
      // polluait le compte de paiement.
      const retryAfter = rateLimit(request, "payment", 8, 10 * 60 * 1000);
      if (retryAfter) {
        sendRateLimited(response, retryAfter, "Trop d'inscriptions depuis cet appareil. Réessaie dans quelques minutes.");
        return;
      }

      const body = await parseJsonBody(request);
      const settings = getSettings();
      const nom = String(body.nom || "").trim();
      const telephone = String(body.telephone || "").trim();
      const email = String(body.email || "").trim();

      if (!nom || !telephone || !email || !body.participant_photo_base64) {
        sendJson(response, 400, { error: "Nom, telephone, email et photo du participant sont obligatoires." });
        return;
      }

      // Bornes de saisie : rien ne les verifiait, on pouvait stocker un nom de
      // plusieurs megaoctets ou une adresse email qui n'en est pas une (et le
      // participant ne recevait alors jamais son code).
      const invalid = validateParticipantInput({ nom, telephone, email });
      if (invalid) {
        sendJson(response, 400, { error: invalid });
        return;
      }

      // En demonstration, on n'appelle jamais l'operateur : getPaymentCredentials
      // leverait "Cle secrete de paiement non configuree" et bloquerait tout.
      if (isDemoMode(settings)) {
        const demoParticipant = buildPendingParticipant(body, settings);
        demoParticipant.paiement = DEMO_PAYMENT_TAG;
        demoParticipant.operateur_paiement = "Démonstration";
        demoParticipant.fedapay_status = "demo_pending";
        insertParticipant(demoParticipant);

        sendJson(response, 201, {
          demo: true,
          participant: {
            id: demoParticipant.id,
            nom: demoParticipant.nom,
            telephone: demoParticipant.telephone,
            email: demoParticipant.email,
            montant: demoParticipant.montant,
            statut_paiement: demoParticipant.statut_paiement,
          },
          transaction: { id: `demo-${demoParticipant.id}`, reference: `DEMO-${demoParticipant.id}`, status: "pending" },
          // On renvoie directement la page de retour : c'est elle qui
          // interroge /api/payments/status, lequel validera le paiement.
          checkout_url: `/retour-paiement.html?p=${encodeURIComponent(demoParticipant.id)}`,
        });
        return;
      }

      getPaymentCredentials(settings);
      const participant = buildPendingParticipant(body, settings);
      const customer = await createPaymentCustomer(settings, participant);
      const transaction = await createPaymentTransaction(settings, participant, customer);
      const transactionId = String(transaction.id || "");

      if (!transactionId) {
        throw new Error("Transaction de paiement non creee.");
      }

      if (getParticipantByFedapayTransactionId(transactionId)) {
        throw new Error("Cette transaction est deja liee a une inscription.");
      }

      participant.fedapay_transaction_id = transactionId;
      participant.fedapay_customer_id = customer.id ? String(customer.id) : null;
      participant.fedapay_reference = transaction.reference || transaction.merchant_reference || participant.id;
      participant.fedapay_status = transaction.status || "pending";

      insertParticipant(participant);

      // Redirection totale : on renvoie l'URL de la page FedaPay hebergee,
      // le navigateur y envoie le client et FedaPay le ramene sur
      // /retour-paiement.html une fois le paiement termine.
      const checkout = await createPaymentToken(settings, transactionId);

      sendJson(response, 201, {
        participant: {
          id: participant.id,
          nom: participant.nom,
          telephone: participant.telephone,
          email: participant.email,
          montant: participant.montant,
          statut_paiement: participant.statut_paiement,
        },
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
      const retryAfter = rateLimit(request, "status", 60, 10 * 60 * 1000);
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
          email_sent: result.emailSent,
          already_finalized: result.alreadyFinalized,
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
          email_sent: result.emailSent,
          already_finalized: result.alreadyFinalized,
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
      const retryAfter = rateLimit(request, "status", 60, 10 * 60 * 1000);
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

      const amount = getParticipationAmount(settings);
      const paymentTransaction = await verifyPaymentTransaction(fedapayTransactionId, amount, settings);
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
      const settings = getSettings();
      const { body, raw } = await parseJsonBodyWithRaw(request);

      if (!verifyFedapayWebhookSignature(request, raw, settings)) {
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

      if (isApprovedEvent) {
        const participant = getParticipantByFedapayTransactionId(transaction.id);
        if (participant) {
          const verifiedTransaction = await verifyPaymentTransaction(
            transaction.id,
            getParticipationAmount(settings),
            settings,
          );
          const result = await finalizePaidParticipant(participant, verifiedTransaction, settings);
          if (!result.alreadyFinalized) {
            notifyOrganizer(result.participant, settings).catch((error) => {
              console.warn("Notification WaChap non envoyee:", error.message);
            });
          }
        }
      }

      insertWebhookEvent({
        id: eventId,
        type: eventType,
        object_id: transaction?.id ? String(transaction.id) : "",
        payload: JSON.stringify(body),
        created_at: Date.now(),
      });

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

        saveSettings(toSave);
        sendJson(response, 200, maskSecretSettings(getSettings()));
        return;
      }

      if (url.pathname === "/api/admin/branding/logo" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const logoUrl = saveBrandingLogo(body.logo_base64);
        saveSettings({ logo_url: logoUrl });
        sendJson(response, 200, { logo_url: logoUrl });
        return;
      }

      if (url.pathname === "/api/admin/branding/logo" && request.method === "DELETE") {
        removeBrandingLogo();
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

        saveSettings({ demo_mode: enabled ? "1" : "0" });
        console.log(enabled
          ? "MODE DEMONSTRATION ACTIVE : les inscriptions ne sont plus payees."
          : `Mode demonstration desactive. ${purged} inscription(s) d'essai supprimee(s).`);

        sendJson(response, 200, { enabled, purged });
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
        persistDatabase();

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
        persistDatabase();
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
          persistDatabase();
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
          sendJson(response, 200, { status: "already_used", participant });
          return;
        }

        run("UPDATE participants SET statut_code = ?, retrait_effectue_at = ? WHERE id = ?", [
          "utilise",
          Date.now(),
          participant.id,
        ]);
        persistDatabase();
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

initDatabase()
  .then(() => {
    migrateStraySettingKeys();
    purgeExpiredSessions();
    backupDatabase();
    setInterval(backupDatabase, 60 * 60 * 1000).unref();
    setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();
    setInterval(purgeRateBuckets, 10 * 60 * 1000).unref();
    listen(PORT);
  })
  .catch((error) => {
    console.error("Impossible de demarrer la base SQL:", error);
    process.exit(1);
  });
