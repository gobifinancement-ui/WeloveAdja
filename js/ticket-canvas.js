/* Dessin du badge sur une toile.
 *
 * La mise en page vient de js/badge-layout.js, la meme que celle du PDF
 * produit par le serveur : ce fichier ne fait que la traduire en appels
 * canvas. Il est partage entre la page d'accueil (recuperation du badge) et
 * la page de retour de paiement.
 *
 * Prerequis : badge-layout.js charge avant ce fichier.
 */

(function (global) {
  const L = global.BadgeLayout;
  // Nom propre au badge : il ne doit pas dependre d'une police Poppins
  // eventuellement chargee par la page avec d'autres graisses.
  const FAMILLE = "PoppinsBadge";
  let polices = null;

  // Sans ses polices, le badge serait dessine dans la police systeme : on les
  // attend avant tout dessin. Un echec n'est pas memorise, on reessaiera.
  function chargerPolices() {
    if (!polices) {
      polices = (async () => {
        if (!("FontFace" in global) || !document.fonts) return false;
        const faces = [
          new FontFace(FAMILLE, "url(/fonts/Poppins-Regular.ttf) format('truetype')", { weight: "400" }),
          new FontFace(FAMILLE, "url(/fonts/Poppins-SemiBold.ttf) format('truetype')", { weight: "600" }),
          new FontFace(FAMILLE, "url(/fonts/Poppins-Bold.ttf) format('truetype')", { weight: "700" }),
        ];
        await Promise.all(faces.map((f) => f.load()));
        faces.forEach((f) => document.fonts.add(f));
        return true;
      })().catch(() => { polices = null; return false; });
    }
    return polices;
  }

  // Image chargee avec ses dimensions, ou null : une image manquante ne doit
  // jamais empecher de produire le badge.
  const charger = (src) => new Promise((res) => {
    if (!src) return res(null);
    const img = new Image();
    img.onload = () => res(img.naturalWidth ? { img, largeur: img.naturalWidth, hauteur: img.naturalHeight } : null);
    img.onerror = () => res(null);
    img.src = src;
  });

  function moteurCanvas(ctx) {
    const chemin = (ops) => {
      ctx.beginPath();
      for (const op of ops) {
        if (op[0] === "M") ctx.moveTo(op[1], op[2]);
        else if (op[0] === "L") ctx.lineTo(op[1], op[2]);
        else if (op[0] === "A") ctx.arc(op[1], op[2], op[3], op[4], op[5], op[6]);
        else if (op[0] === "Z") ctx.closePath();
      }
    };
    const GRAISSES = { regular: "400 ", semibold: "600 ", bold: "700 " };
    const police = (p, t) => (GRAISSES[p] || "400 ") + t + "px " + FAMILLE + ", Arial, sans-serif";
    return {
      remplir(ops, couleur) { chemin(ops); ctx.fillStyle = couleur; ctx.fill(); },
      tracer(ops, epaisseur, couleur) { chemin(ops); ctx.lineWidth = epaisseur; ctx.strokeStyle = couleur; ctx.stroke(); },
      sauver() { ctx.save(); },
      restaurer() { ctx.restore(); },
      decouper(ops) { chemin(ops); ctx.clip(); },
      image(img, x, y, l, h) { ctx.drawImage(img, x, y, l, h); },
      texte(chaine, x, base, p, taille, couleur, esp, echelleX) {
        ctx.font = police(p, taille);
        ctx.fillStyle = couleur;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        if (echelleX && echelleX !== 1) {
          ctx.save();
          ctx.translate(x, base);
          ctx.scale(echelleX, 1);
          ctx.fillText(chaine, 0, 0);
          ctx.restore();
          return;
        }
        if (!esp) { ctx.fillText(chaine, x, base); return; }
        // Espacement pose lettre a lettre plutot que par ctx.letterSpacing,
        // absent de Safari avant la version 17. La position de chaque lettre
        // vient de la mesure du prefixe : le crenage est conserve, comme
        // dans le PDF.
        let prefixe = "";
        Array.from(chaine).forEach((car, i) => {
          prefixe += car;
          const pos = ctx.measureText(prefixe).width - ctx.measureText(car).width;
          ctx.fillText(car, x + pos + i * esp, base);
        });
      },
      largeur(chaine, p, taille) { ctx.font = police(p, taille); return ctx.measureText(chaine).width; },
    };
  }

  // Textes du badge depuis la configuration publique. Meme regle que le
  // serveur (lib/ticket-pdf.js, textesBadge) : un champ vide reprend la maquette.
  function textes(config) {
    const b = (config && config.badge) || {};
    const D = L.DEFAUTS;
    const val = (v, defaut) => (v != null && String(v).trim() ? String(v) : defaut);
    return L.editionEnCours({
      titre: val(b.titre, D.titre),
      annee: val(b.annee, D.annee),
      edition: val(b.edition, D.edition),
      lieu: val(b.lieu, D.lieu),
      dates: val(b.dates, D.dates),
      activites: val(b.activites, D.activites),
    }, b.bascule);
  }

  /* Charge ce qui est commun a tous les badges : polices, logo de gauche,
     sceau du QR. A appeler une fois, puis passer le resultat a dessiner(). */
  async function chargerActifs(config) {
    const c = config || {};
    const [logoGauche, sceau] = await Promise.all([
      charger("/img/badge/logo-simple.png"),
      charger((c.badge && c.badge.sceauUrl) || ""),
      chargerPolices(),
    ]);
    return { config: c, logoGauche, sceau };
  }

  /* Dessine le badge d'un billet. `echelle` 1 = 854 x 1280 px, la taille de
     la maquette ; 1,5 donne une image nette a l'impression en 10 x 15 cm. */
  async function dessiner(canvas, billet, actifs, echelle) {
    const k = echelle || 1;
    await chargerPolices();
    const photo = await charger(billet.photo || "");
    canvas.width = Math.round(L.LARGEUR * k);
    canvas.height = Math.round(L.HAUTEUR * k);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if ("fontKerning" in ctx) ctx.fontKerning = "normal";
    L.dessinerBadge(moteurCanvas(ctx), Object.assign(textes(actifs.config), {
      nom: billet.nom,
      numero: billet.numero,
      qr: billet.qr_matrice || null,
      photo,
      logoGauche: actifs.logoGauche,
      sceau: actifs.sceau,
    }));
  }

  /* Badge en fichier PNG, dessine sur une toile jetable a la taille
     d'impression. Les apercus restent petits : dix badges a cette taille
     occuperaient pres de 100 Mo de memoire sur un telephone. */
  // Sert aussi aux apercus, a echelle reduite : une toile affichee telle
  // quelle dans la page se couvrait de bandes sur des telephones Android (le
  // navigateur perd son contenu en memoire graphique). Une image PNG, non.
  async function versPng(billet, actifs, echelle) {
    const toile = document.createElement("canvas");
    await dessiner(toile, billet, actifs, echelle || 1.5);
    const blob = await new Promise((res) => toile.toBlob(res, "image/png"));
    toile.width = toile.height = 0;
    if (!blob) throw new Error("Image impossible à produire.");
    return blob;
  }

  global.TicketCanvas = { dessiner, versPng, charger, chargerActifs };
})(window);
