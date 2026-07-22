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
  logo_url: "",
  theme_preset: "indigo",
  theme_custom_json: "{}",
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
  paymentSecretKey:     "payment_secret_key",
  paymentEnvironment:   "payment_environment",
  fedapayWebhookSecret: "fedapay_webhook_secret",
  publicBaseUrl:        "public_base_url",
  chiefs:               "chiefs_json",
  sponsors:             "sponsors_json",
  eventItems:           "event_items_json",
};

let db;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function resolveFilePath(urlPathname) {
  const cleanPath = decodeURIComponent(urlPathname.split("?")[0]);
  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, relativePath);
  const normalized = path.normalize(filePath);

  if (!normalized.startsWith(ROOT)) {
    return null;
  }

  return normalized;
}

async function serveStaticFile(request, response, pathname) {
  const filePath = resolveFilePath(pathname);

  if (!filePath) {
    sendJson(response, 403, { error: "Acces interdit." });
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const targetPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const extname = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[extname] || "application/octet-stream";
    const fileContent = await fs.promises.readFile(targetPath);

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
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
      expires_at INTEGER NOT NULL
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

  const settings = getSettings();
  saveSettings(settings);
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

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  run("INSERT INTO sessions (token, expires_at) VALUES (?, ?)", [token, expiresAt]);
  persistDatabase();
  return token;
}

function requireAdmin(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return false;

  const row = statementGet("SELECT expires_at FROM sessions WHERE token = ?", [token]);

  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) {
      run("DELETE FROM sessions WHERE token = ?", [token]);
      persistDatabase();
    }
    return false;
  }

  // Expiration glissante. On n'ecrit sur le disque que si l'echeance a
  // sensiblement bouge : sinon chaque requete de l'admin (rafraichissement
  // toutes les quelques secondes) reecrirait toute la base.
  const nextExpiry = Date.now() + SESSION_TTL_MS;
  if (nextExpiry - Number(row.expires_at) > 60 * 60 * 1000) {
    run("UPDATE sessions SET expires_at = ? WHERE token = ?", [nextExpiry, token]);
    persistDatabase();
  }

  return true;
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

// Le theme effectif = preset choisi, surcharge par les couleurs personnalisees.
function resolveTheme(settings = getSettings()) {
  const presetKey = THEME_PRESETS[settings.theme_preset] ? settings.theme_preset : DEFAULT_THEME_PRESET;
  const preset = THEME_PRESETS[presetKey];

  let custom = {};
  try {
    const parsed = JSON.parse(settings.theme_custom_json || "{}");
    if (parsed && typeof parsed === "object") custom = parsed;
  } catch {}

  const colors = { ...preset.colors };
  Object.keys(preset.colors).forEach((key) => {
    if (hexToRgb(custom[key])) {
      colors[key] = String(custom[key]).trim();
    }
  });

  return { preset: presetKey, label: preset.label, colors };
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

  const adminPassword = settings.admin_password || "";
  if (!adminPassword || adminPassword === DEFAULT_SETTINGS.admin_password || adminPassword.length < 8) {
    add("warn", "password", "Mot de passe administrateur faible",
      "Il protège la liste des participants et l'app de scan. Choisis-en un d'au moins 8 caractères.");
  } else {
    add("ok", "password", "Mot de passe administrateur personnalisé", null);
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

function publicSettings(settings = getSettings()) {
  let chiefs = [], sponsors = [], eventItems = [];
  try { chiefs = JSON.parse(settings.chiefs_json || "[]"); } catch {}
  try { sponsors = JSON.parse(settings.sponsors_json || "[]"); } catch {}
  try { eventItems = JSON.parse(settings.event_items_json || "[]"); } catch {}
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
    theme:       resolveTheme(settings),
    chiefs,
    sponsors,
    eventItems,
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

function generateParticipantId() {
  const dateKey = getDateKeyBenin().replace(/-/g, "");

  for (let index = 0; index < 12; index += 1) {
    const random = Math.floor(Math.random() * 100000).toString().padStart(5, "0");
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
  const filename = `${filenamePrefix}.${extension}`;
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
  const filename = `${participantId}.png`;
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

function buildValidationEmailHtml(participant, publicBaseUrl = "") {
  const eventName = participant.evenement || DEFAULT_SETTINGS.event_name;
  const qrImage = participant.qr_code_url && publicBaseUrl ? `<p><img src="${publicBaseUrl}${participant.qr_code_url}" alt="QR code ${eventName}" style="width:180px;height:180px"></p>` : "";
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h1>Votre paiement ${eventName} est valide</h1>
      <p>Bonjour ${participant.nom || ""},</p>
      <p>Votre paiement est confirme. Voici votre code ${eventName} :</p>
      <p style="font-size:34px;font-weight:700;letter-spacing:6px">${participant.code_unique}</p>
      ${qrImage}
      <p>Lieu de retrait : <strong>${participant.lieu_retrait || "APPLAHOUE AZOVE"}</strong></p>
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
        `Lieu de retrait : ${participant.lieu_retrait || "APPLAHOUE AZOVE"}\n`,
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
      const body = await parseJsonBody(request);
      const settings = getSettings();
      const nom = String(body.nom || "").trim();
      const telephone = String(body.telephone || "").trim();
      const email = String(body.email || "").trim();

      if (!nom || !telephone || !email || !body.participant_photo_base64) {
        sendJson(response, 400, { error: "Nom, telephone, email et photo du participant sont obligatoires." });
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
      const body = await parseJsonBody(request);
      const settings = getSettings();
      if (String(body.password || "") !== String(settings.admin_password || DEFAULT_SETTINGS.admin_password)) {
        sendJson(response, 401, { error: "Mot de passe incorrect." });
        return;
      }

      sendJson(response, 200, { token: createSession() });
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!requireAdmin(request)) {
        sendJson(response, 401, { error: "Session admin invalide." });
        return;
      }

      if (url.pathname === "/api/admin/participants" && request.method === "GET") {
        const participants = getParticipants();
        const normalized = participants.map(normalizeParticipant);
        sendJson(response, 200, { participants: normalized, stats: getStats(participants) });
        return;
      }

      if (url.pathname === "/api/admin/settings" && request.method === "GET") {
        sendJson(response, 200, getSettings());
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

        saveSettings(toSave);
        sendJson(response, 200, getSettings());
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

        saveSettings({ theme_preset: preset, theme_custom_json: JSON.stringify(custom) });
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
    const message =
      !url.pathname.startsWith("/api/admin/") && String(error.message || "").includes("FedaPay")
        ? "Paiement indisponible pour le moment."
        : error.message || "Erreur serveur.";
    sendJson(response, error.message.includes("Payload") ? 413 : 500, {
      error: message,
    });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

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
    listen(PORT);
  })
  .catch((error) => {
    console.error("Impossible de demarrer la base SQL:", error);
    process.exit(1);
  });
