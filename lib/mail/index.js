/* Point d'entree unique du systeme d'e-mails.
 *
 * Le reste du projet importe ce fichier et rien d'autre : la structure interne
 * (gabarit, transport, classes) peut donc changer sans toucher server.js.
 */

"use strict";

const template = require("./template");
const transport = require("./transport");
const senders = require("./senders");

module.exports = {
  // Gabarit
  renderEmail: template.renderEmail,
  renderText: template.renderText,

  // Acheminement
  sendMail: transport.sendMail,
  verifySmtp: transport.verifySmtp,
  getSmtpConfig: transport.getSmtpConfig,
  getFromAddress: transport.getFromAddress,
  resetTransport: transport.resetTransport,

  // Un envoi par evenement
  PaiementConfirmeEmail: senders.PaiementConfirmeEmail,
  CodeVerificationEmail: senders.CodeVerificationEmail,
  PaiementEchoueEmail: senders.PaiementEchoueEmail,
  AlerteInterneEmail: senders.AlerteInterneEmail,
  EmailDeTest: senders.EmailDeTest,
};
