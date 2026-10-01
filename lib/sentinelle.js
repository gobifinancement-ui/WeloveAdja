/* Sentinelle : repere les comportements suspects (fraude, attaques) et les
 * incidents qui coutent cher au projet, les consigne, et previent
 * l'organisation par e-mail.
 *
 * Trois niveaux :
 *   critique — e-mail immediat (fraude au paiement, base illisible...)
 *   alerte   — e-mail groupe : ce qui arrive dans les 2 minutes part dans le
 *              meme message, pour ne pas noyer la boite pendant une attaque
 *   info     — journal seulement
 *
 * Tout est consigne dans data/securite.jsonl et visible dans l'admin, meme
 * quand l'e-mail ne peut pas partir : une alerte perdue est pire qu'une
 * alerte en retard.
 *
 * Module sans dependance a la base : le serveur lui passe de quoi envoyer
 * un e-mail, et l'appelle aux endroits qui comptent.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const TAILLE_MAX_JOURNAL = 5 * 1024 * 1024;
const GARDES_EN_MEMOIRE = 300;
const DELAI_GROUPE_MS = 2 * 60 * 1000;
// Plafond d'e-mails : au-dela, les alertes restent au journal et le message
// suivant dit combien ont ete retenues. Une attaque ne doit pas epuiser le
// quota d'envoi du site (les badges des participants passent par le meme).
const MAX_EMAILS_PAR_HEURE = 12;

// Adresses que seuls cherchent les robots qui testent des failles connues.
const CHEMINS_SONDES = /(\/\.env|\/\.git|\/\.ssh|\/\.aws|\/\.htaccess|wp-(admin|login|content|includes)|xmlrpc|phpmyadmin|\.php(\?|$)|\/cgi-bin|\/etc\/passwd|\.\.\/|%2e%2e|\/data\/|\.sqlite|\/server\.(js|bat)|\/package(-lock)?\.json|\/node_modules|\/config\.(json|yml|js)|\/backup|\.bak$|\.sql$|\/actuator|\/solr|\/vendor\/|\/admin\.php|\/boaform|\/HNAP1)/i;

// Ce que l'organisation doit faire, par type d'evenement. Un e-mail d'alerte
// sans consigne fait paniquer sans aider.
const CONSIGNES = {
  sonde: "Un robot teste des adresses connues pour trouver une faille (.env, .git, wp-admin…). Le site les refuse déjà. Rien à faire si cela s'arrête ; si cela dure, faire bloquer cette adresse IP par l'hébergeur.",
  rafale_404: "Une adresse parcourt le site au hasard, probablement un robot d'exploration ou d'attaque. À surveiller ; faire bloquer l'IP si cela continue.",
  limites: "Une adresse dépasse sans cesse les limites anti-abus (inscriptions, codes, téléchargements). Elle est déjà freinée automatiquement. Si l'IP revient souvent, la faire bloquer.",
  flot: "Une seule adresse envoie un volume de requêtes anormal : tentative de saturation probable. Faire bloquer l'IP chez l'hébergeur si le site ralentit.",
  trafic: "Pic de trafic très inhabituel. Si ce n'est pas l'ouverture des inscriptions ou le jour J, il peut s'agir d'une attaque par saturation.",
  erreurs_serveur: "Plusieurs erreurs serveur d'affilée : une partie du site ne fonctionne plus. Regarder le journal du serveur et prévenir le développeur.",
  lenteur: "Le site met plus de 15 s à répondre. Risque de paiements abandonnés. Vérifier la charge de l'hébergement.",
  log: "Erreurs en série dans le journal du serveur. Extrait ci-dessous ; à transmettre au développeur.",
  admin_echecs: "Plusieurs mots de passe admin faux. Si ce n'est pas l'équipe, quelqu'un essaie de deviner le mot de passe : le changer pour un mot de passe long, et ne jamais le partager.",
  admin_connexion: "Connexion à l'administration depuis une adresse jamais vue. Si ce n'est personne de l'équipe, changer immédiatement le mot de passe admin.",
  reglage_sensible: "Un réglage sensible a été modifié dans l'admin. Si personne de l'équipe ne l'a fait, changer le mot de passe admin et vérifier les clés de paiement.",
  demo: "Le mode démonstration délivre des badges SANS paiement. À couper immédiatement s'il n'est pas voulu.",
  validation_manuelle: "Un badge a été validé à la main dans l'admin, sans paiement FedaPay. Normal pour un paiement en espèces ; sinon, vérifier qui l'a fait.",
  fraude_paiement: "Tentative de fraude au paiement (montant faux, transaction déjà utilisée). Le badge n'a PAS été délivré. Vérifier la transaction dans le tableau de bord FedaPay.",
  webhook_signature: "Un message se faisant passer pour FedaPay a été refusé (signature fausse). Quelqu'un tente de faire valider des badges sans payer. Aucun badge n'a été délivré.",
  webhook_inconnu: "FedaPay (ou quelqu'un qui s'en fait passer) a envoyé des notifications pour des transactions inconnues du site. À vérifier si cela se répète.",
  codes_devines: "Une adresse essaie beaucoup de codes d'accès faux : tentative de deviner des badges valides. Elle est freinée automatiquement.",
  double_entree: "Un badge déjà scanné a été présenté une seconde fois à l'entrée : badge partagé, copié ou photographié. Le contrôleur doit vérifier la photo.",
  email_echec: "Des e-mails de badge ne partent pas : les participants ne reçoivent pas leur badge par e-mail et vont solliciter l'équipe. Vérifier la configuration SMTP / Resend.",
  fedapay: "FedaPay répond en erreur : les paiements risquent d'échouer. Vérifier l'état du service FedaPay et la clé de paiement.",
  disque: "L'espace disque du serveur s'épuise. Plein, le site ne peut plus enregistrer d'inscription. Libérer de la place ou augmenter l'offre d'hébergement.",
  memoire: "Le serveur consomme beaucoup de mémoire. Risque d'arrêt par l'hébergeur. Redémarrer le serveur en heure creuse.",
  base: "La base de données n'a pas pu être écrite sur le disque. Risque de PERTE D'INSCRIPTIONS. Intervenir immédiatement.",
  sauvegarde: "La sauvegarde automatique de la base a échoué. Vérifier l'espace disque.",
  config: "Réglage dangereux pour la mise en ligne. Détail ci-dessous.",
  inscriptions_suspendues: "Les inscriptions sont suspendues faute d'espace disque. Libérer de la place immédiatement.",
  test: "Alerte de test déclenchée depuis l'administration : si tu lis ce message, les alertes de sécurité arrivent bien.",
};

const NOMS_GRAVITE = { critique: "CRITIQUE", alerte: "Alerte", info: "Info" };

function heureBenin(t) {
  return new Date(t).toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" });
}

class Sentinelle {
  /**
   * @param {object} o
   * @param {string} o.dossier          dossier du journal (data/)
   * @param {Function} o.envoyer        async (sujet, lignes, note) => boolean
   * @param {Function} [o.journalConsole] console d'origine, pour ne jamais
   *                                     s'observer soi-meme
   */
  constructor({ dossier, envoyer, journalConsole }) {
    this.fichier = path.join(dossier, "securite.jsonl");
    this.envoyer = envoyer;
    this.console = journalConsole || console;
    this.compteurs = new Map();
    this.derniersEnvois = new Map();
    this.groupe = [];
    this.minuteurGroupe = null;
    this.envoisRecents = [];
    this.retenues = 0;
    this.recents = [];
    this.lignesLog = [];
    this.exemples = new Map();
    this.dernierEnvoi = null;
    this.chargerRecents();
  }

  chargerRecents() {
    try {
      const lignes = fs.readFileSync(this.fichier, "utf8").trim().split("\n").slice(-GARDES_EN_MEMOIRE);
      this.recents = lignes.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* pas encore de journal */ }
  }

  // Vrai au moment exact ou le seuil est atteint dans la fenetre : une
  // alerte par franchissement, pas une par requete au-dela.
  franchit(cle, seuil, fenetreMs) {
    const t = Date.now();
    const liste = (this.compteurs.get(cle) || []).filter((x) => t - x < fenetreMs);
    liste.push(t);
    this.compteurs.set(cle, liste);
    return liste.length === seuil;
  }

  // Garde quelques exemples par cle (chemins sondes, messages d'erreur...).
  retenirExemple(cle, valeur, max = 6) {
    const liste = this.exemples.get(cle) || [];
    if (!liste.includes(valeur)) liste.push(valeur);
    this.exemples.set(cle, liste.slice(-max));
    return this.exemples.get(cle);
  }

  /**
   * Consigne un evenement et, selon sa gravite, previent par e-mail.
   * @param {object} e
   * @param {"critique"|"alerte"|"info"} e.gravite
   * @param {string} e.type     cle de CONSIGNES
   * @param {string} e.titre
   * @param {Array<[string,string]>} [e.details]
   * @param {string} [e.ip]
   * @param {string} [e.cle]    regroupement anti-doublon (defaut : type + ip)
   * @param {number} [e.delai]  delai anti-doublon propre (rappels periodiques)
   */
  signaler({ gravite = "alerte", type, titre, details = [], ip = "", cle, delai: delaiPropre }) {
    const evenement = {
      t: Date.now(),
      gravite,
      type,
      titre,
      ip: ip || "",
      details: details.map(([k, v]) => [String(k), String(v == null ? "" : v).slice(0, 500)]),
    };

    // Une meme alerte n'est ni renvoyee ni reecrite avant 30 min (10 min pour
    // une critique) : une attaque qui dure, ou un rappel periodique, ne doit
    // produire ni un e-mail ni une ligne de journal par occurrence.
    if (gravite !== "info") {
      const dedup = cle || `${type}:${ip}`;
      const delai = delaiPropre || (gravite === "critique" ? 10 * 60 * 1000 : 30 * 60 * 1000);
      const dernier = this.derniersEnvois.get(dedup) || 0;
      if (Date.now() - dernier < delai) return evenement;
      this.derniersEnvois.set(dedup, Date.now());
    }

    this.recents.push(evenement);
    if (this.recents.length > GARDES_EN_MEMOIRE) this.recents.shift();
    this.ecrireJournal(evenement);
    this.console.warn(`[SECURITE] ${NOMS_GRAVITE[gravite] || gravite} - ${titre}${ip ? " (" + ip + ")" : ""}`);

    if (gravite === "info") return evenement;

    if (gravite === "critique") {
      this.expedier([evenement]);
    } else {
      this.groupe.push(evenement);
      if (!this.minuteurGroupe) {
        this.minuteurGroupe = setTimeout(() => this.viderGroupe(), DELAI_GROUPE_MS);
        if (this.minuteurGroupe.unref) this.minuteurGroupe.unref();
      }
    }
    return evenement;
  }

  viderGroupe() {
    this.minuteurGroupe = null;
    const lot = this.groupe.splice(0);
    if (lot.length) this.expedier(lot);
  }

  async expedier(lot, forcer = false) {
    const t = Date.now();
    this.envoisRecents = this.envoisRecents.filter((x) => t - x < 60 * 60 * 1000);
    if (!forcer && this.envoisRecents.length >= MAX_EMAILS_PAR_HEURE) {
      this.retenues += lot.length;
      return false;
    }
    this.envoisRecents.push(t);

    const principal = lot.find((e) => e.gravite === "critique") || lot[0];
    const sujet = lot.length > 1
      ? `${principal.gravite === "critique" ? "CRITIQUE - " : ""}${lot.length} alertes de sécurité`
      : `${principal.gravite === "critique" ? "CRITIQUE - " : "Alerte - "}${principal.titre}`;

    const lignes = [];
    lot.forEach((e, i) => {
      if (lot.length > 1) lignes.push([`#${i + 1}`, `${NOMS_GRAVITE[e.gravite]} - ${e.titre}`]);
      lignes.push(["Quand", heureBenin(e.t)]);
      if (e.ip) lignes.push(["Adresse IP", e.ip]);
      e.details.forEach((d) => lignes.push(d));
    });
    if (this.retenues) {
      lignes.push(["Non envoyées", `${this.retenues} alerte(s) retenue(s) faute de quota ; voir le journal dans l'admin`]);
      this.retenues = 0;
    }

    const consignes = [...new Set(lot.map((e) => CONSIGNES[e.type]).filter(Boolean))];
    try {
      const ok = await this.envoyer(sujet, lignes, consignes.join("\n\n"));
      this.dernierEnvoi = { t: Date.now(), ok: true, erreur: "" };
      return ok;
    } catch (error) {
      this.dernierEnvoi = { t: Date.now(), ok: false, erreur: error.message };
      this.console.warn("[SECURITE] Alerte non envoyee par e-mail :", error.message);
      return false;
    }
  }

  // Alerte de test depuis l'admin : sans anti-doublon ni plafond, pour que
  // l'organisateur sache tout de suite si les alertes arrivent.
  async tester(ip) {
    const evenement = { t: Date.now(), gravite: "critique", type: "test", titre: "Alerte de test", ip: ip || "", details: [] };
    this.recents.push(evenement);
    this.ecrireJournal(evenement);
    const ok = await this.expedier([evenement], true);
    return { ok, erreur: ok ? "" : (this.dernierEnvoi && this.dernierEnvoi.erreur) || "envoi impossible" };
  }

  ecrireJournal(evenement) {
    try {
      fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
      try {
        if (fs.statSync(this.fichier).size > TAILLE_MAX_JOURNAL) {
          fs.renameSync(this.fichier, this.fichier.replace(/\.jsonl$/, ".1.jsonl"));
        }
      } catch { /* pas encore de journal */ }
      fs.appendFileSync(this.fichier, JSON.stringify(evenement) + "\n");
    } catch (error) {
      this.console.warn("[SECURITE] Journal inaccessible :", error.message);
    }
  }

  // --- Observation de chaque requete -------------------------------------

  observerRequete({ ip, methode, chemin, statut, duree }) {
    if (CHEMINS_SONDES.test(chemin)) {
      const exemples = this.retenirExemple(`sonde:${ip}`, `${methode} ${chemin}`.slice(0, 120));
      if (this.franchit(`sonde:${ip}`, 3, 10 * 60 * 1000)) {
        this.signaler({ gravite: "alerte", type: "sonde", titre: "Recherche de failles sur le site", ip,
          details: [["Adresses testées", exemples.join("  |  ")]] });
      }
    }

    if (statut === 404 && this.franchit(`404:${ip}`, 80, 5 * 60 * 1000)) {
      this.signaler({ gravite: "alerte", type: "rafale_404", titre: "Exploration du site en rafale (80 pages introuvables en 5 min)", ip });
    }
    if (statut === 429 && this.franchit(`429:${ip}`, 15, 10 * 60 * 1000)) {
      this.signaler({ gravite: "alerte", type: "limites", titre: "Limites anti-abus dépassées en boucle", ip,
        details: [["Dernière page visée", chemin]] });
    }
    if (statut >= 500) {
      const exemples = this.retenirExemple("5xx", `${statut} ${methode} ${chemin}`);
      if (this.franchit("5xx", 5, 5 * 60 * 1000)) {
        this.signaler({ gravite: "alerte", type: "erreurs_serveur", titre: "Erreurs serveur en série (5 en 5 min)", cle: "5xx",
          details: [["Requêtes en erreur", exemples.join("  |  ")]] });
      }
    }
    if (duree > 15000 && this.franchit("lent", 5, 5 * 60 * 1000)) {
      this.signaler({ gravite: "alerte", type: "lenteur", titre: "Le site répond très lentement", cle: "lent",
        details: [["Exemple", `${chemin} en ${Math.round(duree / 1000)} s`]] });
    }
    // Seuils hauts : derriere une IP d'operateur mobile, 50 vrais visiteurs
    // font deja ~600 requetes par minute. Une saturation est bien au-dessus.
    if (this.franchit(`flot:${ip}`, 2000, 60 * 1000)) {
      this.signaler({ gravite: "alerte", type: "flot", titre: "Plus de 2000 requêtes par minute depuis une seule adresse", ip });
    }
    if (this.franchit("trafic", 6000, 60 * 1000)) {
      this.signaler({ gravite: "alerte", type: "trafic", titre: "Pic de trafic anormal (6000 requêtes en une minute)", cle: "trafic" });
    }
  }

  // --- Observation du journal du serveur ---------------------------------

  observerLog(niveau, args) {
    const texte = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(" ").replace(/\s+/g, " ").slice(0, 300);
    if (texte.startsWith("[SECURITE]")) return;
    this.lignesLog.push(`${heureBenin(Date.now())} ${niveau} ${texte}`);
    if (this.lignesLog.length > 30) this.lignesLog.shift();
    if (niveau === "error" && this.franchit("log", 10, 5 * 60 * 1000)) {
      this.signaler({ gravite: "alerte", type: "log", titre: "Erreurs en série dans le journal du serveur (10 en 5 min)", cle: "log",
        details: this.lignesLog.slice(-8).map((l, i) => [`Ligne ${i + 1}`, l]) });
    }
  }

  // Branche l'observation sur console.error / console.warn.
  brancherConsole() {
    const origine = { error: console.error.bind(console), warn: console.warn.bind(console) };
    this.console = { warn: origine.warn, error: origine.error };
    ["error", "warn"].forEach((niveau) => {
      console[niveau] = (...args) => {
        origine[niveau](...args);
        try { this.observerLog(niveau, args); } catch { /* la sentinelle ne doit jamais casser un log */ }
      };
    });
  }

  journal(n = 100) {
    return this.recents.slice(-n).reverse();
  }
}

module.exports = { Sentinelle, CHEMINS_SONDES, CONSIGNES };
