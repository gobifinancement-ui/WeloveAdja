/* Paiement reel contre un faux FedaPay local.
 *
 * Le faux FedaPay repond comme le vrai : objets enveloppes sous
 * « v1/transaction », « v1/customer », et refus d'un second client avec le
 * meme e-mail. On rejoue l'incident du 19/10/2026 : la reponse de « Payer »
 * se perd, l'acheteur clique encore. Il ne doit JAMAIS y avoir de second
 * paiement.
 *
 * Lancer : npm test
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const SERVEUR = path.join(__dirname, "..", "server.js");
const PORT = 3600 + Math.floor(Math.random() * 300);
const PORT_FEDAPAY = PORT + 400;
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "feja-paiement-"));
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Faux FedaPay ------------------------------------------------------------
const fedapay = { clients: new Set(), transactions: new Map(), demandesMtn: [], prochainId: 500 };
const fauxFedapay = http.createServer((req, res) => {
  let corps = "";
  req.on("data", (m) => { corps += m; });
  req.on("end", () => {
    const donnees = corps ? JSON.parse(corps) : {};
    const repondre = (statut, objet) => { res.writeHead(statut, { "Content-Type": "application/json" }); res.end(JSON.stringify(objet)); };
    const url = req.url.replace(/^\/v1/, "");
    if (req.method === "POST" && url === "/customers") {
      if (donnees.email && fedapay.clients.has(donnees.email)) {
        return repondre(400, { message: "la création du client a échoué", errors: { email: ["n'est pas disponible"] } });
      }
      if (donnees.email) fedapay.clients.add(donnees.email);
      return repondre(201, { "v1/customer": { id: fedapay.prochainId++, email: donnees.email || null } });
    }
    if (req.method === "POST" && url === "/transactions") {
      const id = fedapay.prochainId++;
      fedapay.transactions.set(id, { id, amount: donnees.amount, status: "pending", reference: `REF-${id}` });
      return repondre(201, { "v1/transaction": fedapay.transactions.get(id) });
    }
    let m = /^\/transactions\/(\d+)\/token$/.exec(url);
    if (req.method === "POST" && m) return repondre(200, { token: `jeton-${m[1]}`, url: `https://process.example/${m[1]}` });
    m = /^\/transactions\/(\d+)$/.exec(url);
    if (req.method === "GET" && m) return repondre(200, { "v1/transaction": fedapay.transactions.get(Number(m[1])) });
    if (req.method === "POST" && url === "/mtn_open") { fedapay.demandesMtn.push(donnees.phone_number); return repondre(200, {}); }
    repondre(404, { message: "inconnu" });
  });
});

let serveur;
function requete(methode, chemin, corps) {
  return new Promise((resolve, reject) => {
    const donnees = corps ? Buffer.from(JSON.stringify(corps)) : null;
    const req = http.request({ host: "127.0.0.1", port: PORT, method: methode, path: chemin,
      headers: donnees ? { "Content-Type": "application/json", "Content-Length": donnees.length } : {} }, (res) => {
      let t = ""; res.on("data", (x) => { t += x; });
      res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ statut: res.statusCode, json: j, texte: t }); });
    });
    req.on("error", reject);
    if (donnees) req.write(donnees);
    req.end();
  });
}
const acheter = () => requete("POST", "/api/payments/create", {
  telephone: "22997000001", email: "acheteur@exemple.bj", pays: "BJ", operateur: "mtn",
  billets: [{ nom: "Koffi Test", photo_base64: PHOTO }],
});

test.before(async () => {
  await new Promise((r) => fauxFedapay.listen(PORT_FEDAPAY, "127.0.0.1", r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SMTP_|RESEND_|BREVO_|FEDAPAY_|MAIL_|DB_|PUBLIC_BASE_URL|FEJA_)/.test(k)) delete env[k];
  Object.assign(env, {
    PORT: String(PORT), FEJA_DATA_DIR: path.join(dossier, "data"), FEJA_UPLOADS_DIR: path.join(dossier, "uploads"),
    FEDAPAY_API_BASE: `http://127.0.0.1:${PORT_FEDAPAY}/v1`, FEDAPAY_SECRET_KEY: "sk_sandbox_cle_de_test_locale_1234", FEDAPAY_ENVIRONMENT: "sandbox",
  });
  serveur = spawn(process.execPath, [SERVEUR], { cwd: dossier, env });
  serveur.journal = "";
  serveur.stdout.on("data", (d) => { serveur.journal += d; });
  serveur.stderr.on("data", (d) => { serveur.journal += d; });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await requete("GET", "/api/public-config")).statut === 200) return; } catch {}
    await attendre(200);
  }
  throw new Error(`serveur muet :\n${serveur.journal}`);
});

test.after(async () => {
  serveur.kill();
  await attendre(500);
  fauxFedapay.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test("un clic sur Payer cree un paiement et envoie la demande MTN au numero local", async () => {
  const r = await acheter();
  assert.equal(r.statut, 201, r.texte);
  assert.equal(r.json.mode, "direct");
  assert.equal(fedapay.transactions.size, 1);
  assert.deepEqual(fedapay.demandesMtn[0], { number: "97000001", country: "bj" }, "numero sans l'indicatif 229");
});

test("un second clic pendant l'attente reprend le meme paiement, sans en creer un autre", async () => {
  const premier = [...fedapay.transactions.keys()][0];
  const r = await acheter();
  assert.equal(r.statut, 200, r.texte);
  assert.equal(r.json.reprise, true);
  assert.equal(String(r.json.transaction.id), String(premier));
  assert.equal(fedapay.transactions.size, 1, "aucune seconde transaction");
  assert.equal(fedapay.demandesMtn.length, 1, "aucune seconde demande USSD");
});

test("une fois paye, un nouveau clic delivre le badge sans repayer", async () => {
  const transaction = [...fedapay.transactions.values()][0];
  transaction.status = "approved";
  const r = await acheter();
  assert.equal(r.statut, 200, r.texte);
  assert.equal(r.json.mode, "deja_paye");
  assert.match(r.json.retour_url, /^\/retour-paiement\.html\?p=/);
  assert.equal(fedapay.transactions.size, 1);
  const statut = await requete("POST", "/api/payments/status", { participant_id: r.json.participant.id });
  assert.equal(statut.json.status, "approved");
  assert.equal(statut.json.already_finalized, true);
});

test("un acheteur qui revient avec le meme e-mail peut payer un nouvel achat", async () => {
  // Paiement precedent valide : un nouvel achat est legitime. FedaPay refuse
  // un second client avec le meme e-mail : le site doit s'en sortir.
  const r = await acheter();
  assert.equal(r.statut, 201, r.texte);
  assert.equal(r.json.mode, "direct");
  assert.equal(fedapay.transactions.size, 2);
});
