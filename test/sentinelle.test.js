/* Tests de la surveillance (lib/sentinelle.js). Aucun e-mail reel : l'envoi
 * est remplace par une fonction qui retient les messages.
 *
 * Lancer : npm test
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Sentinelle, CHEMINS_SONDES } = require("../lib/sentinelle");

function nouvelle() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "sentinelle-"));
  const envoyes = [];
  const muette = { warn() {}, error() {} };
  const s = new Sentinelle({ dossier, journalConsole: muette, envoyer: async (sujet, lignes, note) => { envoyes.push({ sujet, lignes, note }); return true; } });
  return { s, envoyes, dossier };
}

test("les adresses de failles connues sont reconnues, pas les pages du site", () => {
  for (const p of ["/.env", "/.git/config", "/wp-login.php", "/phpmyadmin/", "/data/weloveadja.sqlite", "/../../etc/passwd", "/%2e%2e/server.js"]) {
    assert.ok(CHEMINS_SONDES.test(p), p);
  }
  for (const p of ["/", "/index.html", "/admin.html", "/api/public-config", "/js/badge-layout.js", "/fonts/Poppins-Bold.ttf", "/uploads/participants/WLA-x.jpg"]) {
    assert.ok(!CHEMINS_SONDES.test(p), p);
  }
});

test("un robot qui sonde le site : journal tout de suite, e-mail seulement dans le resume du jour", async () => {
  const { s, envoyes, dossier } = nouvelle();
  const debut = Date.now() - 1;
  for (const ip of ["41.0.0.9", "13.52.241.173"]) {
    for (const chemin of ["/.env", "/.git/config", "/wp-admin/", "/phpmyadmin/", "/.env.bak"]) {
      s.observerRequete({ ip, methode: "GET", chemin, statut: 404, duree: 3 });
    }
  }
  s.viderGroupe();
  await new Promise((r) => setImmediate(r));
  assert.equal(envoyes.length, 0, "plus d'e-mail par robot");
  const journal = fs.readFileSync(path.join(dossier, "securite.jsonl"), "utf8").trim().split("\n");
  assert.equal(journal.length, 2, "un signalement par adresse, au journal");
  assert.equal(s.journal().length, 2, "visible dans l'admin");

  // Resume : un seul e-mail pour tout, puis rien sur une periode vide.
  assert.equal(await s.resumeRobots(debut), 2);
  assert.equal(envoyes.length, 1);
  assert.match(envoyes[0].sujet, /^Résumé du jour - 2 tentative/);
  assert.ok(envoyes[0].lignes.some(([k, v]) => k === "Adresses IP différentes" && v === "2"));
  assert.ok(envoyes[0].lignes.some(([k, v]) => k === "Les plus actives" && /13\.52\.241\.173/.test(v)));
  assert.match(envoyes[0].note, /rien à faire/);
  assert.equal(await s.resumeRobots(Date.now() + 1000), 0);
  assert.equal(envoyes.length, 1, "aucun e-mail quand il n'y a rien");
});

test("les alertes serieuses partent toujours sur le moment", async () => {
  const { s, envoyes } = nouvelle();
  s.signaler({ gravite: "alerte", type: "admin_echecs", titre: "Mots de passe admin faux", ip: "1.2.3.4" });
  s.viderGroupe();
  await new Promise((r) => setImmediate(r));
  assert.equal(envoyes.length, 1);
});

test("une alerte critique part tout de suite, et pas deux fois de suite", async () => {
  const { s, envoyes } = nouvelle();
  s.signaler({ gravite: "critique", type: "fraude_paiement", titre: "Montant faux", cle: "tx1" });
  s.signaler({ gravite: "critique", type: "fraude_paiement", titre: "Montant faux", cle: "tx1" });
  await new Promise((r) => setImmediate(r));
  assert.equal(envoyes.length, 1);
  assert.match(envoyes[0].sujet, /^CRITIQUE/);
  assert.equal(s.journal().length, 1, "la repetition n'encombre pas le journal");
});

test("plafond d'e-mails par heure, avec rappel des alertes retenues", async () => {
  const { s, envoyes } = nouvelle();
  for (let i = 0; i < 15; i++) s.signaler({ gravite: "critique", type: "base", titre: `Incident ${i}`, cle: `k${i}` });
  await new Promise((r) => setImmediate(r));
  assert.equal(envoyes.length, 12);
  assert.equal(s.retenues, 3);
});

test("des erreurs en serie dans le journal du serveur declenchent une alerte", async () => {
  const { s, envoyes } = nouvelle();
  for (let i = 0; i < 10; i++) s.observerLog("error", [new Error(`panne ${i}`)]);
  s.viderGroupe();
  await new Promise((r) => setImmediate(r));
  assert.equal(envoyes.length, 1);
  assert.match(envoyes[0].sujet, /journal du serveur/);
  assert.ok(envoyes[0].lignes.some(([, v]) => /panne 9/.test(v)));
});

test("l'alerte de test passe meme quand le plafond est atteint", async () => {
  const { s, envoyes } = nouvelle();
  for (let i = 0; i < 12; i++) s.signaler({ gravite: "critique", type: "base", titre: `Incident ${i}`, cle: `k${i}` });
  const r = await s.tester("1.2.3.4");
  assert.equal(r.ok, true);
  assert.equal(envoyes.length, 13);
});
