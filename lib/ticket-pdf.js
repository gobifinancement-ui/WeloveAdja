/* Construction du badge PDF, isolee du reste du serveur.
 *
 * Module volontairement pur : aucune dependance a la base de donnees ni a
 * l'etat du serveur (settings arrive en parametre, jamais lu depuis un cache
 * partage). C'est ce qui permet de l'executer aussi bien depuis server.js
 * (rapport PDF, qui a besoin du logo) que depuis un worker_thread separe
 * (voir ticket-pdf-worker.js) : un worker_thread tourne dans son propre
 * isolat V8 et ne peut pas partager les objets du fichier principal, juste
 * des donnees serialisables.
 *
 * La generation d'un badge est posee dans un thread a part parce qu'elle est
 * synchrone et bloquerait sinon la boucle d'evenements de Node pendant son
 * execution : sur un achat de groupe, tout le site resterait fige pour tous
 * les autres visiteurs le temps de dessiner chaque badge.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { PNG } = require("pngjs");

const ROOT = path.join(__dirname, "..");
const BRANDING_DIR = path.join(ROOT, "uploads", "branding");
const TIMEZONE = "Africa/Porto-Novo";

// Au-dela, le logo n'est pas embarque dans le badge : voir getTicketImagePath.
const MAX_TICKET_LOGO_BYTES = 400 * 1024;
const TICKET_WIDTH = 600;   // points PDF, soit un rapport 3:2 comme la maquette
const TICKET_HEIGHT = 400;

// Tailles visees pour les images du badge. Chacune est largement suffisante
// pour un rendu net a 300 points par pouce a la taille ou elle est affichee.
const TICKET_IMAGE_SIZES = {
  logo: 200,
  wordmark: 520,
  bg: 1000,
};

// Palette du badge, VOLONTAIREMENT fixe et non liee au theme du site. Le
// site change de couleur chaque jour ; un badge, lui, doit rester
// reconnaissable et s'accorder au logo, qui est vert.
const TICKET_COLORS = {
  clair: "#f4f7f2",
  vert: "#2fa84f",
  vertFonce: "#12662c",
  sombre: "#0c2b17",
  blanc: "#ffffff",
  creme: "#dceadf",
};

// toLocaleString("fr-FR") separe les milliers par une espace insecable ETROITE
// (U+202F). Les polices standard du PDF sont encodees en WinAnsi, qui ne la
// connait pas : "50 000" s'imprimait "50 /000". On repasse donc tout texte
// destine au PDF par ce filtre.
function texteP(valeur) {
  return String(valeur == null ? "" : valeur)
    .replace(/[    ]/g, " ");
}

function anneeBenin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric" })
    .format(new Date());
}

// Chemin sur disque d'une image servie par une URL du site, ou null.
function localFileFromUrl(url) {
  const clean = String(url || "").split("?")[0].replace(/^\/+/, "");
  if (!clean) return null;
  const filePath = path.join(ROOT, clean);
  // Ne jamais sortir de uploads/ : cette fonction recoit une valeur de reglage.
  if (!filePath.startsWith(path.join(ROOT, "uploads"))) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

// Reechantillonnage par moyenne de bloc. Le voisin le plus proche donnerait
// des bords en escalier tres visibles sur un logo circulaire.
function downscalePng(source, cible) {
  const ratio = Math.min(cible / source.width, cible / source.height, 1);
  const w = Math.max(1, Math.round(source.width * ratio));
  const h = Math.max(1, Math.round(source.height * ratio));
  const sortie = new PNG({ width: w, height: h });

  const blocX = source.width / w;
  const blocY = source.height / h;

  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * blocY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * blocY));

    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * blocX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * blocX));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < source.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < source.width; sx += 1) {
          const i = (source.width * sy + sx) << 2;
          const alpha = source.data[i + 3];
          // Moyenne ponderee par l'alpha : sans cela, les pixels totalement
          // transparents (souvent noirs) assombriraient les bords du logo.
          r += source.data[i] * alpha;
          g += source.data[i + 1] * alpha;
          b += source.data[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }

      const j = (w * y + x) << 2;
      if (a > 0) {
        sortie.data[j] = Math.round(r / a);
        sortie.data[j + 1] = Math.round(g / a);
        sortie.data[j + 2] = Math.round(b / a);
      }
      sortie.data[j + 3] = Math.round(a / Math.max(1, n));
    }
  }

  return sortie;
}

// Renvoie le chemin d'une image de marque reduite pour le badge, ou null.
// `nom` sert a nommer le fichier de cache et a choisir la taille visee.
function getTicketImagePath(settings, cleReglage, nom) {
  const source = localFileFromUrl(settings[cleReglage]);
  if (!source) return null;

  // Le SVG n'est pas embarquable par pdfkit.
  if (!/\.(png|jpe?g)$/i.test(source)) return null;

  const taille = TICKET_IMAGE_SIZES[nom] || 400;
  const cache = path.join(BRANDING_DIR, `${nom}-ticket.png`);

  // Un JPEG est deja compresse : pdfkit le reprend tel quel. On ne le reduit
  // pas, mais on refuse ceux qui alourdiraient trop le badge.
  if (/\.jpe?g$/i.test(source)) {
    try { return fs.statSync(source).size <= MAX_TICKET_LOGO_BYTES ? source : null; } catch { return null; }
  }

  try {
    const infoSource = fs.statSync(source);
    // Cache encore valable : on ne refait pas le calcul a chaque badge.
    if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= infoSource.mtimeMs) {
      return cache;
    }

    const reduit = downscalePng(PNG.sync.read(fs.readFileSync(source)), taille);

    // Une image entierement opaque n'a pas besoin de son canal alpha : le
    // retirer enleve un quart des octets avant compression.
    let opaque = true;
    for (let i = 3; i < reduit.data.length; i += 4) {
      if (reduit.data[i] !== 255) { opaque = false; break; }
    }

    const options = opaque
      ? { deflateLevel: 9, colorType: 2, inputColorType: 6 }
      : { deflateLevel: 9 };
    fs.writeFileSync(cache, PNG.sync.write(reduit, options));
    console.log(`Image du badge regeneree (${nom}) : ${Math.round(fs.statSync(cache).size / 1024)} Ko`);
    return cache;
  } catch (error) {
    console.warn(`Reduction de l'image ${nom} impossible:`, error.message);
    return null;
  }
}

// Dimensions d'un PNG, lues dans son en-tete IHDR (octets 16 a 24). Evite de
// decoder toute l'image juste pour connaitre son rapport largeur/hauteur.
function readPngSize(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const tete = Buffer.alloc(24);
    fs.readSync(fd, tete, 0, 24, 0);
    fs.closeSync(fd);
    if (tete.toString("latin1", 1, 4) !== "PNG") return null;
    return { width: tete.readUInt32BE(16), height: tete.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function getTicketLogoPath(settings) {
  return getTicketImagePath(settings, "logo_url", "logo");
}

function buildTicketPdf(participant, settings) {
  const t = TICKET_COLORS;
  const eventName = settings.event_name || "WeloveAdja";
  const annee = anneeBenin();

  const W = TICKET_WIDTH, H = TICKET_HEIGHT;
  const milieu = W / 2;

  const doc = new PDFDocument({
    size: [W, H],
    margin: 0,
    info: { Title: `Badge ${eventName} - ${participant.code_unique || ""}`, Author: eventName },
  });

  doc.rect(0, 0, W, H).fill(t.clair);

  // Photo de fond, si l'organisateur en a televerse une. Elle est recouverte
  // d'un voile clair : sans lui, une photo contrastee rendrait le QR et les
  // textes illisibles, et un QR illisible est un participant bloque a l'entree.
  const fondPath = getTicketImagePath(settings, "ticket_bg_url", "bg");
  let aFond = false;
  if (fondPath) {
    try {
      doc.save();
      doc.rect(0, 0, W, H).clip();
      // valign "bottom" et non "center" : sur une photo de concert, la foule
      // est en bas et le haut n'est que du ciel sombre. Centre, le cadrage
      // tombait pile dans la zone vide et le badge paraissait uni.
      doc.image(fondPath, 0, 0, { cover: [W, H], align: "center", valign: "bottom" });
      doc.restore();

      // Voile en degrade plutot qu'uniforme : opaque en haut, ou se trouvent
      // le QR et le code qui doivent rester parfaitement lisibles, puis
      // s'effacant vers le bas pour laisser voir la foule.
      const voile = doc.linearGradient(0, 0, 0, H);
      voile.stop(0, t.clair, 0.95);
      voile.stop(0.55, t.clair, 0.9);
      voile.stop(0.78, t.clair, 0.55);
      voile.stop(1, t.clair, 0.12);
      doc.rect(0, 0, W, H).fill(voile);

      aFond = true;
    } catch { /* photo illisible : on garde le fond uni */ }
  }

  // Coins verts en biais, en haut a gauche et a droite.
  doc.moveTo(0, 0).lineTo(148, 0).lineTo(0, 94).closePath().fill(t.vert);
  doc.moveTo(W, 0).lineTo(W - 148, 0).lineTo(W, 94).closePath().fill(t.vert);

  // Bandeau du bas. La courbe PLONGE au milieu : bombee, elle recouvrait la
  // mention "Scannez pour vos infos", qui est centree.
  // Avec une photo, le bandeau est translucide : la foule reste visible
  // derriere, comme sur la maquette, tout en gardant le texte lisible.
  if (aFond) doc.fillOpacity(0.62);
  doc.moveTo(0, H - 64)
     .bezierCurveTo(W * 0.33, H - 24, W * 0.67, H - 24, W, H - 64)
     .lineTo(W, H).lineTo(0, H).closePath().fill(t.sombre);
  doc.fillOpacity(1);

  // -- Les deux logos, de part et d'autre du titre.
  const logoPath = getTicketLogoPath(settings);
  const L = 70;
  let aLogo = false;
  if (logoPath) {
    try {
      doc.image(logoPath, 22, 10, { fit: [L, L] });
      doc.image(logoPath, W - 22 - L, 10, { fit: [L, L] });
      aLogo = true;
    } catch { /* image illisible : le badge reste valable sans logo */ }
  }

  // -- Cartouche du titre. Le bandeau "FESTIVAL ADJA" fourni par l'organisateur
  //    remplace le texte quand il existe ; sinon on dessine le nom.
  const cx = aLogo ? 144 : 96;
  const cw = W - cx * 2;
  const bandeauPath = getTicketImagePath(settings, "wordmark_url", "wordmark");
  let bandeauPose = false;

  if (bandeauPath) {
    try {
      const ch = 54;
      const dim = readPngSize(bandeauPath);

      // Coins arrondis : l'image fournie a des angles droits, alors que le
      // reste du badge (cadre du QR, cadre du code) est arrondi.
      //
      // La decoupe doit porter sur les bornes REELLES de l'image, pas sur le
      // cadre qui l'accueille : avec `fit`, une image en 3:1 posee dans un
      // cadre en 5:1 n'occupe que le centre, et arrondir le cadre laissait
      // les vrais angles bien carres.
      if (dim) {
        const echelle = Math.min(cw / dim.width, ch / dim.height);
        const lg = dim.width * echelle;
        const ht = dim.height * echelle;
        const x = cx + (cw - lg) / 2;
        const y = 12 + (ch - ht) / 2;
        const rayon = Math.min(14, ht / 2);

        doc.save();
        doc.roundedRect(x, y, lg, ht, rayon).clip();
        doc.image(bandeauPath, x, y, { width: lg, height: ht });
        doc.restore();
      } else {
        // Dimensions inconnues : on pose l'image sans arrondi plutot que de
        // risquer une decoupe fausse.
        doc.image(bandeauPath, cx, 12, { fit: [cw, ch], align: "center", valign: "center" });
      }
      bandeauPose = true;
    } catch { /* image illisible : on retombe sur le cartouche texte */ }
  }

  if (!bandeauPose) {
    doc.roundedRect(cx, 12, cw, 54, 13).fill(t.sombre);
    doc.fillColor(t.blanc).font("Helvetica-Bold").fontSize(21)
       .text(eventName.toUpperCase(), cx, 28, { width: cw, align: "center", characterSpacing: 1 });
  }

  // -- "Edition <annee>" entre deux filets.
  const yEdition = 76;
  doc.fillColor(t.sombre).font("Helvetica-Bold").fontSize(11.5)
     .text(`Édition ${annee}`, 0, yEdition, { width: W, align: "center", characterSpacing: 1.2 });
  doc.lineWidth(1.6).strokeColor(t.vert);
  doc.moveTo(milieu - 112, yEdition + 6).lineTo(milieu - 56, yEdition + 6).stroke();
  doc.moveTo(milieu + 56, yEdition + 6).lineTo(milieu + 112, yEdition + 6).stroke();

  // -- QR au centre. Sombre sur blanc : c'est la seule combinaison que TOUS
  //    les lecteurs savent lire, y compris les capteurs bas de gamme.
  const qrPath = localFileFromUrl(participant.qr_code_url);
  // 150 pt au lieu de 116, soit 53 mm : le cas difficile n'est pas le badge
  // imprime mais le PDF presente sur l'ecran d'un telephone a l'entree, ou
  // reflets et moire mangent du contraste. Chaque millimetre compte.
  const qr = 150;
  const qrX = milieu - qr / 2, qrY = 98;
  doc.roundedRect(qrX - 10, qrY - 10, qr + 20, qr + 20, 12)
     .lineWidth(2.4).fillAndStroke(t.blanc, t.vert);
  if (qrPath) {
    try { doc.image(qrPath, qrX, qrY, { fit: [qr, qr] }); } catch {}
  }

  // -- Code d'acces.
  const yCode = qrY + qr + 20;          // 268
  const cwCode = 220, chCode = 42;
  doc.roundedRect(milieu - cwCode / 2, yCode, cwCode, chCode, 11)
     .lineWidth(2).fillAndStroke(t.sombre, t.vert);
  doc.fillColor(t.blanc).font("Helvetica-Bold").fontSize(24)
     .text(participant.code_unique || "------", milieu - cwCode / 2, yCode + 11,
           { width: cwCode, align: "center", characterSpacing: 4 });

  // -- Mention, posee AU-DESSUS du creux du bandeau.
  const yScan = yCode + chCode + 11;    // 321
  doc.fillColor(t.vertFonce).font("Helvetica-Bold").fontSize(8)
     .text("SCANNEZ POUR VOS INFOS", 0, yScan, { width: W, align: "center", characterSpacing: 2 });
  doc.lineWidth(1.2).strokeColor(t.vert);
  doc.moveTo(milieu - 148, yScan + 4).lineTo(milieu - 86, yScan + 4).stroke();
  doc.moveTo(milieu + 86, yScan + 4).lineTo(milieu + 148, yScan + 4).stroke();

  // -- Pied : les deux informations que le controleur verifie a l'entree.
  const yPied = H - 34;
  doc.fillColor(t.vert).font("Helvetica-Bold").fontSize(7)
     .text("PARTICIPANT", 28, yPied, { characterSpacing: 1.6 });
  doc.fillColor(t.blanc).font("Helvetica-Bold").fontSize(11.5)
     .text(texteP(participant.nom) || "-", 28, yPied + 10, { width: W / 2 - 44, height: 15, ellipsis: true });

  const lieu = participant.lieu_retrait || settings.pickup_location || "-";
  doc.fillColor(t.vert).font("Helvetica-Bold").fontSize(7)
     .text("LIEU", W / 2, yPied, { width: W / 2 - 28, align: "right", characterSpacing: 1.6 });
  doc.fillColor(t.creme).font("Helvetica-Bold").fontSize(9.5)
     .text(texteP(lieu), W / 2, yPied + 11, { width: W / 2 - 28, align: "right", height: 14, ellipsis: true });

  return doc;
}

// Rend le PDF en memoire. Il pese quelques dizaines de Ko : le garder en
// tampon evite d'ecrire un fichier temporaire par participant.
function renderTicketPdf(participant, settings) {
  return new Promise((resolve, reject) => {
    try {
      const doc = buildTicketPdf(participant, settings);
      const morceaux = [];
      doc.on("data", (m) => morceaux.push(m));
      doc.on("end", () => resolve(Buffer.concat(morceaux)));
      doc.on("error", reject);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { renderTicketPdf, getTicketLogoPath, MAX_TICKET_LOGO_BYTES };
