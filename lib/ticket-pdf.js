/* Construction du badge PDF, isolee du reste du serveur.
 *
 * Module volontairement pur : aucune dependance a la base de donnees ni a
 * l'etat du serveur (settings arrive en parametre, jamais lu depuis un cache
 * partage). C'est ce qui permet de l'executer depuis un worker_thread separe
 * (voir ticket-pdf-worker.js) : un worker_thread tourne dans son propre
 * isolat V8 et ne peut pas partager les objets du fichier principal, juste
 * des donnees serialisables.
 *
 * La generation d'un badge est posee dans un thread a part parce qu'elle est
 * synchrone et bloquerait sinon la boucle d'evenements de Node pendant son
 * execution : sur un achat de groupe, tout le site resterait fige pour tous
 * les autres visiteurs le temps de dessiner chaque badge.
 *
 * La mise en page elle-meme vit dans js/badge-layout.js, partagee avec le
 * navigateur : ce fichier ne fait que la traduire en commandes pdfkit.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const { PNG } = require("pngjs");
const BadgeLayout = require("../js/badge-layout");

const ROOT = path.join(__dirname, "..");
const BRANDING_DIR = path.join(ROOT, "uploads", "branding");

// Au-dela, le logo n'est pas embarque dans le badge : voir getTicketLogoPath.
const MAX_TICKET_LOGO_BYTES = 400 * 1024;
// Le sceau occupe 65 px sur 854, soit 0,3 pouce imprime : 160 px donnent plus
// de 500 points par pouce. Au-dela, chaque badge envoye par e-mail grossit
// pour rien.
const TICKET_LOGO_SIZE = 160;
const TICKET_LOGO_CACHE = "logo-badge.png";

const POLICES = {
  regular: path.join(ROOT, "fonts", "Poppins-Regular.ttf"),
  semibold: path.join(ROOT, "fonts", "Poppins-SemiBold.ttf"),
  bold: path.join(ROOT, "fonts", "Poppins-Bold.ttf"),
};
const LOGO_GAUCHE = path.join(ROOT, "img", "badge", "logo-simple.png");

// 4 x 6 pouces, format photo courant : la maquette est en 2:3, la page aussi.
const ECHELLE = 432 / BadgeLayout.HAUTEUR;

// Chemin sur disque d'une image servie par une URL du site, ou null.
function localFileFromUrl(url) {
  const clean = String(url || "").split("?")[0].replace(/^\/+/, "");
  if (!clean) return null;
  const filePath = path.join(ROOT, clean);
  // Ne jamais sortir de uploads/ : cette fonction recoit des valeurs venues
  // de la base et des reglages.
  if (!filePath.startsWith(path.join(ROOT, "uploads") + path.sep)) return null;
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

// Logo du site reduit pour le badge (sceau au centre du QR), ou null.
// pdfkit integre les images a leur taille d'origine : un logo de 1,3 Mo
// donnait un badge de 1,3 Mo, d'ou ce cache reduit dans uploads/branding/.
function getTicketLogoPath(settings) {
  const source = localFileFromUrl(settings.logo_url);
  if (!source) return null;

  // Le SVG n'est pas embarquable par pdfkit.
  if (!/\.(png|jpe?g)$/i.test(source)) return null;

  // Un JPEG est deja compresse : pdfkit le reprend tel quel. On ne le reduit
  // pas, mais on refuse ceux qui alourdiraient trop le badge.
  if (/\.jpe?g$/i.test(source)) {
    try { return fs.statSync(source).size <= MAX_TICKET_LOGO_BYTES ? source : null; } catch { return null; }
  }

  const cache = path.join(BRANDING_DIR, TICKET_LOGO_CACHE);
  try {
    const infoSource = fs.statSync(source);
    if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= infoSource.mtimeMs) {
      return cache;
    }

    const reduit = downscalePng(PNG.sync.read(fs.readFileSync(source)), TICKET_LOGO_SIZE);
    // Ecrit a cote puis renomme : plusieurs threads de badge peuvent arriver
    // ici en meme temps, aucun ne doit lire un fichier a moitie ecrit.
    const temporaire = `${cache}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temporaire, PNG.sync.write(reduit, { deflateLevel: 9 }));
    fs.renameSync(temporaire, cache);
    console.log(`Logo du badge regenere : ${Math.round(fs.statSync(cache).size / 1024)} Ko`);
    return cache;
  } catch (error) {
    console.warn("Reduction du logo du badge impossible:", error.message);
    return null;
  }
}

// Matrice du QR, sous une forme serialisable (le navigateur la recoit telle
// quelle pour dessiner l'image du badge sans bibliotheque QR).
function qrMatrice(code) {
  const texte = String(code || "");
  if (!texte) return null;
  let qr;
  try {
    qr = QRCode.create(texte, {
      errorCorrectionLevel: BadgeLayout.QR.correction,
      version: BadgeLayout.QR.version,
    });
  } catch {
    // Code trop long pour la version imposee : on laisse la bibliotheque
    // choisir, le QR reste lisible, simplement plus dense.
    qr = QRCode.create(texte, { errorCorrectionLevel: BadgeLayout.QR.correction });
  }
  const n = qr.modules.size;
  let bits = "";
  for (let i = 0; i < n * n; i += 1) bits += qr.modules.data[i] ? "1" : "0";
  return { n, bits };
}

// Textes du badge depuis les reglages. Un champ vide retombe sur la maquette :
// un badge sans titre ni dates n'est jamais ce qu'on veut imprimer. Passe le
// jour de bascule, l'annee et l'edition avancent d'elles-memes (voir
// editionEnCours) : un badge imprime en septembre annonce l'edition suivante.
function textesBadge(settings, maintenant) {
  return BadgeLayout.textesDepuisReglages(settings, maintenant);
}

// Arc de cercle en courbes de Bezier, relie au trace en cours. doc.arc() de
// pdfkit commence par un moveTo, ce qui casserait une forme fermee.
function arcBezier(doc, cx, cy, r, a0, a1, antihoraire, relier) {
  let delta = a1 - a0;
  if (antihoraire && delta > 0) delta -= 2 * Math.PI;
  if (!antihoraire && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const pas = delta / n;
  const k = (4 / 3) * Math.tan(pas / 4) * r;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  if (relier) doc.lineTo(x0, y0); else doc.moveTo(x0, y0);
  for (let i = 0; i < n; i += 1) {
    const a = a0 + i * pas, b = a + pas;
    doc.bezierCurveTo(
      cx + r * Math.cos(a) - k * Math.sin(a), cy + r * Math.sin(a) + k * Math.cos(a),
      cx + r * Math.cos(b) + k * Math.sin(b), cy + r * Math.sin(b) - k * Math.cos(b),
      cx + r * Math.cos(b), cy + r * Math.sin(b),
    );
  }
}

function moteurPdf(doc) {
  const chemin = (ops) => {
    let courant = false;
    for (const op of ops) {
      if (op[0] === "M") { doc.moveTo(op[1], op[2]); courant = true; }
      else if (op[0] === "L") doc.lineTo(op[1], op[2]);
      else if (op[0] === "A") { arcBezier(doc, op[1], op[2], op[3], op[4], op[5], op[6], courant); courant = true; }
      else if (op[0] === "Z") { doc.closePath(); courant = false; }
    }
  };
  return {
    remplir(ops, couleur) { chemin(ops); doc.fill(couleur); },
    tracer(ops, epaisseur, couleur) { chemin(ops); doc.lineWidth(epaisseur).stroke(couleur); },
    sauver() { doc.save(); },
    restaurer() { doc.restore(); },
    decouper(ops) { chemin(ops); doc.clip(); },
    image(img, x, y, l, h) { doc.image(img, x, y, { width: l, height: h }); },
    texte(chaine, x, base, police, taille, couleur, espacement, echelleX) {
      doc.font(police).fontSize(taille).fillColor(couleur).text(chaine, x, base, {
        lineBreak: false,
        baseline: "alphabetic",
        characterSpacing: espacement || 0,
        horizontalScaling: (echelleX || 1) * 100,
      });
    },
    largeur(chaine, police, taille) {
      return doc.font(police).fontSize(taille).widthOfString(chaine);
    },
  };
}

// Image ouverte par pdfkit, avec ses dimensions, ou null si illisible.
function ouvrirImage(doc, chemin) {
  if (!chemin) return null;
  try {
    const img = doc.openImage(chemin);
    return { img, largeur: img.width, hauteur: img.height };
  } catch {
    return null;
  }
}

// Un badge par page. Plusieurs badges d'un meme achat tiennent dans un seul
// fichier : plus simple a imprimer ou a transmettre qu'une pile de PDF.
// Les images communes (logo, sceau) ne sont integrees qu'une fois.
function buildTicketPdf(participants, settings) {
  const liste = (Array.isArray(participants) ? participants : [participants]).filter(Boolean);
  const eventName = settings.event_name || "WeloveAdja";
  const L = BadgeLayout;
  const taille = [L.LARGEUR * ECHELLE, L.HAUTEUR * ECHELLE];

  const doc = new PDFDocument({
    size: taille,
    margin: 0,
    autoFirstPage: false,
    info: {
      Title: liste.length > 1 ? `Badges ${eventName}` : `Badge ${eventName} - N° ${L.numeroBadge(liste[0] && liste[0].numero_badge)}`,
      Author: eventName,
    },
  });
  Object.entries(POLICES).forEach(([nom, fichier]) => doc.registerFont(nom, fichier));
  const textes = textesBadge(settings);
  const logoGauche = ouvrirImage(doc, fs.existsSync(LOGO_GAUCHE) ? LOGO_GAUCHE : null);
  const sceau = ouvrirImage(doc, getTicketLogoPath(settings));

  liste.forEach((participant) => {
    doc.addPage({ size: taille, margin: 0 });
    doc.page.margins.bottom = 0;
    doc.scale(ECHELLE);

    // La photo n'est prise que dans uploads/ et dans un format que pdfkit
    // sait lire ; sinon le cadre affiche une silhouette.
    const photoPath = localFileFromUrl(participant.participant_photo_url);
    const photo = photoPath && /\.(png|jpe?g)$/i.test(photoPath) ? ouvrirImage(doc, photoPath) : null;

    L.dessinerBadge(moteurPdf(doc), Object.assign({}, textes, {
      nom: participant.nom,
      numero: participant.numero_badge,
      qr: qrMatrice(participant.code_unique),
      photo,
      logoGauche,
      sceau,
    }));
  });

  return doc;
}

// Rend le PDF en memoire. Il pese quelques dizaines de Ko : le garder en
// tampon evite d'ecrire un fichier temporaire par participant. Accepte un
// participant ou une liste (un badge par page).
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

module.exports = { renderTicketPdf, getTicketLogoPath, qrMatrice, textesBadge, MAX_TICKET_LOGO_BYTES, TICKET_LOGO_CACHE };
