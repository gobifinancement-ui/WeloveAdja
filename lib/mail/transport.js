/* Acheminement des e-mails.
 *
 * Trois voies, dans cet ordre :
 *   1. SMTP (nodemailer) — boite du domaine, ou relais SMTP de Brevo
 *   2. Brevo par son API HTTPS — passe la ou l'hebergeur bloque les ports
 *      SMTP sortants, ce que font beaucoup d'hebergements mutualises
 *   3. Resend — deja cable dans le projet, garde comme dernier secours
 *
 * Les identifiants ne vivent QUE dans la configuration serveur : variables
 * d'environnement d'abord, reglages de l'admin ensuite. Jamais dans le code,
 * jamais dans un commit.
 */

"use strict";

const nodemailer = require("nodemailer");

// Cache du transporteur : ouvrir une connexion SMTP a chaque message serait
// lent et ferait grimper le compteur de connexions chez l'hebergeur, qui le
// limite souvent plus severement que le nombre de messages.
let cacheSmtp = null;
let cacheEmpreinte = "";

function lire(settings, cleEnv, cleReglage) {
  const env = process.env[cleEnv];
  if (env !== undefined && String(env).trim() !== "") return String(env).trim();
  const reglage = settings && settings[cleReglage];
  return reglage === undefined || reglage === null ? "" : String(reglage).trim();
}

/** Configuration SMTP effective, ou null si elle est incomplete. */
function getSmtpConfig(settings = {}) {
  const host = lire(settings, "SMTP_HOST", "smtp_host");
  const user = lire(settings, "SMTP_USER", "smtp_user");
  const pass = lire(settings, "SMTP_PASSWORD", "smtp_password");
  if (!host || !user || !pass) return null;

  const port = Number(lire(settings, "SMTP_PORT", "smtp_port")) || 587;

  // 465 = TLS implicite ; 587 et 25 = STARTTLS. Se tromper ici donne une
  // connexion qui reste muette jusqu'au delai d'attente, sans message clair.
  const secureBrut = lire(settings, "SMTP_SECURE", "smtp_secure");
  const secure = secureBrut ? /^(1|true|oui|yes)$/i.test(secureBrut) : port === 465;

  // Sur un hebergement mutualise, le certificat porte souvent le nom du
  // SERVEUR (mail62.hebergeur.net) et non celui du domaine : la verification
  // echoue alors malgre des identifiants corrects. Ce reglage permet de
  // passer outre EN CONNAISSANCE DE CAUSE ; il reste actif par defaut.
  const strict = !/^(0|false|non|no)$/i.test(
    lire(settings, "SMTP_TLS_STRICT", "smtp_tls_strict") || "1",
  );

  return { host, port, secure, user, pass, strict };
}

function getTransport(settings = {}) {
  const cfg = getSmtpConfig(settings);
  if (!cfg) return null;

  const empreinte = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.strict}`;
  if (cacheSmtp && cacheEmpreinte === empreinte) return cacheSmtp;

  cacheSmtp = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: cfg.strict },
    // Bornes explicites : sans elles, un hote injoignable laisse la requete
    // HTTP du participant en attente pendant plusieurs minutes.
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
  });
  cacheEmpreinte = empreinte;
  return cacheSmtp;
}

/** Vide le cache : a appeler quand les reglages SMTP changent. */
function resetTransport() {
  if (cacheSmtp && typeof cacheSmtp.close === "function") {
    try { cacheSmtp.close(); } catch { /* deja ferme */ }
  }
  cacheSmtp = null;
  cacheEmpreinte = "";
}

/** Teste la connexion sans envoyer de message. */
async function verifySmtp(settings = {}) {
  const cfg = getSmtpConfig(settings);
  if (!cfg) return { ok: false, raison: "Configuration SMTP incomplète (hôte, utilisateur ou mot de passe)." };

  try {
    await getTransport(settings).verify();
    return { ok: true, host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user };
  } catch (error) {
    return { ok: false, raison: error.message, code: error.code };
  }
}

/** Adresse d'expedition, telle qu'elle apparaitra dans la boite du lecteur. */
function getFromAddress(settings = {}, eventName = "") {
  const explicite = lire(settings, "MAIL_FROM", "mail_from");
  if (explicite) return explicite;

  // A defaut, on repart de l'utilisateur SMTP : c'est la seule adresse dont
  // on est sur qu'elle appartient au domaine authentifie. Un expediteur
  // fantaisiste fait echouer SPF et part en indesirables.
  const cfg = getSmtpConfig(settings);
  if (cfg && cfg.user.includes("@")) {
    return eventName ? `${eventName} <${cfg.user}>` : cfg.user;
  }

  const brevoFrom = lire(settings, "BREVO_FROM", "brevo_from");
  if (brevoFrom && getBrevoKey(settings)) return brevoFrom;

  const resendFrom = lire(settings, "RESEND_FROM", "resend_from");
  return resendFrom || brevoFrom || "";
}

/** Cle API Brevo, ou "" si absente ou laissee a sa valeur d'exemple. */
function getBrevoKey(settings = {}) {
  const cle = lire(settings, "BREVO_API_KEY", "brevo_api_key");
  return cle && !/X{3,}/i.test(cle) ? cle : "";
}

/** "Nom <adresse>" -> { name, email } : Brevo veut l'expediteur en objet. */
function decouperAdresse(texte) {
  const m = String(texte || "").trim().match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return m[1] ? { name: m[1].trim(), email: m[2].trim() } : { email: m[2].trim() };
  return { email: String(texte || "").trim() };
}

function enListe(valeur) {
  return (Array.isArray(valeur) ? valeur : String(valeur || "").split(","))
    .map((a) => String(a).trim())
    .filter(Boolean)
    .map(decouperAdresse);
}

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

async function envoyerParBrevo(message, from, apiKey) {
  let html = message.html || "";
  const pieces = [];
  for (const p of message.attachments || []) {
    const contenu = Buffer.isBuffer(p.content) ? p.content : Buffer.from(String(p.content || ""));
    if (p.cid) {
      // L'API Brevo n'a pas d'image integree par cid : la piece arriverait
      // en piece jointe et le logo resterait casse dans le corps. On pointe
      // vers l'image publiee sur le site quand elle existe ; sinon on
      // l'inscrit dans le HTML, ce que Gmail ignore mais que la plupart des
      // autres messageries affichent.
      const source = p.url ||
        `data:${p.contentType || "image/png"};base64,${contenu.toString("base64")}`;
      html = html.split(`cid:${p.cid}`).join(source);
      continue;
    }
    pieces.push({ name: p.filename || "piece-jointe", content: contenu.toString("base64") });
  }

  const corps = {
    sender: decouperAdresse(from),
    to: enListe(message.to),
    subject: message.subject,
    htmlContent: html || undefined,
    textContent: message.text || undefined,
    replyTo: message.replyTo ? decouperAdresse(message.replyTo) : undefined,
    attachment: pieces.length ? pieces : undefined,
  };

  // Meme borne que le SMTP : un Brevo injoignable ne doit pas laisser le
  // participant devant une page qui tourne pendant des minutes.
  const reponse = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(20000),
  });

  let donnees = null;
  try { donnees = await reponse.json(); } catch { /* corps vide ou non JSON */ }
  if (!reponse.ok) {
    const raison = (donnees && (donnees.message || donnees.code)) || `HTTP ${reponse.status}`;
    throw new Error(`Brevo : ${raison}`);
  }
  return { ok: true, voie: "brevo", id: donnees && donnees.messageId };
}

/** Voie qu'emprunterait le prochain message : "smtp", "brevo", "resend" ou "aucune". */
function voieEnvoi(settings = {}) {
  if (getSmtpConfig(settings)) return "smtp";
  if (getBrevoKey(settings)) return "brevo";
  const resend = lire(settings, "RESEND_API_KEY", "resend_api_key");
  return resend && !/X{3,}/i.test(resend) ? "resend" : "aucune";
}

/**
 * Envoie un message. Renvoie { ok, voie, id } ou leve une erreur explicite.
 * @param {object} message { to, subject, html, text, attachments, replyTo }
 */
async function sendMail(message, settings = {}, options = {}) {
  const eventName = options.eventName || "";
  const from = message.from || getFromAddress(settings, eventName);

  if (!message.to) throw new Error("Destinataire manquant.");
  if (!from) throw new Error("Adresse d'expédition non configurée.");

  const transport = getTransport(settings);
  if (transport) {
    const info = await transport.sendMail({
      from,
      to: message.to,
      replyTo: message.replyTo || undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments || undefined,
    });
    return { ok: true, voie: "smtp", id: info.messageId };
  }

  const cleBrevo = getBrevoKey(settings);
  if (cleBrevo) return envoyerParBrevo(message, from, cleBrevo);

  // --- Secours : Resend -----------------------------------------------------
  const apiKey = lire(settings, "RESEND_API_KEY", "resend_api_key");
  if (!apiKey) {
    throw new Error(
      "Aucun moyen d'envoi configuré : renseigne le SMTP du domaine (SMTP_HOST, SMTP_USER, SMTP_PASSWORD), une clé Brevo ou une clé Resend.",
    );
  }

  const { Resend } = require("resend");
  const resend = new Resend(apiKey);
  const envoi = await resend.emails.send({
    from,
    to: message.to,
    reply_to: message.replyTo || undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    // Resend attend le contenu en base64, nodemailer accepte un Buffer : on
    // convertit ici plutot que d'imposer un format aux appelants.
    attachments: (message.attachments || []).map((p) => ({
      filename: p.filename,
      content: Buffer.isBuffer(p.content) ? p.content.toString("base64") : p.content,
      // Image integree (le logo) : meme mecanisme que le cid de nodemailer.
      contentId: p.cid || undefined,
    })),
  });

  // Le SDK Resend ne leve PAS d'exception sur une erreur d'API : il resout
  // avec { data: null, error }. Sans ce controle, un envoi echoue passerait
  // pour un succes.
  if (envoi && envoi.error) {
    const e = envoi.error;
    throw new Error(`Resend : ${e.message || e.name || "erreur inconnue"}`);
  }

  return { ok: true, voie: "resend", id: envoi && envoi.data && envoi.data.id };
}

module.exports = {
  sendMail,
  getSmtpConfig,
  getTransport,
  resetTransport,
  verifySmtp,
  getFromAddress,
  getBrevoKey,
  voieEnvoi,
};
