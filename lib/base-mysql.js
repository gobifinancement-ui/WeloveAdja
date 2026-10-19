/* Base MySQL, pour l'hebergement.
 *
 * Pourquoi : chez Hostinger, plusieurs processus de l'appli tournent en meme
 * temps, sans reglage pour n'en garder qu'un (reponse du support, 19/10/2026).
 * La base sql.js vit dans la memoire d'UN processus : deux processus
 * s'ecrasaient mutuellement les inscriptions. MySQL est partage par tous les
 * processus et tranche lui-meme les ecritures simultanees.
 *
 * Le reste de l'appli ne voit que quatre fonctions (toutes, une, executer,
 * avecVerrou) : server.js choisit sql.js ou MySQL au demarrage, le code des
 * routes est le meme.
 *
 * Identifiants : variables d'environnement DB_HOST, DB_PORT, DB_USER,
 * DB_PASSWORD, DB_NAME. Jamais dans le code ni dans un fichier versionne.
 */

"use strict";

const crypto = require("crypto");
const mysql = require("mysql2/promise");

let pool = null;
// Connexions reservees aux verrous. Un verrou tient sa connexion pendant tout
// le traitement : pris dans la reserve des requetes, quatre validations
// simultanees l'epuisaient et attendaient ensuite, pour leurs propres
// requetes, une connexion qui ne se liberait jamais.
let poolVerrous = null;

function configurationDepuisEnv(env = process.env) {
  const nom = String(env.DB_NAME || "").trim();
  if (!nom) return null;
  return {
    host: String(env.DB_HOST || "127.0.0.1").trim(),
    port: Number(env.DB_PORT || 3306),
    user: String(env.DB_USER || "").trim(),
    password: String(env.DB_PASSWORD || ""),
    database: nom,
  };
}

async function ouvrir(configuration) {
  poolVerrous = mysql.createPool({ ...configuration, charset: "utf8mb4", connectionLimit: 4, waitForConnections: true, enableKeepAlive: true });
  pool = mysql.createPool({
    ...configuration,
    charset: "utf8mb4",
    // Peu de connexions par processus : l'hebergeur en lance plusieurs, et le
    // compte MySQL mutualise plafonne le total.
    connectionLimit: 4,
    waitForConnections: true,
    // SUM() rend un DECIMAL : en texte par defaut (« 50000 »), ce qui
    // faussait les additions des statistiques.
    decimalNumbers: true,
    // Une seule requete par appel : une injection ne peut pas en enchainer.
    multipleStatements: false,
    enableKeepAlive: true,
  });
  // Echoue tout de suite si la base est injoignable, au lieu de laisser la
  // premiere inscription le decouvrir.
  const connexion = await pool.getConnection();
  connexion.release();
}

async function fermer() {
  if (pool) await pool.end();
  if (poolVerrous) await poolVerrous.end();
  pool = null;
  poolVerrous = null;
}

async function toutes(sql, params = []) {
  const [lignes] = await pool.query(sql, params);
  return lignes.map((ligne) => ({ ...ligne }));
}

async function une(sql, params = []) {
  const lignes = await toutes(sql, params);
  return lignes[0] || null;
}

async function executer(sql, params = []) {
  const [resultat] = await pool.query(sql, params);
  return { changements: resultat.affectedRows || 0, id: resultat.insertId || null };
}

/* Verrou partage par tous les processus (GET_LOCK de MySQL).
 *
 * attente : secondes a attendre que le verrou se libere. A 0, on n'attend
 * pas : si un autre processus le tient, fn n'est pas executee et on rend
 * { pris: false } (taches de fond : un seul processus les fait).
 * Le verrou est tenu par UNE connexion : on la garde pendant fn, et MySQL le
 * relache tout seul si le processus meurt, sans verrou orphelin possible.
 */
async function avecVerrou(nom, attente, fn) {
  // 64 caracteres au plus pour un nom de verrou MySQL.
  const cle = nom.length > 60 ? `feja:${crypto.createHash("sha256").update(nom).digest("hex").slice(0, 40)}` : nom;
  const connexion = await poolVerrous.getConnection();
  try {
    const [[{ pris }]] = await connexion.query("SELECT GET_LOCK(?, ?) AS pris", [cle, attente]);
    if (pris !== 1) {
      if (attente > 0) throw new Error(`Verrou ${nom} indisponible apres ${attente} s.`);
      return { pris: false };
    }
    try {
      return { pris: true, valeur: await fn() };
    } finally {
      await connexion.query("SELECT RELEASE_LOCK(?)", [cle]).catch(() => {});
    }
  } finally {
    connexion.release();
  }
}

// Meme schema que la base sql.js (server.js, initDatabase), traduit :
// - les colonnes indexees passent en VARCHAR (MySQL n'indexe pas un TEXT
//   sans longueur) ;
// - une valeur par defaut n'est posee que sur un VARCHAR (MySQL 8 refuse
//   DEFAULT '' sur un TEXT) ;
// - utf8mb4_bin : comparaisons exactes, comme SQLite. Sinon « e » = « é » et
//   majuscules = minuscules, et deux codes differents pourraient se confondre.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(255) NOT NULL PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'admin'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(255) NOT NULL PRIMARY KEY,
    value MEDIUMTEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS participants (
    id VARCHAR(255) NOT NULL PRIMARY KEY,
    evenement VARCHAR(255) NOT NULL DEFAULT 'WeloveAdja',
    nom TEXT NOT NULL,
    telephone TEXT NOT NULL,
    whatsapp TEXT,
    email TEXT NOT NULL,
    montant TEXT,
    montant_valeur BIGINT,
    paiement TEXT,
    operateur_paiement_code TEXT,
    operateur_paiement TEXT,
    nom_paiement TEXT,
    numero_paiement TEXT,
    preuve_paiement TEXT,
    preuve_url TEXT,
    capture_b64 MEDIUMTEXT,
    participant_photo_url TEXT,
    statut_paiement VARCHAR(64) NOT NULL DEFAULT 'En attente',
    code_unique VARCHAR(64) NULL,
    statut_code VARCHAR(64),
    fedapay_transaction_id VARCHAR(255),
    fedapay_customer_id TEXT,
    fedapay_reference TEXT,
    fedapay_status TEXT,
    qr_code_url TEXT,
    lieu_retrait TEXT,
    date TEXT,
    date_key VARCHAR(32),
    timestamp BIGINT NOT NULL,
    validation_at BIGINT,
    retrait_effectue_at BIGINT,
    items_received TEXT,
    scan_device_id TEXT,
    groupe_id VARCHAR(255),
    groupe_index BIGINT,
    groupe_taille BIGINT,
    numero_badge BIGINT,
    UNIQUE KEY idx_participants_code_unique (code_unique),
    UNIQUE KEY idx_participants_numero (numero_badge),
    KEY idx_participants_timestamp (timestamp),
    KEY idx_participants_fedapay_transaction (fedapay_transaction_id),
    KEY idx_participants_groupe (groupe_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS ticket_codes (
    email VARCHAR(255) NOT NULL PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS ticket_sessions (
    token_hash VARCHAR(255) NOT NULL PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS webhook_events (
    id VARCHAR(255) NOT NULL PRIMARY KEY,
    type TEXT,
    object_id TEXT,
    payload MEDIUMTEXT,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  // Limites anti-abus partagees : un compteur en memoire par processus
  // multipliait les essais permis par le nombre de processus, et se remettait
  // a zero chaque fois que l'hebergeur en relancait un.
  `CREATE TABLE IF NOT EXISTS limites (
    cle VARCHAR(255) NOT NULL PRIMARY KEY,
    compte BIGINT NOT NULL,
    fin BIGINT NOT NULL,
    KEY idx_limites_fin (fin)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

async function creerSchema() {
  for (const sql of TABLES) await executer(sql);
}

async function colonnes(table) {
  const lignes = await toutes(
    "SELECT COLUMN_NAME AS nom FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table],
  );
  return new Set(lignes.map((l) => l.nom));
}

// Compteur de limite, atomique : une seule requete incremente ou repart a 1
// si la fenetre est passee. Rend le nombre d'appels et la fin de la fenetre.
async function compterLimite(cle, fenetreMs) {
  const maintenant = Date.now();
  await executer(
    `INSERT INTO limites (cle, compte, fin) VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE
       compte = IF(fin < ?, 1, compte + 1),
       fin = IF(fin < ?, ?, fin)`,
    [cle, maintenant + fenetreMs, maintenant, maintenant, maintenant + fenetreMs],
  );
  const ligne = await une("SELECT compte, fin FROM limites WHERE cle = ?", [cle]);
  return { compte: Number(ligne.compte), fin: Number(ligne.fin) };
}

async function purgerLimites() {
  await executer("DELETE FROM limites WHERE fin < ?", [Date.now()]);
}

// Image de la base pour les sauvegardes : toutes les tables, en JSON.
async function exporter() {
  const image = { format: "feja-mysql-1", date: new Date().toISOString(), tables: {} };
  for (const table of ["settings", "participants", "sessions", "ticket_codes", "ticket_sessions", "webhook_events"]) {
    image.tables[table] = await toutes(`SELECT * FROM ${table}`);
  }
  return image;
}

module.exports = {
  configurationDepuisEnv, ouvrir, fermer, toutes, une, executer, avecVerrou,
  creerSchema, colonnes, compterLimite, purgerLimites, exporter,
};
