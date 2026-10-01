/* Mise en page du badge, partagee par le PDF (serveur, pdfkit) et l'image
 * (navigateur, canvas).
 *
 * Les deux rendus appellent la MEME fonction dessinerBadge avec un « moteur »
 * different. Toute cote, couleur ou taille de police vit ici et nulle part
 * ailleurs : c'est ce qui garantit que le PDF recu par e-mail et l'image
 * telechargee sur la page de retour ne peuvent pas diverger.
 *
 * Repere : celui de la maquette fournie par l'organisation, 854 x 1280 px.
 * Chaque cote a ete relevee sur cette maquette au demi-pixel pres (bord pris
 * au passage a 50 % de couverture) : ne pas « arrondir » ces valeurs, elles
 * sont la reference.
 *
 * Interface attendue du moteur :
 *   remplir(ops, couleur)            ops = [['M',x,y], ['L',x,y], ['A',cx,cy,r,a0,a1,antihoraire], ['Z']]
 *   tracer(ops, epaisseur, couleur)
 *   sauver() / restaurer() / decouper(ops)
 *   image(img, x, y, l, h)
 *   texte(chaine, x, ligneDeBase, police, taille, couleur, espacement, echelleX)
 *   largeur(chaine, police, taille)   avance sans espacement, crenage compris
 * police vaut 'regular' ou 'bold' (Poppins).
 */
(function (racine, fabrique) {
  if (typeof module === "object" && module.exports) module.exports = fabrique();
  else racine.BadgeLayout = fabrique();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LARGEUR = 854;
  const HAUTEUR = 1280;

  const COULEURS = {
    blanc: "#FFFFFF",
    vertFonce: "#006600",
    vertVif: "#33CC00",
    vertClair: "#4BB93C",
    rouge: "#FB0000",
    jaune: "#F7ED04",
    vertRayure: "#017901",
    gris: "#333333",
    texteBas: "#011E00",
    // Teintes des anneaux du fond la ou ils sont le plus marques (coin bas
    // droit) ; ailleurs elles s'effacent vers le blanc.
    anneauVert: "#CAEEC0",
    anneauGris: "#BDD6BC",
    photoVide: "#E6F2E3",
    silhouette: "#B7D5B0",
  };

  // Textes de la maquette. Le serveur les reprend comme valeurs par defaut des
  // reglages, le navigateur s'en sert si la configuration n'est pas arrivee.
  const DEFAUTS = {
    titre: "FESTIVAL ADJA",
    annee: "2027",
    edition: "15",
    lieu: "Azovè",
    dates: "Les **12,13, 14** & **15 Août 2027**",
    activites: [
      "CULTURE ADJA - CONCERT - SPORTS - PROMOTION",
      "EXPOSITION - GASTRONOMIE - ARTS",
      "CONFÉRENCES - CAUSERIES - JEUX CONCOURS - LOISIRS",
    ].join("\n"),
  };

  // Zone du QR. La version est imposee (5, soit 37 x 37 modules) avec la
  // correction d'erreur la plus forte : le sceau pose au centre masque une
  // partie des modules, et un QR illisible bloque quelqu'un a l'entree.
  const QR = { x: 370.3, y: 880.85, cote: 225.6, version: 5, correction: "H" };
  QR.cx = QR.x + QR.cote / 2;
  QR.cy = QR.y + QR.cote / 2;

  const G = {
    bande: { l: 163.16 },
    rayures: [
      { x: 75.9, l: 4.95, morceaux: [[199.67, 307.2, "rouge"], [307.2, 401.96, "jaune"], [401.96, 502.86, "vertRayure"]] },
      { x: 73.37, l: 4.93, morceaux: [[775.62, 883.05, "rouge"], [883.05, 977.78, "jaune"], [977.78, 1078.2, "vertRayure"]] },
    ],
    // Disque blanc du logo de gauche, son anneau fin, puis l'embleme (mains +
    // FEJA, img/badge/logo-simple.png, detoure sans les anneaux du fichier
    // d'origine) a la taille et a la place qu'il occupe sur la maquette.
    logo: {
      cx: 80.8, cy: 647.2, r: 59.5,
      anneau: { r: 52.5, trait: 1.6 },
      embleme: { cx: 82.0, cy: 646.5, l: 57.86, h: 70.26 },
    },
    // Graisses relevees par l'aire d'encre de chaque texte : le nom, l'annee,
    // l'exposant et les dates en gras sont en SemiBold, pas en Bold.
    titre: { taille: 64.9, esp: -0.35, base: 91.11, centre: 491.66, max: 600 },
    annee: { taille: 24.0, esp: 0, base: 91.34, ecart: 3.07, police: "semibold" },
    deco: {
      y: 115.43, h: 6.84,
      fonce: [[386.87, 487.0]],
      vif: [[493.6, 543.0], [549.6, 558.6], [565.05, 569.55], [576.3, 580.8], [587.3, 595.25]],
    },
    edition: {
      nombre: { taille: 37.8, esp: 0, base: 160.32 },
      // L'exposant de la maquette est plus etroit que le « e » de Poppins a
      // la meme hauteur : il est comprime horizontalement (echelleX).
      exposant: { taille: 26.9, base: 147.91, ecartAvant: 0, ecartApres: 7.65, police: "semibold", echelleX: 0.84 },
      mot: { texte: "EDITION", taille: 38.48, esp: -0.4, base: 160.55 },
      centre: 492.34,
    },
    photo: { x: 226.97, y: 200.48, l: 529.88, h: 478.88, r: 59.5, bord: 4, biais: 0.3 },
    drapeaux: [
      { x: 745.4, y: 255.17, h: 30.62, couleur: "vertFonce" },
      { x: 745.4, y: 293.01, h: 30.92, couleur: "vertClair" },
    ],
    nom: { taille: 45.9, esp: -3.15, base: 739.33, centre: 491.45, max: 600, min: 30, police: "semibold",
      // Nom trop long pour une ligne : deux lignes plus petites.
      deuxLignes: { taille: 32, min: 22, bases: [708.5, 739.5] } },
    numero: { taille: 34.6, esp: -0.18, base: 779.17, centre: 488.2, max: 420 },
    barre: { x: 228.88, y: 799.26, l: 528.15, h: 49.88 },
    lieu: {
      baseLieu: 831.58, baseDates: 831.0, taille: 22.4, centre: 497.1, marge: 14,
      epingle: { r: 14.9, cy: 824.0 },
      calendrier: { r: 14.9, cy: 822.9 },
      ecartIconeTexte: 10.45, ecartTexteIcone: 18.62, ecartIconeDates: 10.48,
    },
    boiteQR: { x: 340.04, y: 860.67, l: 290.35, h: 262.36, r: 40.6, bord: 1.6 },
    degagement: 38.3,
    sceau: { r: 32.25, fraction: 0.4968 },
    bandeau: { x: 204.19, y: 1139.03, l: 573.78, h: 104.69 },
    activites: { taille: 20.2, esp: -0.76, centre: 492.45, milieu: 1197.62, pas: 23.01, max: 556, maxLignes: 4 },
    motif: {
      y0: 899, pasY: 17.17, xPair: 731.75, xImpair: 685, pasX: 93.4, r: 26.5, trait: 5.0,
      // Pleine intensite pres du coin bas droit, puis effacement progressif
      // ((nul - d) / (nul - plein)) ^ courbe, releve par tranches de distance.
      fondu: { cx: 854, cy: 1280, plein: 150, nul: 870, courbe: 1.2 },
      segments: 6,
    },
  };

  // --- Chemins ------------------------------------------------------------

  function rectangle(x, y, l, h) {
    return [["M", x, y], ["L", x + l, y], ["L", x + l, y + h], ["L", x, y + h], ["Z"]];
  }

  function rectArrondi(x, y, l, h, r) {
    const p = Math.PI;
    return [
      ["M", x + r, y],
      ["L", x + l - r, y], ["A", x + l - r, y + r, r, -p / 2, 0, false],
      ["L", x + l, y + h - r], ["A", x + l - r, y + h - r, r, 0, p / 2, false],
      ["L", x + r, y + h], ["A", x + r, y + h - r, r, p / 2, p, false],
      ["L", x, y + r], ["A", x + r, y + r, r, p, 1.5 * p, false],
      ["Z"],
    ];
  }

  function cercle(cx, cy, r) {
    return [["M", cx + r, cy], ["A", cx, cy, r, 0, 2 * Math.PI, false], ["Z"]];
  }

  // --- Couleurs -----------------------------------------------------------

  function hexVersRvb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rvbVersHex(c) {
    return "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  function melange(a, b, t) {
    const x = hexVersRvb(a), y = hexVersRvb(b);
    return rvbVersHex(x.map((v, i) => v + (y[i] - v) * t));
  }

  // --- Textes -------------------------------------------------------------

  // Espaces speciales (insecables, fines) ramenees a l'espace simple : la
  // police n'a pas forcement leur glyphe, et un carre vide sur un badge se voit.
  function propre(valeur) {
    return String(valeur == null ? "" : valeur)
      .normalize("NFC")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/[    ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function nbCaracteres(s) {
    return Array.from(s).length;
  }

  function largeurTexte(m, s, police, taille, esp) {
    if (!s) return 0;
    return m.largeur(s, police, taille) + (esp || 0) * (nbCaracteres(s) - 1);
  }

  // Reduit taille et espacement ensemble jusqu'a tenir dans `max`.
  function ajuster(m, s, police, taille, esp, max, min) {
    const l = largeurTexte(m, s, police, taille, esp);
    if (l <= max) return { taille, esp, largeur: l };
    const k = Math.max(min / taille, max / l);
    const t = taille * k, e = esp * k;
    return { taille: t, esp: e, largeur: largeurTexte(m, s, police, t, e) };
  }

  // "Les **12** & **15 Août**" -> morceaux alternant regulier / gras.
  function morceauxDates(texte) {
    const brut = String(texte == null ? "" : texte);
    const out = [];
    brut.split("**").forEach((bout, i) => {
      const t = bout.normalize("NFC").replace(/[    ]/g, " ").replace(/\s+/g, " ");
      if (t) out.push({ texte: t, police: i % 2 ? "semibold" : "regular" });
    });
    if (out.length) {
      out[0].texte = out[0].texte.replace(/^\s+/, "");
      out[out.length - 1].texte = out[out.length - 1].texte.replace(/\s+$/, "");
    }
    return out.filter((o) => o.texte);
  }

  function lignesActivites(texte) {
    return String(texte == null ? "" : texte)
      .split(/\r?\n/)
      .map(propre)
      .filter(Boolean)
      .slice(0, G.activites.maxLignes);
  }

  // --- Passage a l'edition suivante ----------------------------------------
  // Le festival a lieu chaque annee en aout. Passe le jour de bascule (le
  // 30/08 par defaut), le badge annonce l'edition suivante : annee + 1,
  // edition + 1, et l'annee remplacee dans le texte des dates. Le calcul se
  // fait a l'heure du Benin (UTC+1, sans heure d'ete).
  const BASCULE_DEFAUT = "30/08";

  function lireBascule(texte) {
    const m = String(texte == null ? "" : texte).trim().match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})$/);
    const jour = m ? Number(m[1]) : 30, mois = m ? Number(m[2]) : 8;
    return jour >= 1 && jour <= 31 && mois >= 1 && mois <= 12 ? { jour, mois } : { jour: 30, mois: 8 };
  }

  function anneeDuFestival(bascule, maintenant) {
    const d = new Date((maintenant == null ? Date.now() : maintenant) + 3600 * 1000);
    const annee = d.getUTCFullYear(), mois = d.getUTCMonth() + 1, jour = d.getUTCDate();
    const b = lireBascule(bascule);
    return mois > b.mois || (mois === b.mois && jour > b.jour) ? annee + 1 : annee;
  }

  // Textes du badge avances jusqu'a l'edition en cours. Sans effet si
  // l'annee saisie est deja la bonne (ou en avance).
  function editionEnCours(textes, bascule, maintenant) {
    const annee = parseInt(String(textes.annee || "").trim(), 10);
    if (!Number.isFinite(annee)) return textes;
    const ecart = anneeDuFestival(bascule, maintenant) - annee;
    if (ecart <= 0) return textes;
    const edition = String(textes.edition || "").trim();
    return Object.assign({}, textes, {
      annee: String(annee + ecart),
      edition: /^\d+$/.test(edition) ? String(Number(edition) + ecart) : textes.edition,
      dates: String(textes.dates || "").replace(new RegExp("\\b" + annee + "\\b", "g"), String(annee + ecart)),
    });
  }

  // Textes du badge depuis les reglages du serveur (cles badge_*). Un champ
  // vide retombe sur la maquette ; l'annee et l'edition suivent la bascule.
  // Sert au PDF et aux e-mails, pour qu'ils annoncent la meme edition.
  function textesDepuisReglages(settings, maintenant) {
    const s = settings || {};
    const val = (cle, defaut) => (s[cle] != null && String(s[cle]).trim() ? String(s[cle]) : defaut);
    return editionEnCours({
      titre: val("badge_titre", DEFAUTS.titre),
      annee: val("badge_annee", DEFAUTS.annee),
      edition: val("badge_edition", DEFAUTS.edition),
      lieu: val("badge_lieu", DEFAUTS.lieu),
      dates: val("badge_dates", DEFAUTS.dates),
      activites: val("badge_activites", DEFAUTS.activites),
    }, s.badge_bascule, maintenant);
  }

  function exposantEdition(edition) {
    return edition === "1" ? "re" : "e";
  }

  // Coupe un nom en deux lignes au blanc le plus proche du milieu.
  function couperEnDeux(nom) {
    const mots = nom.split(" ");
    if (mots.length < 2) return null;
    let meilleur = null;
    for (let i = 1; i < mots.length; i++) {
      const a = mots.slice(0, i).join(" "), b = mots.slice(i).join(" ");
      const ecart = Math.abs(a.length - b.length);
      if (!meilleur || ecart < meilleur.ecart) meilleur = { a, b, ecart };
    }
    return [meilleur.a, meilleur.b];
  }

  // --- Dessin -------------------------------------------------------------

  function dessinerMotif(m) {
    const M = G.motif, f = M.fondu;
    const groupes = new Map();
    const alpha = (x, y) => {
      const d = Math.hypot(x - f.cx, y - f.cy);
      return Math.pow(Math.max(0, Math.min(1, (f.nul - d) / (f.nul - f.plein))), f.courbe);
    };
    for (let j = -24; j <= 24; j++) {
      const cy = M.y0 + M.pasY * j;
      if (cy < -M.r || cy > HAUTEUR + M.r) continue;
      const pair = ((j % 2) + 2) % 2 === 0;
      const ton = ((j % 4) + 4) % 4 < 2 ? COULEURS.anneauVert : COULEURS.anneauGris;
      const x0 = pair ? M.xPair : M.xImpair;
      for (let i = -8; i <= 2; i++) {
        const cx = x0 + M.pasX * i;
        if (cx + M.r < G.bande.l || cx - M.r > LARGEUR) continue;
        if (Math.hypot(cx - f.cx, cy - f.cy) - M.r >= f.nul) continue;
        const n = M.segments;
        for (let s = 0; s < n; s++) {
          const a0 = (2 * Math.PI * s) / n, a1 = (2 * Math.PI * (s + 1)) / n, am = (a0 + a1) / 2;
          const a = alpha(cx + M.r * Math.cos(am), cy + M.r * Math.sin(am));
          if (a <= 0) continue;
          const couleur = melange(COULEURS.blanc, ton, Math.round(a * 40) / 40);
          if (!groupes.has(couleur)) groupes.set(couleur, []);
          groupes.get(couleur).push(["M", cx + M.r * Math.cos(a0), cy + M.r * Math.sin(a0)], ["A", cx, cy, M.r, a0, a1, false]);
        }
      }
    }
    for (const [couleur, ops] of groupes) m.tracer(ops, M.trait, couleur);
  }

  function dessinerEpingle(m, cx, cy) {
    m.remplir(cercle(cx, cy, G.lieu.epingle.r), COULEURS.blanc);
    // Tete ronde prolongee jusqu'a la pointe par les deux tangentes.
    const tx = cx, ty = cy - 2.0, r = 6.7, pointe = ty + 13;
    const ouverture = Math.acos(r / (pointe - ty));
    const aD = Math.PI / 2 - ouverture, aG = Math.PI / 2 + ouverture;
    m.remplir([
      ["M", tx, pointe],
      ["L", tx + r * Math.cos(aD), ty + r * Math.sin(aD)],
      ["A", tx, ty, r, aD, aG, true],
      ["Z"],
    ], COULEURS.vertVif);
    m.remplir(cercle(tx, ty, 3.1), COULEURS.blanc);
  }

  function dessinerCalendrier(m, cx, cy) {
    m.remplir(cercle(cx, cy, G.lieu.calendrier.r), COULEURS.blanc);
    const v = COULEURS.vertVif, dx = cx - 408.62, dy = cy - 822.9;
    const P = (x, y) => [x + dx, y + dy];
    // Reliure, ses trois anneaux, la feuille penchee et la page du dessous.
    m.remplir(rectangle(...P(400.5, 815.2), 17, 2.6), v);
    [404.2, 408.2, 412.2].forEach((x) => m.remplir(rectangle(...P(x, 813.7), 1.3, 1.8), v));
    m.remplir([["M", ...P(401.6, 818.7)], ["L", ...P(417.6, 818.7)], ["L", ...P(413.6, 827.6)], ["L", ...P(397.6, 827.6)], ["Z"]], v);
    m.remplir(rectangle(...P(401.8, 829.3), 15.4, 1.6), v);
    m.remplir(rectangle(...P(414.6, 826.4), 2.6, 4.5), v);
  }

  function dessinerBadge(m, d) {
    const C = COULEURS;

    m.remplir(rectangle(0, 0, LARGEUR, HAUTEUR), C.blanc);
    dessinerMotif(m);

    // Bande verte de gauche, rayures aux couleurs du drapeau, logo.
    m.remplir(rectangle(0, 0, G.bande.l, HAUTEUR), C.vertFonce);
    G.rayures.forEach((r) => r.morceaux.forEach(([y0, y1, c]) => m.remplir(rectangle(r.x, y0, r.l, y1 - y0), C[c])));
    const Lo = G.logo, Em = Lo.embleme;
    m.remplir(cercle(Lo.cx, Lo.cy, Lo.r), C.blanc);
    m.tracer(cercle(Lo.cx, Lo.cy, Lo.anneau.r), Lo.anneau.trait, C.vertFonce);
    if (d.logoGauche) m.image(d.logoGauche.img, Em.cx - Em.l / 2, Em.cy - Em.h / 2, Em.l, Em.h);

    // Titre et annee, centres ensemble.
    const titre = propre(d.titre).toLocaleUpperCase("fr-FR");
    const annee = propre(d.annee);
    if (titre) {
      const T = G.titre, A = G.annee;
      const lt = largeurTexte(m, titre, "bold", T.taille, T.esp);
      const la = annee ? largeurTexte(m, annee, A.police, A.taille, A.esp) : 0;
      const total = lt + (annee ? A.ecart + la : 0);
      const k = Math.min(1, T.max / total);
      const x = T.centre - (total * k) / 2;
      m.texte(titre, x, T.base, "bold", T.taille * k, C.vertFonce, T.esp * k);
      if (annee) m.texte(annee, x + (lt + A.ecart) * k, A.base, A.police, A.taille * k, C.vertFonce, A.esp * k);
    }

    G.deco.fonce.forEach(([a, b]) => m.remplir(rectangle(a, G.deco.y, b - a, G.deco.h), C.vertFonce));
    G.deco.vif.forEach(([a, b]) => m.remplir(rectangle(a, G.deco.y, b - a, G.deco.h), C.vertVif));

    // « 15e EDITION » : nombre, exposant, mot.
    const edition = propre(d.edition);
    if (edition) {
      const E = G.edition, numerique = /^\d+$/.test(edition);
      const exp = numerique ? exposantEdition(edition) : "";
      const ln = largeurTexte(m, edition, "bold", E.nombre.taille, E.nombre.esp);
      const le = exp ? largeurTexte(m, exp, E.exposant.police, E.exposant.taille, 0) * E.exposant.echelleX : 0;
      const lm = largeurTexte(m, E.mot.texte, "bold", E.mot.taille, E.mot.esp);
      const total = ln + (exp ? E.exposant.ecartAvant + le + E.exposant.ecartApres : E.exposant.ecartApres * 2) + lm;
      let x = E.centre - total / 2;
      m.texte(edition, x, E.nombre.base, "bold", E.nombre.taille, C.vertFonce, E.nombre.esp);
      x += ln;
      if (exp) {
        x += E.exposant.ecartAvant;
        m.texte(exp, x, E.exposant.base, E.exposant.police, E.exposant.taille, C.vertFonce, 0, E.exposant.echelleX);
        x += le + E.exposant.ecartApres;
      } else {
        x += E.exposant.ecartApres * 2;
      }
      m.texte(E.mot.texte, x, E.mot.base, "bold", E.mot.taille, C.vertFonce, E.mot.esp);
    }

    // Photo dans son cadre arrondi.
    const P = G.photo;
    m.remplir(rectArrondi(P.x, P.y, P.l, P.h, P.r), C.vertFonce);
    const ix = P.x + P.bord, iy = P.y + P.bord, il = P.l - 2 * P.bord, ih = P.h - 2 * P.bord, ir = P.r - P.bord;
    m.sauver();
    m.decouper(rectArrondi(ix, iy, il, ih, ir));
    if (d.photo && d.photo.largeur > 0 && d.photo.hauteur > 0) {
      // Remplissage sans deformation. Le cadrage remonte (biais 0,3) : sur un
      // portrait, le visage est dans le tiers haut, et centre il etait coupe.
      const k = Math.max(il / d.photo.largeur, ih / d.photo.hauteur);
      const l = d.photo.largeur * k, h = d.photo.hauteur * k;
      m.image(d.photo.img, ix + (il - l) / 2, iy + (ih - h) * P.biais, l, h);
    } else {
      m.remplir(rectangle(ix, iy, il, ih), C.photoVide);
      m.remplir(cercle(ix + il / 2, iy + ih * 0.4, 82), C.silhouette);
      m.remplir(cercle(ix + il / 2, iy + ih + 95, 190), C.silhouette);
    }
    m.restaurer();

    G.drapeaux.forEach((f) => m.remplir(rectangle(f.x, f.y, LARGEUR - f.x, f.h), C[f.couleur]));

    // Nom du participant, en capitales.
    const nom = propre(d.nom).toLocaleUpperCase("fr-FR");
    if (nom) {
      const N = G.nom, P = N.police;
      const une = ajuster(m, nom, P, N.taille, N.esp, N.max, N.min);
      const deux = couperEnDeux(nom);
      if (une.largeur <= N.max || !deux) {
        const a = une.largeur <= N.max ? une : ajuster(m, nom, P, N.taille, N.esp, N.max, 8);
        m.texte(nom, N.centre - a.largeur / 2, N.base, P, a.taille, C.vertFonce, a.esp);
      } else {
        const D = N.deuxLignes, kEsp = N.esp / N.taille;
        const t = deux.reduce((tt, ligne) => Math.min(tt, ajuster(m, ligne, P, D.taille, D.taille * kEsp, N.max, D.min).taille), D.taille);
        deux.forEach((ligne, i) => {
          const a = ajuster(m, ligne, P, t, t * kEsp, N.max, 6);
          m.texte(ligne, N.centre - a.largeur / 2, D.bases[i], P, a.taille, C.vertFonce, a.esp);
        });
      }
    }

    // « N°  CODE »
    const code = propre(d.code);
    if (code) {
      const U = G.numero, s = "N°  " + code;
      const a = ajuster(m, s, "regular", U.taille, U.esp, U.max, 18);
      m.texte(s, U.centre - a.largeur / 2, U.base, "regular", a.taille, C.gris, a.esp);
    }

    // Barre lieu / dates.
    const B = G.barre, Li = G.lieu;
    m.remplir(rectangle(B.x, B.y, B.l, B.h), C.vertFonce);
    const lieu = propre(d.lieu);
    const dates = morceauxDates(d.dates);
    const largeurs = (t) => ({
      lieu: lieu ? largeurTexte(m, lieu, "regular", t, 0) : 0,
      dates: dates.reduce((s, o) => s + largeurTexte(m, o.texte, o.police, t, 0), 0),
    });
    const icones = 2 * Li.epingle.r + Li.ecartIconeTexte + Li.ecartTexteIcone + 2 * Li.calendrier.r + Li.ecartIconeDates;
    let tl = Li.taille, w = largeurs(tl);
    const dispo = B.l - 2 * Li.marge - icones;
    if (w.lieu + w.dates > dispo) {
      tl = Math.max(12, tl * dispo / (w.lieu + w.dates));
      w = largeurs(tl);
    }
    const total = icones + w.lieu + w.dates;
    const centre = Math.min(Math.max(Li.centre, B.x + Li.marge + total / 2), B.x + B.l - Li.marge - total / 2);
    let x = centre - total / 2;
    dessinerEpingle(m, x + Li.epingle.r, Li.epingle.cy);
    x += 2 * Li.epingle.r + Li.ecartIconeTexte;
    if (lieu) m.texte(lieu, x, Li.baseLieu, "regular", tl, C.blanc, 0);
    x += w.lieu + Li.ecartTexteIcone;
    dessinerCalendrier(m, x + Li.calendrier.r, Li.calendrier.cy);
    x += 2 * Li.calendrier.r + Li.ecartIconeDates;
    dates.forEach((o) => {
      m.texte(o.texte, x, Li.baseDates, o.police, tl, C.blanc, 0);
      x += largeurTexte(m, o.texte, o.police, tl, 0);
    });

    // Boite du QR, QR, sceau.
    const Q = G.boiteQR;
    m.remplir(rectArrondi(Q.x, Q.y, Q.l, Q.h, Q.r), C.vertFonce);
    m.remplir(rectArrondi(Q.x + Q.bord, Q.y + Q.bord, Q.l - 2 * Q.bord, Q.h - 2 * Q.bord, Q.r - Q.bord), C.blanc);
    if (d.qr && d.qr.n) {
      const n = d.qr.n, t = QR.cote / n, ops = [];
      // Une seule forme pour tous les modules, par plages horizontales : des
      // carres poses un a un laissent des filets clairs entre voisins.
      for (let j = 0; j < n; j++) {
        let i = 0;
        while (i < n) {
          if (d.qr.bits[j * n + i] !== "1") { i++; continue; }
          let k = i;
          while (k < n && d.qr.bits[j * n + k] === "1") k++;
          ops.push(...rectangle(QR.x + i * t, QR.y + j * t, (k - i) * t, t));
          i = k;
        }
      }
      m.remplir(ops, C.vertFonce);
    }
    m.remplir(cercle(QR.cx, QR.cy, G.degagement), C.blanc);
    if (d.sceau) {
      const S = G.sceau, t = S.r / S.fraction;
      m.sauver();
      m.decouper(cercle(QR.cx, QR.cy, S.r + 0.3));
      m.image(d.sceau.img, QR.cx - t / 2, QR.cy - t / 2, t, t);
      m.restaurer();
    }

    // Bandeau des activites.
    const Ba = G.bandeau, Ac = G.activites;
    m.remplir(rectangle(Ba.x, Ba.y, Ba.l, Ba.h), C.vertVif);
    const lignes = lignesActivites(d.activites);
    lignes.forEach((ligne, i) => {
      const a = ajuster(m, ligne, "bold", Ac.taille, Ac.esp, Ac.max, 11);
      const base = Ac.milieu + (i - (lignes.length - 1) / 2) * Ac.pas;
      m.texte(ligne, Ac.centre - a.largeur / 2, base, "bold", a.taille, C.texteBas, a.esp);
    });
  }

  return {
    LARGEUR, HAUTEUR, COULEURS, DEFAUTS, QR, GEOMETRIE: G, BASCULE_DEFAUT,
    dessinerBadge, morceauxDates, lignesActivites, propre, editionEnCours, anneeDuFestival, lireBascule,
    textesDepuisReglages, exposantEdition,
  };
});
