/* Tests du badge.
 *
 * La mise en page est partagee par le PDF et l'image : on la verifie une fois
 * avec un faux moteur qui retient les appels, puis on controle le PDF reel et,
 * surtout, que le QR reste lisible malgre le sceau pose en son centre.
 *
 * Lancer : npm test
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jsQR = require("jsqr");
const { PNG } = require("pngjs");

const L = require("../js/badge-layout");
const { renderTicketPdf, qrMatrice, textesBadge } = require("../lib/ticket-pdf");

// Faux moteur : largeur approximative (0,6 em par caractere), textes retenus.
function moteurFactice() {
  const textes = [];
  return {
    textes,
    remplir() {}, tracer() {}, sauver() {}, restaurer() {}, decouper() {}, image() {},
    texte(chaine, x, base, police, taille) { textes.push({ chaine, x, base, police, taille }); },
    largeur(chaine, police, taille) { return Array.from(chaine).length * taille * 0.6; },
  };
}

function dessiner(donnees) {
  const m = moteurFactice();
  L.dessinerBadge(m, Object.assign(textesBadge({}), { nom: "Ada Lovelace", numero: 1, qr: qrMatrice("K7MQ2X") }, donnees));
  return m.textes;
}

test("les textes de la maquette sont poses, le nom en capitales", () => {
  const t = dessiner({}).map((x) => x.chaine);
  for (const attendu of ["FESTIVAL ADJA", "2027", "15", "e", "EDITION", "ADA LOVELACE", "N°  000001", "Azovè",
    "CULTURE ADJA - CONCERT - SPORTS - PROMOTION", "EXPOSITION - GASTRONOMIE - ARTS",
    "CONFÉRENCES - CAUSERIES - JEUX CONCOURS - LOISIRS"]) {
    assert.ok(t.includes(attendu), `texte absent : ${attendu}`);
  }
  // Le code d'acces ne s'imprime plus : il ne part que par e-mail.
  assert.ok(!t.some((x) => x.includes("K7MQ2X")), "le code d'acces ne doit pas figurer sur le badge");
});

test("le numero du badge est complete a six chiffres", () => {
  assert.equal(L.numeroBadge(1), "000001");
  assert.equal(L.numeroBadge("42"), "000042");
  assert.equal(L.numeroBadge(1234567), "1234567");
  assert.equal(L.numeroBadge(""), "");
  assert.equal(L.numeroBadge(null), "");
  // Sans numero (badge pas encore valide), rien n'est ecrit apres « N° ».
  assert.ok(!dessiner({ numero: "" }).some((x) => x.chaine.startsWith("N°")));
});

test("les dates alternent regulier et gras selon les **", () => {
  assert.deepEqual(L.morceauxDates("Les **12,13, 14** & **15 Août 2027**"), [
    { texte: "Les ", police: "regular" },
    { texte: "12,13, 14", police: "semibold" },
    { texte: " & ", police: "regular" },
    { texte: "15 Août 2027", police: "semibold" },
  ]);
});

test("1re edition, et un champ vide retombe sur la maquette", () => {
  assert.ok(dessiner({ edition: "1" }).some((x) => x.chaine === "re"));
  const t = textesBadge({ badge_titre: "   ", badge_lieu: "Stade de Klouékanmè" });
  assert.equal(t.titre, L.DEFAUTS.titre);
  assert.equal(t.lieu, "Stade de Klouékanmè");
});

test("un nom trop long passe sur deux lignes sans deborder", () => {
  const nom = "Koffi Mahougnon Rosalie Ablawa Ahouandjinou Dossou-Yovo";
  const lignes = dessiner({ nom }).filter((x) => x.base > 690 && x.base < 745);
  assert.equal(lignes.length, 2);
  const N = L.GEOMETRIE.nom;
  for (const l of lignes) {
    const n = Array.from(l.chaine).length;
    const largeur = n * l.taille * 0.6 + (l.taille * N.esp / N.taille) * (n - 1);
    assert.ok(largeur <= L.GEOMETRIE.nom.max + 1, `ligne trop large : ${l.chaine}`);
  }
});

test("apres le 30 aout, le badge passe a l'annee et l'edition suivantes", () => {
  const base = { annee: "2027", edition: "15", dates: "Les **12,13, 14** & **15 Août 2027**" };
  const a = (iso, bascule) => L.editionEnCours(base, bascule, Date.parse(iso));
  // Aujourd'hui (octobre 2026) : 2027 est bien l'edition a venir.
  assert.equal(a("2026-10-01T12:00:00Z").annee, "2027");
  // 30 aout 2027 a 23 h 59 au Benin (UTC+1) : pas encore.
  assert.equal(a("2027-08-30T22:59:00Z").annee, "2027");
  // 31 aout 2027 a 0 h au Benin : edition suivante, annee changee aussi dans les dates.
  assert.deepEqual(a("2027-08-30T23:00:00Z"), { annee: "2028", edition: "16", dates: "Les **12,13, 14** & **15 Août 2028**" });
  // Serveur reste eteint deux ans : on rattrape d'un coup.
  assert.equal(a("2029-09-15T10:00:00Z").edition, "18");
  // Date de bascule personnalisee.
  assert.equal(a("2027-09-10T10:00:00Z", "15/09").annee, "2027");
  assert.equal(a("2027-09-16T10:00:00Z", "15/09").annee, "2028");
  // Une annee saisie en avance n'est jamais reculee.
  assert.equal(L.editionEnCours({ annee: "2030", edition: "18", dates: "" }, "30/08", Date.parse("2027-09-01")).annee, "2030");
});

test("au plus quatre lignes d'activites", () => {
  const t = dessiner({ activites: "A\nB\nC\nD\nE\nF" }).filter((x) => /^[A-F]$/.test(x.chaine));
  assert.deepEqual(t.map((x) => x.chaine), ["A", "B", "C", "D"]);
});

test("le PDF est un 4 x 6 pouces, polices Poppins integrees", async () => {
  const pdf = await renderTicketPdf({ nom: "Ada Lovelace", code_unique: "K7MQ2X" }, { event_name: "FEJA" });
  const brut = pdf.toString("latin1");
  assert.equal(brut.slice(0, 5), "%PDF-");
  assert.match(brut, /\/MediaBox \[0 0 288\.225 432\]/);
  assert.match(brut, /Poppins-SemiBold/);
  assert.match(brut, /Poppins-Bold/);
  assert.equal((brut.match(/\/Type \/Page\b/g) || []).length, 1, "une seule page");
});

test("plusieurs badges d'un achat tiennent dans un seul PDF, une page chacun", async () => {
  const pdf = await renderTicketPdf([
    { nom: "Awa Dossou", code_unique: "K7MQ2X" },
    { nom: "Koffi Ahouandjinou", code_unique: "Z85Y72" },
    { nom: "Sènami Houngbo", code_unique: "B75D7K" },
  ], {});
  const brut = pdf.toString("latin1");
  assert.equal((brut.match(/\/Type \/Page\b/g) || []).length, 3);
  // Polices integrees une seule fois pour tout le fichier.
  assert.equal((brut.match(/\/FontName \/[A-Z]{6}\+Poppins-Bold/g) || []).length, 1);
});

test("le QR (version 5, correction H) reste lisible avec le sceau au centre", () => {
  const Q = L.QR, G = L.GEOMETRIE;
  const sceauPath = path.join(__dirname, "..", "uploads", "branding", "logo-badge.png");
  const sceau = fs.existsSync(sceauPath) ? PNG.sync.read(fs.readFileSync(sceauPath)) : null;
  const tS = G.sceau.r / G.sceau.fraction;

  // Rasterise la zone du QR telle que le badge la dessine, a 120 px de cote
  // (un badge affiche petit sur un telephone), avec 3 x 3 echantillons par pixel.
  function zone(code) {
    const m = qrMatrice(code), t = Q.cote / m.n, marge = 20;
    const x0 = Q.x - marge, y0 = Q.y - marge, cote = Q.cote + 2 * marge, W = 140, ss = 3;
    const data = new Uint8ClampedArray(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (let a = 0; a < ss; a++) for (let b = 0; b < ss; b++) {
        const ux = x0 + ((x + (b + 0.5) / ss) / W) * cote, uy = y0 + ((y + (a + 0.5) / ss) / W) * cote;
        let c = [255, 255, 255];
        const i = Math.floor((ux - Q.x) / t), j = Math.floor((uy - Q.y) / t);
        if (i >= 0 && j >= 0 && i < m.n && j < m.n && m.bits[j * m.n + i] === "1") c = [0, 0x66, 0];
        const d = Math.hypot(ux - Q.cx, uy - Q.cy);
        if (d <= G.degagement) c = [255, 255, 255];
        if (d <= G.sceau.r) {
          if (sceau) {
            const sx = Math.min(sceau.width - 1, Math.max(0, Math.floor(((ux - Q.cx + tS / 2) / tS) * sceau.width)));
            const sy = Math.min(sceau.height - 1, Math.max(0, Math.floor(((uy - Q.cy + tS / 2) / tS) * sceau.height)));
            const k = (sy * sceau.width + sx) * 4, al = sceau.data[k + 3] / 255;
            c = c.map((v, n) => v * (1 - al) + sceau.data[k + n] * al);
          } else {
            c = [0x33, 0xcc, 0]; // pire cas : un disque plein a la place du logo
          }
        }
        for (let n = 0; n < 3; n++) acc[n] += c[n];
      }
      const o = (y * W + x) * 4;
      for (let n = 0; n < 3; n++) data[o + n] = acc[n] / (ss * ss);
      data[o + 3] = 255;
    }
    return { data, W };
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let graine = 7;
  const hasard = () => ((graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let essai = 0; essai < 25; essai++) {
    const code = Array.from({ length: 6 }, () => alphabet[Math.floor(hasard() * alphabet.length)]).join("");
    const { data, W } = zone(code);
    const lu = jsQR(data, W, W);
    assert.ok(lu && lu.data === code, `QR illisible pour ${code}`);
  }
});
