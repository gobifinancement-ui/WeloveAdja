/* Une classe par type d'e-mail.
 *
 * Les evenements sont ceux qui existent REELLEMENT dans ce projet :
 *   1. PaiementConfirme  — le participant recoit son code, son QR et son billet
 *   2. CodeVerification  — code a 6 chiffres pour recuperer son billet
 *   3. PaiementEchoue    — le paiement n'a pas abouti
 *   4. AlerteInterne     — avis a l'organisateur, adresse configurable
 *
 * Chaque classe ne fait que REMPLIR le gabarit partage : aucune ne produit son
 * propre HTML. Une correction de mise en page se fait donc a un seul endroit.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { renderEmail, renderText } = require("./template");
const { sendMail } = require("./transport");
const BadgeLayout = require("../../js/badge-layout");

// Logo « FESTIVAL ADJA » joint a chaque message comme image integree (cid) :
// il s'affiche meme quand le site n'est pas joignable, et sans que la
// messagerie demande d'« afficher les images » comme pour une image distante.
const LOGO_CID = "logo-festival-adja";
const LOGO_FICHIER = path.join(__dirname, "..", "..", "img", "email", "logo-festival-adja.png");
let logoEnCache;
function logoEmail() {
  if (logoEnCache === undefined) {
    try { logoEnCache = fs.readFileSync(LOGO_FICHIER); } catch { logoEnCache = null; }
  }
  return logoEnCache;
}

class EmailBase {
  /**
   * @param {object} ctx
   * @param {object} ctx.settings  reglages de l'application
   * @param {string} [ctx.baseUrl] adresse publique du site
   */
  constructor(ctx = {}) {
    this.settings = ctx.settings || {};
    this.baseUrl = String(ctx.baseUrl || "").replace(/\/+$/, "");
    this.eventName = this.settings.event_name || "FEJA";
  }

  /** URL absolue a partir d'un chemin du site, ou "" si l'adresse manque. */
  absolu(chemin) {
    if (!chemin) return "";
    if (/^https?:\/\//i.test(chemin)) return chemin;
    return this.baseUrl ? this.baseUrl + (chemin.startsWith("/") ? "" : "/") + chemin : "";
  }

  /** Parametres du gabarit. Redefinie par chaque sous-classe. */
  contenu() {
    throw new Error("contenu() doit être redéfinie.");
  }

  /** Destinataire. Redefinie par chaque sous-classe. */
  destinataire() {
    throw new Error("destinataire() doit être redéfinie.");
  }

  sujet() {
    return this.contenu().titre;
  }

  pieces() {
    return [];
  }

  /** Message complet, pret a partir. Sert aussi aux tests. */
  build() {
    const logo = logoEmail();
    const params = Object.assign(
      {
        eventName: this.eventName,
        logoCid: logo ? LOGO_CID : "",
        logoUrl: this.absolu(String(this.settings.logo_url || "").split("?")[0]),
      },
      this.contenu(),
    );

    const attachments = this.pieces().slice();
    if (logo) {
      attachments.unshift({
        filename: "festival-adja.png",
        content: logo,
        contentType: "image/png",
        cid: LOGO_CID,
        contentDisposition: "inline",
      });
    }

    return {
      to: this.destinataire(),
      subject: this.sujet(),
      html: renderEmail(params),
      text: renderText(params),
      attachments,
    };
  }

  async send() {
    return sendMail(this.build(), this.settings, { eventName: this.eventName });
  }
}

/* -------------------------------------------------------------------------
   1. Paiement confirme
   ------------------------------------------------------------------------- */
class PaiementConfirmeEmail extends EmailBase {
  constructor(ctx) {
    super(ctx);
    this.participant = ctx.participant || {};
    // Un achat couvre un ou plusieurs billets. Un seul message les porte tous :
    // recevoir cinq e-mails pour cinq billets ressemblerait a une erreur.
    this.billets = (ctx.billets && ctx.billets.length ? ctx.billets : [this.participant]).filter(Boolean);
    this.piecesJointes = ctx.attachments || [];
  }

  destinataire() {
    return this.participant.email;
  }

  // Le sujet reprend le titre, comme dans le modele retenu par l'organisation.
  sujet() {
    return this.contenu().titre;
  }

  pieces() {
    return this.piecesJointes;
  }

  contenu() {
    const p = this.participant;
    const n = this.billets.length;
    const groupe = n > 1;
    const textes = BadgeLayout.textesDepuisReglages(this.settings);
    const nom = String(p.nom || "").trim().toLocaleUpperCase("fr-FR");

    // « Festival Adja 2027 · 15e édition », depuis les memes reglages que le badge.
    const titreEvenement = String(textes.titre).toLocaleLowerCase("fr-FR").replace(/(^|\s)\S/g, (c) => c.toLocaleUpperCase("fr-FR"));
    const edition = /^\d+$/.test(String(textes.edition).trim())
      ? ` · ${textes.edition}${BadgeLayout.exposantEdition(String(textes.edition).trim())} édition`
      : "";
    const evenement = `${titreEvenement} ${textes.annee}${edition}`.trim();

    // « les 12, 13, 14 & 15 Août 2027 » : les dates du badge, sans le gras.
    const dates = String(textes.dates).replace(/\*\*/g, "").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
    const rendezVous = dates
      ? `Rendez-vous ${dates.charAt(0).toLocaleLowerCase("fr-FR")}${dates.slice(1)} à ${textes.lieu} pour en profiter.`
      : `Rendez-vous à ${textes.lieu} pour en profiter.`;

    const details = [
      [groupe ? "Acheteur" : "Participant", p.nom || "—"],
      ["Événement", evenement],
      ["Lieu", p.lieu_retrait || this.settings.pickup_location || textes.lieu],
    ];
    if (groupe) details.push(["Badges", String(n)]);
    details.push(["Montant", montantTotal(this.billets)]);
    if (groupe) {
      this.billets.forEach((b, i) => details.push([`Badge ${i + 1} — ${b.nom || "?"}`, b.code_unique || "—", "code"]));
    } else {
      details.push(["Code d'accès", p.code_unique || "—", "code"]);
    }
    const quand = dateAchat(p);
    if (quand) details.push(["Date", quand]);

    return {
      // Le nom suit « Bingo », dans le titre en gras ; il n'est pas repete dans
      // la phrase d'accueil juste en dessous.
      titre: `Bingo${nom ? " " + nom : ""} 🎉 ${groupe ? `Vos ${n} badges sont prêts !` : "Votre badge est prêt !"}`,
      intro: `Kwabô ! Génial ! Vous venez de payer pour ${groupe ? `vos ${n} badges` : "votre badge"}.`,
      detailsTitre: "✨ Détails de l'achat :",
      details,
      conclusion: [
        groupe
          ? `${rendezVous} Gardez jalousement vos badges : chacun est personnel et sera demandé à l'entrée.`
          : `${rendezVous} Gardez jalousement votre badge : il vous sera demandé à l'entrée.`,
      ],
      boutonTexte: groupe ? "Télécharger mes badges" : "Télécharger mon badge",
      boutonLien: p.id ? this.absolu(`/retour-paiement.html?p=${encodeURIComponent(p.id)}`) : this.absolu("/"),
      piedNote: groupe
        ? "Tous les badges sont joints à ce message en PDF, un par personne. Chacun ne sert qu'une seule fois à l'entrée."
        : "Votre badge est joint à ce message en PDF. Il est personnel et ne sert qu'une seule fois à l'entrée.",
    };
  }
}

// « 15 000 F CFA » pour tout l'achat. Espace simple et non l'espace fine
// insecable de toLocaleString, mal rendue par certaines messageries.
function montantTotal(billets) {
  const unitaire = Number(billets[0] && billets[0].montant_valeur);
  if (!unitaire) return (billets[0] && billets[0].montant) || "—";
  return `${(unitaire * billets.length).toLocaleString("fr-FR").replace(/[  ]/g, " ")} F CFA`;
}

// « 1 octobre 2026 à 21:45 », heure du Benin.
function dateAchat(p) {
  const t = Number(p.validation_at || p.timestamp || 0);
  if (!t) return "";
  return new Date(t).toLocaleString("fr-FR", {
    timeZone: "Africa/Porto-Novo", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).replace(/[  ]/g, " ");
}

/* -------------------------------------------------------------------------
   2. Code de verification (recuperation du billet)
   ------------------------------------------------------------------------- */
class CodeVerificationEmail extends EmailBase {
  constructor(ctx) {
    super(ctx);
    this.email = ctx.email;
    this.code = ctx.code;
    this.dureeMinutes = ctx.dureeMinutes || 10;
  }

  destinataire() {
    return this.email;
  }

  sujet() {
    return `${this.code} — ton code pour récupérer ton badge ${this.eventName}`;
  }

  contenu() {
    return {
      titre: "Ton code de vérification",
      intro: "Saisis-le sur le site pour retrouver ton badge.",
      paragraphes: [
        `Ce code est valable ${this.dureeMinutes} minutes et ne fonctionne qu'une seule fois.`,
      ],
      encadreLabel: "Code de vérification",
      encadre: String(this.code || ""),
      boutonTexte: "Retourner sur le site",
      boutonLien: this.absolu("/"),
      piedNote:
        "Si tu n'as pas demandé ce code, ignore ce message : personne ne peut accéder à ton badge sans lui.",
    };
  }
}

/* -------------------------------------------------------------------------
   3. Paiement echoue
   ------------------------------------------------------------------------- */
class PaiementEchoueEmail extends EmailBase {
  constructor(ctx) {
    super(ctx);
    this.participant = ctx.participant || {};
    this.motif = ctx.motif || "";
  }

  destinataire() {
    return this.participant.email;
  }

  sujet() {
    return `Ton paiement ${this.eventName} n'a pas abouti`;
  }

  contenu() {
    const p = this.participant;
    const prenom = String(p.nom || "").trim().split(/\s+/)[0] || "";

    return {
      titre: "Ton paiement n'a pas abouti",
      intro: prenom ? `Bonjour ${prenom},` : "",
      paragraphes: [
        "La transaction n'a pas été validée par l'opérateur. Aucun montant n'a été débité.",
        this.motif ? `Motif indiqué : ${this.motif}` : "",
        "Tu peux réessayer quand tu veux : ta place n'est pas perdue, elle n'est simplement pas encore réservée.",
      ].filter(Boolean),
      details: [
        ["Référence", p.id || "—"],
        ["Montant attendu", p.montant || "—"],
      ],
      boutonTexte: "Réessayer",
      boutonLien: this.absolu("/"),
      piedNote: "Si un montant a malgré tout été débité, réponds à ce message avec ta référence.",
    };
  }
}

/* -------------------------------------------------------------------------
   4. Alerte interne a l'organisateur
   L'adresse vient des reglages : la coder en dur obligerait a redeployer pour
   en changer, et empecherait d'en avoir une differente en test et en reel.
   ------------------------------------------------------------------------- */
class AlerteInterneEmail extends EmailBase {
  constructor(ctx) {
    super(ctx);
    this.evenement = ctx.evenement || "Événement";
    this.lignes = ctx.lignes || [];
    this.note = ctx.note || "";
  }

  destinataire() {
    return (
      String(process.env.MAIL_ALERT_TO || "").trim() ||
      String(this.settings.alert_email || "").trim() ||
      String(this.settings.vendeur_email || "").trim()
    );
  }

  sujet() {
    return `[${this.eventName}] ${this.evenement}`;
  }

  contenu() {
    return {
      titre: this.evenement,
      intro: "Notification interne — ce message ne part qu'à l'organisation.",
      paragraphes: this.note ? [this.note] : [],
      details: this.lignes,
      boutonTexte: "Ouvrir l'administration",
      boutonLien: this.absolu("/admin.html"),
      piedNote: `Envoyé automatiquement par le site ${this.eventName}.`,
    };
  }
}

/* -------------------------------------------------------------------------
   4 bis. Alerte de securite (lib/sentinelle.js)
   Destinataire propre : la personne qui surveille la securite n'est pas
   forcement celle qui recoit les avis d'inscription. A defaut, l'adresse des
   alertes internes.
   ------------------------------------------------------------------------- */
class AlerteSecuriteEmail extends AlerteInterneEmail {
  destinataire() {
    return (
      String(process.env.MAIL_SECURITE_TO || "").trim() ||
      String(this.settings.securite_email || "").trim() ||
      super.destinataire()
    );
  }

  sujet() {
    return `[${this.eventName} - Sécurité] ${this.evenement}`;
  }

  contenu() {
    return Object.assign(super.contenu(), {
      intro: "Alerte de sécurité — détectée automatiquement par le site.",
      piedNote: `Surveillance automatique du site ${this.eventName}. Journal complet : Admin → Réglages → Sécurité.`,
    });
  }
}

/* -------------------------------------------------------------------------
   5. Essai — sert au bouton "Envoyer un e-mail de test" de l'admin
   ------------------------------------------------------------------------- */
class EmailDeTest extends EmailBase {
  constructor(ctx) {
    super(ctx);
    this.email = ctx.email;
  }

  destinataire() {
    return this.email;
  }

  sujet() {
    return `Test d'envoi — ${this.eventName}`;
  }

  contenu() {
    const d = new Date().toLocaleString("fr-FR");
    return {
      titre: "L'envoi d'e-mails fonctionne",
      intro: "Ce message confirme que la configuration est correcte.",
      paragraphes: [
        "Si tu lis ceci dans ta boîte de réception et non dans les indésirables, l'expéditeur, l'authentification et les enregistrements DNS sont en place.",
      ],
      details: [
        ["Envoyé le", d],
        ["Événement", this.eventName],
      ],
      boutonTexte: "Ouvrir le site",
      boutonLien: this.absolu("/"),
      piedNote: "Message de test déclenché depuis l'administration.",
    };
  }
}

module.exports = {
  EmailBase,
  PaiementConfirmeEmail,
  CodeVerificationEmail,
  PaiementEchoueEmail,
  AlerteInterneEmail,
  AlerteSecuriteEmail,
  EmailDeTest,
};
