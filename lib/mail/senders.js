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

const { renderEmail, renderText } = require("./template");
const { sendMail } = require("./transport");

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
    const params = Object.assign(
      {
        eventName: this.eventName,
        logoUrl: this.absolu(String(this.settings.logo_url || "").split("?")[0]),
      },
      this.contenu(),
    );

    return {
      to: this.destinataire(),
      subject: this.sujet(),
      html: renderEmail(params),
      text: renderText(params),
      attachments: this.pieces(),
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

  sujet() {
    if (this.billets.length > 1) {
      return `Tes ${this.billets.length} badges ${this.eventName}`.trim();
    }
    return `Ton code ${this.eventName} : ${this.participant.code_unique || ""}`.trim();
  }

  pieces() {
    return this.piecesJointes;
  }

  contenu() {
    const p = this.participant;
    const prenom = String(p.nom || "").trim().split(/\s+/)[0] || "";
    const groupe = this.billets.length > 1;

    if (groupe) {
      return {
        titre: `Tes ${this.billets.length} badges sont confirmés`,
        intro: prenom ? `Bonjour ${prenom}, tout le groupe est confirmé.` : "Tout le groupe est confirmé.",
        paragraphes: [
          "Chaque personne a son propre code et son propre badge. Remets à chacun le sien : "
          + "un code ne sert qu'une fois, et l'entrée se fait au nom inscrit dessus.",
          "Tous les badges sont joints à ce message en PDF.",
        ],
        // Pas d'encadre : mettre un seul code en avant laisserait croire qu'il
        // vaut pour tout le groupe. Chaque nom porte le sien.
        details: this.billets
          .map((b, i) => [`${i + 1}. ${b.nom || "—"}`, b.code_unique || "—"])
          .concat([["Lieu", p.lieu_retrait || this.settings.pickup_location || "—"]]),
        boutonTexte: "Retrouver mes badges",
        boutonLien: this.absolu("/#verifier"),
        piedNote:
          "Chaque badge est personnel et ne sert qu'une fois. Tu peux les retrouver à tout moment "
          + "depuis le site avec cette adresse email.",
      };
    }

    return {
      titre: "Ton paiement est confirmé",
      intro: prenom ? `Bonjour ${prenom}, ta présence est confirmée.` : "Ta présence est confirmée.",
      paragraphes: [
        "Voici ton code d'accès. Présente-le, ou le QR code joint, à l'entrée le jour de l'événement.",
      ],
      encadreLabel: "Ton code d'accès",
      encadre: p.code_unique || "",
      details: [
        ["Participant", p.nom || "—"],
        ["Montant", p.montant || "—"],
        ["Lieu", p.lieu_retrait || this.settings.pickup_location || "—"],
      ].filter(([, v]) => v && v !== "—" ? true : v === "—" ? false : true),
      boutonTexte: "Vérifier mon code",
      boutonLien: this.absolu(`/verification.html?code=${encodeURIComponent(p.code_unique || "")}`),
      piedNote:
        "Ce badge est personnel et ne sert qu'une fois. Le badge PDF est joint à ce message.",
    };
  }
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
  EmailDeTest,
};
