/* Tests du referencement : textes, dates de l'evenement, balises, robots.
 *
 * Lancer : npm test
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const seo = require("../lib/seo");
const BadgeLayout = require("../js/badge-layout");

const TEXTES = Object.assign({}, BadgeLayout.DEFAUTS);
const BASE = "https://feja.test";

test("les dates du badge se lisent en clair et donnent le debut et la fin", () => {
  assert.equal(seo.datesEnClair("Les **12,13, 14** & **15 Août 2027**"), "12, 13, 14 & 15 août 2027");
  assert.deepEqual(seo.periodeFestival("Les **12,13, 14** & **15 Août 2027**"), { debut: "2027-08-12", fin: "2027-08-15" });
  assert.deepEqual(seo.periodeFestival("Le 28 décembre 2026"), { debut: "2026-12-28", fin: "2026-12-28" });
  // Illisible ou impossible : rien plutot qu'une date fausse.
  assert.equal(seo.periodeFestival("Bientôt"), null);
  assert.equal(seo.periodeFestival("Les 30 & 31 février 2027"), null);
});

test("titre et description de l'accueil suivent les reglages du badge", () => {
  const t = seo.textesAccueil(TEXTES);
  // FEJA en tete : c'est ce que le public tape dans Google.
  assert.equal(t.titre, "FEJA 2027 · Festival Adja à Azovè – Réserve ton badge");
  assert.ok(t.titre.length <= 60, "titre coupe par Google : " + t.titre.length);
  assert.match(t.description, /^FEJA 2027, le Festival Adja : 15e édition, les 12, 13, 14 & 15 août 2027 à Azovè \(Bénin\)/);
  assert.match(t.description, /culture adja, concert, sports/);
  assert.ok(t.description.length <= 200, "description trop longue : " + t.description.length);
  // Annee suivante apres la bascule : le titre suit.
  const apres = BadgeLayout.editionEnCours(TEXTES, "30/08", Date.parse("2027-09-02T12:00:00Z"));
  assert.match(seo.textesAccueil(Object.assign({}, TEXTES, apres)).titre, /^FEJA 2028 · Festival Adja /);
});

test("les donnees structurees decrivent un festival avec lieu, dates et prix", () => {
  const d = seo.donneesAccueil({ base: BASE, textes: TEXTES, lieu: "Terrain Omnisports CEG2 Azovè", prix: 5000,
    artistes: [{ name: "Artiste Un" }, { name: "" }], description: "Desc" });
  const ev = d.find((x) => x["@type"] === "Festival");
  assert.equal(ev.startDate, "2027-08-12");
  assert.equal(ev.endDate, "2027-08-15");
  assert.equal(ev.location.name, "Terrain Omnisports CEG2 Azovè");
  assert.equal(ev.location.address.addressCountry, "BJ");
  assert.equal(ev.offers.price, "5000");
  assert.equal(ev.offers.priceCurrency, "XOF");
  assert.deepEqual(ev.performer, [{ "@type": "Person", name: "Artiste Un" }]);
  // Ventes ouvertes le lendemain de la bascule de l'annee precedente.
  assert.equal(ev.offers.validFrom, "2026-08-31T00:00:00+01:00");
  // Sans artiste annonce, Google veut quand meme un « performer ».
  const sans = seo.donneesAccueil({ base: BASE, textes: TEXTES, lieu: "", prix: 5000, artistes: [], description: "D", bascule: "15/09" })
    .find((x) => x["@type"] === "Festival");
  assert.equal(sans.performer[0]["@type"], "PerformingGroup");
  assert.equal(sans.offers.validFrom, "2026-09-16T00:00:00+01:00");
  assert.equal(ev.image[0], BASE + seo.IMAGE_PARTAGE.chemin);
  assert.equal(d.find((x) => x["@type"] === "WebSite").name, "FEJA", "nom du site affiche par Google");
  assert.match(ev.name, /^FEJA 2027 – Festival Adja/);
});

test("les balises sont echappees, le JSON-LD ne peut pas fermer sa balise", () => {
  const tete = seo.balisesTete({ base: BASE, chemin: "/", titre: 'A "B" <c>', description: "x & y",
    donnees: [{ name: "</script><script>alert(1)</script>" }] });
  assert.match(tete, /<meta property="og:title" content="A &quot;B&quot; &lt;c&gt;">/);
  assert.match(tete, /<link rel="canonical" href="https:\/\/feja\.test\/">/);
  assert.match(tete, /<meta property="og:image" content="https:\/\/feja\.test\/img\/partage-feja\.jpg">/);
  // Icones lues par Google, gardees par js/branding.js.
  assert.match(tete, /<link rel="icon" href="\/favicon\.ico" sizes="48x48" data-fixe>/);
  assert.match(tete, /<meta property="og:site_name" content="FEJA">/);
  assert.doesNotMatch(tete, /<\/script><script>alert/);
  assert.match(seo.balisesTete({ base: BASE, chemin: "/x", titre: "t", description: "d", indexer: false }), /noindex, nofollow/);
});

test("injection : titre remplace, description unique, textes des reglages", () => {
  const page = '<html><head><title>Ancien</title><meta name="description" content="vieille"></head>' +
    '<body><b data-cfg="lieu">Faux</b><span class="v" data-cfg="eventName">X</span><i data-cfg="inconnu">garde</i></body></html>';
  const tete = seo.balisesTete({ base: BASE, chemin: "/", titre: "Nouveau", description: "neuve" });
  let html = seo.injecter(page, { titre: "Nouveau", tete });
  html = seo.remplirTextes(html, { lieu: "Azovè <Bénin>", eventName: "FEJA" });
  assert.match(html, /<title>Nouveau<\/title>/);
  assert.equal((html.match(/name="description"/g) || []).length, 1);
  assert.match(html, /content="neuve"/);
  assert.match(html, /<b data-cfg="lieu">Azovè &lt;Bénin&gt;<\/b>/);
  assert.match(html, /<span class="v" data-cfg="eventName">FEJA<\/span>/);
  assert.match(html, /<i data-cfg="inconnu">garde<\/i>/);
});

test("robots.txt protege les photos et pointe le plan du site", () => {
  const r = seo.robotsTxt(BASE);
  assert.match(r, /Disallow: \/uploads\/participants\//);
  assert.match(r, /Allow: \/api\/public-config/);
  assert.match(r, /Sitemap: https:\/\/feja\.test\/sitemap\.xml/);
  const s = seo.sitemapXml(BASE, [{ chemin: "/", priorite: "1.0" }, { chemin: "/conditions.html" }]);
  assert.match(s, /<loc>https:\/\/feja\.test\/<\/loc>/);
  assert.match(s, /<loc>https:\/\/feja\.test\/conditions\.html<\/loc>/);
});

test("code Google Search Console : balise entiere ou code seul, rien d'autre", () => {
  assert.equal(seo.codeVerificationGoogle('<meta name="google-site-verification" content="AbC_123-xyzXYZ987" />'), "AbC_123-xyzXYZ987");
  assert.equal(seo.codeVerificationGoogle("  AbC_123-xyzXYZ987 "), "AbC_123-xyzXYZ987");
  assert.equal(seo.codeVerificationGoogle('"><script>alert(1)</script>'), "");
  assert.equal(seo.codeVerificationGoogle(""), "");
  const tete = seo.balisesTete({ base: BASE, chemin: "/", titre: "t", description: "d", verificationGoogle: "AbC_123-xyzXYZ987" });
  assert.match(tete, /<meta name="google-site-verification" content="AbC_123-xyzXYZ987">/);
});

test("pages officielles : seulement des adresses https, reliees a l'association", () => {
  const pages = seo.pagesOfficielles("https://www.tiktok.com/@festivaladja\nhttp://exemple.com\njavascript:alert(1)\nhttps://facebook.com/feja");
  assert.deepEqual(pages, ["https://www.tiktok.com/@festivaladja", "https://facebook.com/feja"]);
  const d = seo.donneesAccueil({ base: BASE, textes: TEXTES, lieu: "Terrain CEG2", prix: 1, description: "x", reseaux: pages });
  assert.deepEqual(d.find((x) => x["@type"] === "Organization").sameAs, pages);
  assert.equal(d.find((x) => x["@type"] === "Festival").location.address.streetAddress, "Terrain CEG2");
});
