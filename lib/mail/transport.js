/* Acheminement des e-mails.
 *
 * Deux voies, dans cet ordre :
 *   1. SMTP de la boite du domaine (nodemailer) — la voie voulue
 *   2. Resend — deja cable dans le projet, garde comme secours pour que rien
 *      ne cesse de fonctionner pendant la bascule
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

  const resendFrom = lire(settings, "RESEND_FROM", "resend_from");
  return resendFrom || "";
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

  // --- Secours : Resend -----------------------------------------------------
  const apiKey = lire(settings, "RESEND_API_KEY", "resend_api_key");
  if (!apiKey) {
    throw new Error(
      "Aucun moyen d'envoi configuré : renseigne le SMTP du domaine (SMTP_HOST, SMTP_USER, SMTP_PASSWORD) ou une clé Resend.",
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
};
