/* Referencement : balises de tete, donnees structurees, robots.txt, sitemap.
 *
 * Les balises sont ecrites par le SERVEUR dans le HTML, pas par le script de
 * la page : WhatsApp, Facebook et la premiere lecture de Google n'executent
 * pas le JavaScript. Un lien colle dans un groupe WhatsApp n'aurait sinon ni
 * titre ni image.
 *
 * Fonctions pures : le serveur leur passe les reglages deja lus.
 */

"use strict";

const BadgeLayout = require("../js/badge-layout");

const MOIS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

// Image de partage : 1200 x 630, le format attendu par WhatsApp, Facebook et X.
const IMAGE_PARTAGE = { chemin: "/img/partage-festival-adja.jpg", largeur: 1200, hauteur: 630 };

const ORGANISATION = "FEJA – Fraternité pour l'Épanouissement de la Jeunesse d'Aplahoué";

function echapper(valeur) {
  return String(valeur == null ? "" : valeur)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sansAccents(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// « FESTIVAL ADJA » -> « Festival Adja » : les capitales du badge crient dans
// un resultat de recherche.
function nomPropre(texte) {
  return String(texte || "").toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, l) => sep + l.toUpperCase());
}

// « Les **12,13, 14** & **15 Août 2027** » -> « 12, 13, 14 & 15 août 2027 ».
function datesEnClair(dates) {
  return String(dates || "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^les\s+/i, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\p{L}+/gu, (mot) => (MOIS[sansAccents(mot).toLowerCase()] ? mot.toLowerCase() : mot));
}

/* Premier et dernier jour du festival, lus dans le texte des dates du badge.
   Rend null si le texte ne se laisse pas lire : on prefere alors ne rien
   annoncer a Google plutot qu'une date fausse. */
function periodeFestival(dates) {
  const s = sansAccents(datesEnClair(dates)).toLowerCase();
  const annee = (s.match(/\b(20\d{2})\b/) || [])[1];
  const mois = Object.keys(MOIS).find((m) => new RegExp(`\\b${m}\\b`).test(s));
  if (!annee || !mois) return null;
  const avantMois = s.slice(0, s.search(new RegExp(`\\b${mois}\\b`)));
  const jours = (avantMois.match(/\b\d{1,2}\b/g) || []).map(Number).filter((j) => j >= 1 && j <= 31);
  if (!jours.length) return null;
  const iso = (j) => `${annee}-${String(MOIS[mois]).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
  const debut = iso(Math.min(...jours));
  const fin = iso(Math.max(...jours));
  // 31 fevrier et autres dates impossibles : refusees.
  const valide = (d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  return valide(debut) && valide(fin) ? { debut, fin } : null;
}

function activites(texte, nombre) {
  return String(texte || "")
    .split(/\n|\s-\s/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, nombre);
}

/* Titre et description de l'accueil, tires des reglages du badge : apres le
   30 aout, ils passent a l'annee suivante avec lui. */
function textesAccueil(textes) {
  const nom = nomPropre(textes.titre);
  const edition = `${textes.edition}${BadgeLayout.exposantEdition(String(textes.edition))}`;
  const dates = datesEnClair(textes.dates);
  const quoi = activites(textes.activites, 3).join(", ");
  return {
    titre: `${nom} ${textes.annee} à ${textes.lieu} – Réserve ton badge | FEJA`,
    description:
      `${nom} ${textes.annee}, ${edition} édition${dates ? `, les ${dates}` : ""} à ${textes.lieu} (Bénin)` +
      `${quoi ? ` : ${quoi}` : ""}. Réserve ton badge en ligne et paie par Mobile Money.`,
    nom,
    edition,
  };
}

/* Donnees structurees de l'accueil : l'evenement, l'organisation, le site.
   C'est ce qui permet a Google d'afficher la date, le lieu et le prix dans
   ses resultats et dans sa liste d'evenements. */
function donneesAccueil({ base, textes, lieu, prix, artistes, description, reseaux = [] }) {
  const t = textesAccueil(textes);
  const periode = periodeFestival(textes.dates);
  const image = base + IMAGE_PARTAGE.chemin;
  const organisation = {
    "@type": "Organization",
    name: ORGANISATION,
    alternateName: ["FEJA", "Festival Adja"],
    url: base + "/",
    logo: base + "/img/icone-512.png",
  };
  // Pages officielles (TikTok, Facebook...) : Google les relie a l'association.
  if (reseaux.length) organisation.sameAs = reseaux;
  const donnees = [
    { "@context": "https://schema.org", "@type": "WebSite", name: t.nom, alternateName: "FEJA", url: base + "/", inLanguage: "fr" },
    Object.assign({ "@context": "https://schema.org" }, organisation),
  ];
  if (periode) {
    const evenement = {
      "@context": "https://schema.org",
      "@type": "Festival",
      name: `${t.nom} ${textes.annee} – ${t.edition} édition`,
      description,
      startDate: periode.debut,
      endDate: periode.fin,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      inLanguage: "fr",
      image: [image],
      url: base + "/",
      location: {
        "@type": "Place",
        name: lieu || textes.lieu,
        address: Object.assign(
          { "@type": "PostalAddress", addressLocality: textes.lieu, addressCountry: "BJ" },
          lieu ? { streetAddress: lieu } : {},
        ),
      },
      organizer: organisation,
    };
    if (Number(prix) > 0) {
      evenement.offers = {
        "@type": "Offer",
        name: "Badge d'accès",
        price: String(Number(prix)),
        priceCurrency: "XOF",
        availability: "https://schema.org/InStock",
        url: base + "/",
      };
    }
    const noms = (artistes || []).map((a) => String((a && a.name) || "").trim()).filter(Boolean);
    if (noms.length) evenement.performer = noms.map((name) => ({ "@type": "Person", name }));
    donnees.push(evenement);
  }
  return donnees;
}

function jsonLd(objet) {
  // « < » echappe : un nom d'artiste contenant </script> fermerait la balise.
  return `<script type="application/ld+json">${JSON.stringify(objet).replace(/</g, "\\u003c")}</script>`;
}

/* Balises posees dans <head>. `url` et `base` sont absolues. */
function balisesTete({ base, chemin, titre, description, indexer = true, donnees = [], verificationGoogle = "" }) {
  const url = base + chemin;
  const image = base + IMAGE_PARTAGE.chemin;
  const imageAlt = "Festival Adja à Azovè, Bénin – réserve ton badge en ligne";
  const lignes = [
    `<meta name="description" content="${echapper(description)}">`,
    `<meta name="robots" content="${indexer ? "index, follow, max-image-preview:large" : "noindex, nofollow"}">`,
    `<link rel="canonical" href="${echapper(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Festival Adja">`,
    `<meta property="og:locale" content="fr_FR">`,
    `<meta property="og:title" content="${echapper(titre)}">`,
    `<meta property="og:description" content="${echapper(description)}">`,
    `<meta property="og:url" content="${echapper(url)}">`,
    `<meta property="og:image" content="${echapper(image)}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="${IMAGE_PARTAGE.largeur}">`,
    `<meta property="og:image:height" content="${IMAGE_PARTAGE.hauteur}">`,
    `<meta property="og:image:alt" content="${echapper(imageAlt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${echapper(titre)}">`,
    `<meta name="twitter:description" content="${echapper(description)}">`,
    `<meta name="twitter:image" content="${echapper(image)}">`,
    `<meta name="theme-color" content="#05201a">`,
    `<link rel="icon" type="image/png" sizes="192x192" href="/img/icone-192.png">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">`,
    verificationGoogle ? `<meta name="google-site-verification" content="${echapper(verificationGoogle)}">` : "",
    ...donnees.map(jsonLd),
  ];
  return lignes.filter(Boolean).join("\n");
}

/* Code de Google Search Console. L'organisateur colle souvent la balise
   entiere : on en extrait la valeur. Rien d'autre qu'un jeton n'est accepte. */
function codeVerificationGoogle(saisie) {
  const s = String(saisie || "").trim();
  const dansBalise = s.match(/content=["']([^"']+)["']/i);
  const code = (dansBalise ? dansBalise[1] : s).trim();
  return /^[A-Za-z0-9_-]{10,100}$/.test(code) ? code : "";
}

/* Adresses des pages officielles, une par ligne ; seules les adresses web
   completes en https sont gardees. */
function pagesOfficielles(saisie) {
  return String(saisie || "")
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https:\/\/[^\s<>"]+$/i.test(u))
    .slice(0, 10);
}

function lireTitre(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : "";
}

function lireDescription(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/i);
  return m ? m[1] : "";
}

/* Pose le titre et les balises dans la page. La description propre a la page
   est retiree : elle revient, identique, dans le bloc engendre. */
function injecter(html, { titre, tete }) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${echapper(titre)}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>\s*/i, "")
    .replace(/<\/head>/i, `${tete}\n</head>`);
}

/* Texte des elements data-cfg="cle" remplace par la valeur des reglages, pour
   que le HTML lu par un robot dise deja la verite (annee, lieu, prix...). */
function remplirTextes(html, valeurs) {
  return html.replace(/(<([a-z0-9]+)\b[^>]*\sdata-cfg="([a-zA-Z]+)"[^>]*>)([^<]*)(<\/\2>)/g, (tout, ouverture, _b, cle, _t, fermeture) => (
    Object.prototype.hasOwnProperty.call(valeurs, cle) && valeurs[cle] != null
      ? ouverture + echapper(valeurs[cle]) + fermeture
      : tout
  ));
}

function robotsTxt(base) {
  return [
    "User-agent: *",
    "Allow: /",
    // Necessaires a Google pour afficher la page telle qu'un visiteur la voit.
    "Allow: /api/public-config",
    "Allow: /api/theme.css",
    "Allow: /api/branding/",
    "Disallow: /api/",
    // Photos des participants et QR d'entree : jamais dans un moteur.
    "Disallow: /uploads/participants/",
    "Disallow: /uploads/qrcodes/",
    "Disallow: /uploads/proofs/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

function sitemapXml(base, pages) {
  const urls = pages.map((p) => [
    "  <url>",
    `    <loc>${echapper(base + p.chemin)}</loc>`,
    p.modif ? `    <lastmod>${p.modif}</lastmod>` : "",
    p.frequence ? `    <changefreq>${p.frequence}</changefreq>` : "",
    p.priorite ? `    <priority>${p.priorite}</priority>` : "",
    "  </url>",
  ].filter(Boolean).join("\n"));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

module.exports = {
  IMAGE_PARTAGE, ORGANISATION,
  echapper, nomPropre, datesEnClair, periodeFestival, textesAccueil, donneesAccueil,
  balisesTete, codeVerificationGoogle, pagesOfficielles, lireTitre, lireDescription, injecter, remplirTextes, robotsTxt, sitemapXml,
};
