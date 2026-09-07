/* Tests du systeme d'e-mails.
 *
 * Aucun reseau : le transport nodemailer est remplace par un faux qui retient
 * le message. On verifie pour chaque type le DESTINATAIRE, le SUJET et la
 * presence du contenu et du lien attendus dans le corps.
 *
 * Lancer : npm test
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");

const transport = require("../lib/mail/transport");
const {
  PaiementConfirmeEmail,
  CodeVerificationEmail,
  PaiementEchoueEmail,
  AlerteInterneEmail,
  EmailDeTest,
} = require("../lib/mail/senders");
const { renderEmail } = require("../lib/mail/template");

/* ---- Faux transport ------------------------------------------------------
   On remplace createTransport pour que sendMail retienne le message au lieu
   de le poster. Sans cela, les tests dependraient d'un serveur joignable. */
const envoyes = [];
const vraiCreateTransport = nodemailer.createTransport;

function activerFauxSmtp() {
  envoyes.length = 0;
  transport.resetTransport();
  nodemailer.createTransport = () => ({
    sendMail: async (message) => {
      envoyes.push(message);
      return { messageId: "<test@local>" };
    },
    verify: async () => true,
    close() {},
  });
}

function restaurer() {
  nodemailer.createTransport = vraiCreateTransport;
  transport.resetTransport();
}

// Reglages minimaux : de quoi rendre la configuration SMTP complete.
const REGLAGES = {
  event_name: "FEJA",
  logo_url: "/uploads/branding/logo.png?v=1",
  pickup_location: "Terrain Omnisports CEG2 AZOVÈ",
  alert_email: "organisation@feja.test",
  smtp_host: "mail62.hebergeur-panel.test",
  smtp_port: "587",
  smtp_user: "no-reply@feja.test",
  smtp_password: "secret-de-test",
};

const CTX = { settings: REGLAGES, baseUrl: "https://feja.test" };

const PARTICIPANT = {
  id: "WLA-20260906-ABCDEF123456",
  nom: "Kossi Adjavon",
  email: "kossi@exemple.test",
  montant: "10 000 FCFA",
  code_unique: "9872A6",
  lieu_retrait: "Terrain Omnisports CEG2 AZOVÈ",
};

test.beforeEach(activerFauxSmtp);
test.after(restaurer);

/* ------------------------------------------------------------------ gabarit */
test("le gabarit produit du HTML en tableaux avec styles en ligne", () => {
  const html = renderEmail({
    eventName: "FEJA",
    titre: "Titre",
    paragraphes: ["Un paragraphe."],
    boutonTexte: "Agir",
    boutonLien: "https://feja.test/action",
  });

  assert.match(html, /<table/, "le corps doit etre construit en tableaux");
  assert.match(html, /style="[^"]*font-family/, "les styles doivent etre poses sur les balises");
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i, "aucune feuille de style externe");
  assert.match(html, /https:\/\/feja\.test\/action/, "le lien du bouton doit figurer");
});

test("le gabarit echappe le HTML et refuse les liens dangereux", () => {
  const html = renderEmail({
    eventName: "FEJA",
    titre: '<img src=x onerror="alert(1)">',
    boutonTexte: "Cliquer",
    boutonLien: "javascript:alert(1)",
  });

  assert.doesNotMatch(html, /<img src=x/, "le balisage injecte doit etre echappe");
  assert.doesNotMatch(html, /javascript:/i, "un lien javascript: doit etre rejete");
});

/* -------------------------------------------------- 1. paiement confirme */
test("paiement confirmé : destinataire, sujet, code et pièce jointe", async () => {
  const piece = { filename: "billet.pdf", content: Buffer.from("%PDF-1.3") };
  const mail = new PaiementConfirmeEmail(
    Object.assign({ participant: PARTICIPANT, attachments: [piece] }, CTX),
  );

  const res = await mail.send();
  assert.equal(res.voie, "smtp");
  assert.equal(envoyes.length, 1);

  const m = envoyes[0];
  assert.equal(m.to, "kossi@exemple.test");
  assert.match(m.subject, /9872A6/, "le sujet doit porter le code");
  assert.match(m.subject, /FEJA/);
  assert.match(m.html, /9872A6/, "le code doit figurer dans le corps");
  assert.match(m.html, /Kossi Adjavon/);
  assert.match(m.html, /verification\.html\?code=9872A6/, "le bouton doit mener a la verification");
  assert.match(m.text, /9872A6/, "la version texte doit aussi porter le code");
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, "billet.pdf");
});

/* ------------------------------------------------ 2. code de verification */
test("code de vérification : destinataire, sujet et code à 6 chiffres", async () => {
  const mail = new CodeVerificationEmail(
    Object.assign({ email: "kossi@exemple.test", code: "418302" }, CTX),
  );

  await mail.send();
  const m = envoyes[0];

  assert.equal(m.to, "kossi@exemple.test");
  assert.match(m.subject, /^418302 —/, "le code doit ouvrir le sujet, visible en notification");
  assert.match(m.html, /418302/);
  assert.match(m.html, /10 minutes/, "la duree de validite doit etre annoncee");
  assert.match(m.text, /418302/);
  // Le billet lui-meme ne doit surtout pas voyager avec le code.
  assert.equal((m.attachments || []).length, 0);
});

/* -------------------------------------------------------- 3. paiement echoue */
test("paiement échoué : destinataire, sujet, référence et motif", async () => {
  const mail = new PaiementEchoueEmail(
    Object.assign({ participant: PARTICIPANT, motif: "Solde insuffisant" }, CTX),
  );

  await mail.send();
  const m = envoyes[0];

  assert.equal(m.to, "kossi@exemple.test");
  assert.match(m.subject, /n'a pas abouti/);
  assert.match(m.html, /Solde insuffisant/);
  assert.match(m.html, /WLA-20260906-ABCDEF123456/, "la reference doit figurer");
  assert.match(m.html, /Aucun montant/, "le message doit rassurer sur le débit");
  assert.doesNotMatch(m.html, /9872A6/, "aucun code d'acces ne doit fuiter dans un echec");
});

/* --------------------------------------------------------- 4. alerte interne */
test("alerte interne : part à l'adresse des réglages, pas au participant", async () => {
  const mail = new AlerteInterneEmail(
    Object.assign(
      {
        evenement: "Nouvelle inscription payée",
        lignes: [["Participant", "Kossi Adjavon"], ["Montant", "10 000 FCFA"]],
      },
      CTX,
    ),
  );

  await mail.send();
  const m = envoyes[0];

  assert.equal(m.to, "organisation@feja.test", "l'adresse vient des reglages");
  assert.notEqual(m.to, PARTICIPANT.email);
  assert.match(m.subject, /^\[FEJA\] Nouvelle inscription payée$/);
  assert.match(m.html, /Kossi Adjavon/);
  assert.match(m.html, /admin\.html/, "le bouton doit mener a l'administration");
});

test("alerte interne : l'adresse d'environnement l'emporte sur les réglages", async () => {
  process.env.MAIL_ALERT_TO = "urgence@feja.test";
  try {
    const mail = new AlerteInterneEmail(Object.assign({ evenement: "Test" }, CTX));
    await mail.send();
    assert.equal(envoyes[0].to, "urgence@feja.test");
  } finally {
    delete process.env.MAIL_ALERT_TO;
  }
});

/* -------------------------------------------------------------- 5. essai */
test("e-mail de test : destinataire libre et sujet explicite", async () => {
  const mail = new EmailDeTest(Object.assign({ email: "moi@exemple.test" }, CTX));
  await mail.send();
  const m = envoyes[0];

  assert.equal(m.to, "moi@exemple.test");
  assert.match(m.subject, /Test d'envoi/);
  assert.match(m.html, /fonctionne/);
});

/* ------------------------------------------------------------- transport */
test("l'expéditeur retombe sur l'utilisateur SMTP, jamais sur une adresse inventée", () => {
  const from = transport.getFromAddress(REGLAGES, "FEJA");
  assert.equal(from, "FEJA <no-reply@feja.test>");
});

test("une configuration SMTP incomplète n'est pas utilisée", () => {
  assert.equal(transport.getSmtpConfig({ smtp_host: "mail.feja.test" }), null);
  assert.equal(transport.getSmtpConfig({}), null);
});

test("le port 465 implique un TLS implicite, le 587 un STARTTLS", () => {
  const a = transport.getSmtpConfig(Object.assign({}, REGLAGES, { smtp_port: "465" }));
  const b = transport.getSmtpConfig(Object.assign({}, REGLAGES, { smtp_port: "587" }));
  assert.equal(a.secure, true);
  assert.equal(b.secure, false);
});

test("sans aucun moyen d'envoi, l'erreur est explicite", async () => {
  restaurer();
  const mail = new EmailDeTest({ settings: { event_name: "FEJA" }, email: "a@b.test" });
  await assert.rejects(() => mail.send(), /Aucun moyen d'envoi configuré|expédition non configurée/);
  activerFauxSmtp();
});
