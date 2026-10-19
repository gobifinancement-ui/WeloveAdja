/* Parcours complet sur de vrais serveurs, comme chez l'hebergeur.
 *
 * Sans configuration : un seul serveur sur la base locale (sql.js).
 * Avec FEJA_TEST_MYSQL=mysql://utilisateur:motdepasse@hote:port : TROIS
 * serveurs sur la meme base MySQL, parce que c'est ce que fait Hostinger. On
 * y verifie ce qui ne tient que si la base protege les donnees : un paiement
 * confirme en meme temps sur trois serveurs ne delivre qu'un jeu de badges,
 * les numeros et les codes ne se repetent pas, un badge ne passe qu'une fois.
 *
 * Lancer : npm test   (ou avec FEJA_TEST_MYSQL pour le mode MySQL)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const SERVEUR = path.join(__dirname, "..", "server.js");
const URL_MYSQL = process.env.FEJA_TEST_MYSQL || "";
const NB_SERVEURS = URL_MYSQL ? 3 : 1;
const PORT_BASE = 3200 + Math.floor(Math.random() * 500);
// PNG 1x1 : la photo est obligatoire pour chaque badge.
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "feja-parcours-"));
const nomBase = `feja_parcours_${crypto.randomBytes(4).toString("hex")}`;
const serveurs = [];
let jeton = "";
let appelsLogin = 0;

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function requete(port, methode, chemin, corps, entetes = {}) {
  return new Promise((resolve, reject) => {
    const donnees = corps === undefined ? null : Buffer.from(JSON.stringify(corps));
    const req = http.request({
      host: "127.0.0.1", port, method: methode, path: chemin, timeout: 20000,
      headers: { ...(donnees ? { "Content-Type": "application/json", "Content-Length": donnees.length } : {}), ...entetes },
    }, (res) => {
      const morceaux = [];
      res.on("data", (m) => morceaux.push(m));
      res.on("end", () => {
        const texte = Buffer.concat(morceaux).toString("utf8");
        let json = null;
        try { json = JSON.parse(texte); } catch {}
        resolve({ statut: res.statusCode, json, texte });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`delai depasse sur ${chemin}`)));
    if (donnees) req.write(donnees);
    req.end();
  });
}

const admin = (port, methode, chemin, corps) => requete(port, methode, chemin, corps, { Authorization: `Bearer ${jeton}` });
const port = (i) => serveurs[i % serveurs.length].port;

function lancerServeur(i) {
  const env = { ...process.env };
  for (const cle of Object.keys(env)) {
    if (/^(SMTP_|RESEND_|BREVO_|FEDAPAY_|MAIL_|DB_|PUBLIC_BASE_URL|FEJA_)/.test(cle)) delete env[cle];
  }
  Object.assign(env, {
    PORT: String(PORT_BASE + i),
    FEJA_DATA_DIR: path.join(dossier, "data"),
    FEJA_UPLOADS_DIR: path.join(dossier, "uploads"),
  });
  if (URL_MYSQL) {
    const u = new URL(URL_MYSQL);
    Object.assign(env, { DB_HOST: u.hostname, DB_PORT: u.port || "3306", DB_USER: decodeURIComponent(u.username),
      DB_PASSWORD: decodeURIComponent(u.password), DB_NAME: nomBase });
  }
  // Lance depuis le dossier de test : aucun .env du projet n'est lu.
  const p = spawn(process.execPath, [SERVEUR], { cwd: dossier, env });
  p.journal = "";
  p.stdout.on("data", (d) => { p.journal += d; });
  p.stderr.on("data", (d) => { p.journal += d; });
  p.port = PORT_BASE + i;
  p.fini = new Promise((r) => p.on("exit", r));
  return p;
}

async function attendreServeur(p) {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    try {
      const r = await requete(p.port, "GET", "/api/public-config");
      if (r.statut === 200) return;
    } catch {}
    if (p.exitCode !== null) throw new Error(`serveur arrete au demarrage :\n${p.journal}`);
    await attendre(200);
  }
  throw new Error(`serveur muet :\n${p.journal}`);
}

async function mysqlBrut(sql) {
  const mysql = require("mysql2/promise");
  const u = new URL(URL_MYSQL);
  const c = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
  try { await c.query(sql); } finally { await c.end(); }
}

async function acheter(i, nbBadges, email) {
  const billets = Array.from({ length: nbBadges }, (_, k) => ({ nom: `Testeur ${k + 1} ${email.split("@")[0]}`, photo_base64: PHOTO }));
  const r = await requete(port(i), "POST", "/api/payments/create", {
    telephone: "+22997000000", email, pays: "BJ", billets,
  });
  assert.equal(r.statut, 201, `achat refuse : ${r.texte}`);
  return r.json;
}

const valider = (i, participantId) => requete(port(i), "POST", "/api/payments/status", { participant_id: participantId });

test.before(async () => {
  if (URL_MYSQL) await mysqlBrut(`CREATE DATABASE ${nomBase} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  for (let i = 0; i < NB_SERVEURS; i += 1) serveurs.push(lancerServeur(i));
  await Promise.all(serveurs.map(attendreServeur));

  appelsLogin += 1;
  const login = await requete(port(0), "POST", "/api/admin/login", { password: "admin" });
  assert.equal(login.statut, 200, `connexion admin : ${login.texte}`);
  jeton = login.json.token;
  const demo = await admin(port(0), "POST", "/api/admin/demo", { enabled: true });
  assert.equal(demo.statut, 200, demo.texte);
});

test.after(async () => {
  for (const p of serveurs) { p.kill(); await Promise.race([p.fini, attendre(5000)]); }
  if (URL_MYSQL) await mysqlBrut(`DROP DATABASE IF EXISTS ${nomBase}`).catch(() => {});
  fs.rmSync(dossier, { recursive: true, force: true });
});

test(`un paiement confirme en meme temps sur ${NB_SERVEURS} serveur(s) ne delivre qu'un jeu de badges`, async () => {
  const achat = await acheter(0, 3, "groupe@example.com");
  const id = achat.participant.id;

  // Le webhook et la page de retour arrivent souvent ensemble : ici, deux
  // confirmations par serveur, toutes au meme instant.
  const reponses = await Promise.all(Array.from({ length: NB_SERVEURS * 2 }, (_, k) => valider(k, id)));
  reponses.forEach((r) => assert.equal(r.statut, 200, r.texte));

  const premieres = reponses.filter((r) => r.json.already_finalized === false);
  assert.equal(premieres.length, 1, "une seule validation doit avoir lieu");

  const jeux = reponses.map((r) => r.json.billets.map((b) => b.code_unique).sort().join(","));
  assert.equal(new Set(jeux).size, 1, "toutes les reponses doivent donner les memes codes");

  const billets = reponses[0].json.billets;
  assert.equal(billets.length, 3);
  assert.equal(new Set(billets.map((b) => b.code_unique)).size, 3, "codes distincts");
  assert.equal(new Set(billets.map((b) => b.numero)).size, 3, "numeros distincts");
  billets.forEach((b) => assert.match(b.numero, /^\d{6}$/));
});

test("des achats valides en meme temps recoivent des numeros et des codes tous differents", async () => {
  const achats = [];
  for (let k = 0; k < 6; k += 1) achats.push(await acheter(k, 1, `solo${k}@example.com`));
  const reponses = await Promise.all(achats.map((a, k) => valider(k, a.participant.id)));
  reponses.forEach((r) => assert.equal(r.statut, 200, r.texte));

  const liste = await admin(port(0), "GET", "/api/admin/participants");
  assert.equal(liste.statut, 200, liste.texte);
  const valides = liste.json.participants.filter((p) => p.statut_paiement === "Valide");
  assert.equal(valides.length, 9);
  assert.equal(new Set(valides.map((p) => p.code_unique)).size, 9, "aucun code en double");
  const numeros = valides.map((p) => Number(p.numero_badge)).sort((a, b) => a - b);
  assert.deepEqual(numeros, [1, 2, 3, 4, 5, 6, 7, 8, 9], "numeros 1 a 9 sans trou ni doublon");
});

test("un badge presente en meme temps a plusieurs postes de scan ne passe qu'une fois", async () => {
  const liste = await admin(port(0), "GET", "/api/admin/participants");
  const code = liste.json.participants.find((p) => p.statut_paiement === "Valide").code_unique;

  const reponses = await Promise.all(Array.from({ length: NB_SERVEURS * 2 }, (_, k) =>
    admin(port(k), "POST", "/api/admin/verify-code", { code })));
  const statuts = reponses.map((r) => r.json && r.json.status);
  assert.equal(statuts.filter((s) => s === "valid").length, 1, `une seule entree acceptee : ${statuts}`);
  assert.equal(statuts.filter((s) => s === "already_used").length, statuts.length - 1);
});

test("un reglage enregistre sur un serveur est vu par tous", async () => {
  const r = await admin(port(0), "PUT", "/api/admin/settings", { eventName: "FEJA Parcours" });
  assert.equal(r.statut, 200, r.texte);
  for (let i = 0; i < serveurs.length; i += 1) {
    const config = await requete(port(i), "GET", "/api/public-config");
    assert.ok(config.texte.includes("FEJA Parcours"), `serveur ${i} : ${config.texte.slice(0, 200)}`);
  }
});

test("les essais de mot de passe admin sont comptes ensemble sur tous les serveurs", async () => {
  // 10 essais par quart d'heure et par adresse ; la connexion du debut en a
  // deja consomme un. Les essais sont repartis sur tous les serveurs.
  const statuts = [];
  for (let k = 0; appelsLogin < 11; k += 1) {
    appelsLogin += 1;
    const r = await requete(port(k), "POST", "/api/admin/login", { password: `faux-${k}` });
    statuts.push(r.statut);
  }
  assert.ok(statuts.slice(0, -1).every((s) => s === 401), `avant la limite : ${statuts}`);
  assert.equal(statuts[statuts.length - 1], 429, `11e essai : ${statuts}`);
});

test("les donnees survivent au redemarrage d'un serveur", async () => {
  const p = serveurs[0];
  p.kill();
  await Promise.race([p.fini, attendre(10000)]);
  serveurs[0] = lancerServeur(0);
  await attendreServeur(serveurs[0]);
  const liste = await admin(port(0), "GET", "/api/admin/participants");
  assert.equal(liste.statut, 200, liste.texte);
  assert.equal(liste.json.participants.filter((p) => p.statut_paiement === "Valide").length, 9);
});

test("une validation manuelle dans l'admin, envoyee deux fois en meme temps, ne delivre qu'un badge", async () => {
  const achat = await acheter(1, 1, "manuel@example.com");
  const id = achat.participant.id;
  const reponses = await Promise.all(Array.from({ length: NB_SERVEURS * 2 }, (_, k) =>
    admin(port(k), "POST", "/api/admin/validate-payment", { id })));
  reponses.forEach((r) => assert.equal(r.statut, 200, r.texte));
  const codes = new Set(reponses.map((r) => r.json.participant.code_unique));
  assert.equal(codes.size, 1, "un seul code delivre");
  assert.equal(Number(reponses[0].json.participant.numero_badge), 10, "numero suivant, sans trou");
});
