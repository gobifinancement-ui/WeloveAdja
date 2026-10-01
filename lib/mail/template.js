/* Gabarit HTML unique, partage par TOUS les e-mails du projet.
 *
 * Pourquoi des tableaux et des styles ecrits sur chaque balise plutot que du
 * CSS moderne : Outlook rend le HTML avec le moteur de Word, qui ignore
 * flexbox, grid, les media queries et les feuilles de style externes. Gmail,
 * lui, retire purement et simplement la balise <style> sur mobile. Un tableau
 * avec des attributs inline est la seule construction que TOUS les clients
 * affichent de la meme facon depuis vingt ans.
 *
 * Un seul gabarit, parametre : titre, corps, libelle et lien du bouton. Un
 * gabarit par type de message finirait par diverger, et une correction de mise
 * en page devrait etre repetee partout.
 */

"use strict";

// Echappement HTML. Le nom du participant vient d'un formulaire public : sans
// cela, on pourrait glisser du balisage dans un message envoye depuis notre
// propre domaine.
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Une couleur venant des reglages finit dans un attribut de style : on la
// refuse si ce n'est pas un hexadecimal, sinon on ouvre une injection CSS.
function safeColor(value, repli) {
  const v = String(value || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : repli;
}

// Une URL finit dans un href : on n'accepte que http(s) et mailto. Sans ce
// filtre, un "javascript:" ou un "data:" pourrait s'y glisser.
function safeUrl(value) {
  const v = String(value || "").trim();
  return /^(https?:\/\/|mailto:)/i.test(v) ? v : "";
}

// Mise en page calquee sur un e-mail transactionnel que l'organisation a
// choisi comme modele (fond gris, carte blanche, logo centre, titre en gras,
// details en lignes « Etiquette : valeur », bouton centre).
const PALETTE = {
  marque: "#0a8f4f",
  marqueFonce: "#006600",
  fond: "#ececec",
  carte: "#ffffff",
  texte: "#1a1a1a",
  texteDoux: "#6b6b6b",
  bordure: "#e6e6e6",
  pastille: "#f2f2f2",
  boutonTexte: "#ffffff",
};

const POLICE = "Helvetica,Arial,sans-serif";

/**
 * Construit le corps HTML complet d'un e-mail.
 *
 * @param {object} o
 * @param {string} o.eventName    nom de l'evenement (texte alternatif du logo)
 * @param {string} [o.logoCid]    identifiant de l'image du logo jointe au message
 * @param {string} [o.logoUrl]    a defaut, URL absolue du logo
 * @param {string} o.titre        titre principal du message
 * @param {string} [o.intro]      phrase d'accroche sous le titre
 * @param {string[]} [o.paragraphes]  paragraphes avant les details (texte brut)
 * @param {string} [o.encadre]    valeur mise en avant (un code a recopier)
 * @param {string} [o.encadreLabel] intitule au-dessus de l'encadre
 * @param {string} [o.detailsTitre] intitule au-dessus des details
 * @param {Array<[string,string,string?]>} [o.details] lignes « etiquette : valeur » ;
 *        un 3e element "code" affiche la valeur dans une pastille a chasse fixe
 * @param {string[]} [o.conclusion] paragraphes apres les details
 * @param {string} [o.boutonTexte] libelle du bouton
 * @param {string} [o.boutonLien]  lien du bouton
 * @param {string} [o.piedNote]    mention discrete en bas
 * @param {string} [o.couleur]     couleur du bouton
 */
function renderEmail(o = {}) {
  const marque = safeColor(o.couleur, PALETTE.marque);
  const eventName = escapeHtml(o.eventName || "");
  const logoUrl = safeUrl(o.logoUrl);
  const logoCid = /^[a-z0-9-]+$/i.test(String(o.logoCid || "")) ? o.logoCid : "";
  const lien = safeUrl(o.boutonLien);

  const paragraphe = (texte, extra = "") =>
    `<p style="margin:0 0 16px;font-family:${POLICE};font-size:16px;line-height:1.55;color:${PALETTE.texte};${extra}">${escapeHtml(texte)}</p>`;

  const paragraphes = (o.paragraphes || []).filter(Boolean).map((p) => paragraphe(p)).join("");
  const conclusion = (o.conclusion || []).filter(Boolean).map((p) => paragraphe(p)).join("");

  const encadre = o.encadre
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 22px">
         <tr><td align="center" style="background-color:${PALETTE.pastille};border-radius:8px;padding:18px 16px">
           ${
             o.encadreLabel
               ? `<div style="font-family:${POLICE};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${PALETTE.texteDoux};margin-bottom:8px">${escapeHtml(o.encadreLabel)}</div>`
               : ""
           }
           <div style="font-family:Consolas,'Courier New',monospace;font-size:30px;font-weight:bold;letter-spacing:6px;color:${PALETTE.texte}">${escapeHtml(o.encadre)}</div>
         </td></tr>
       </table>`
    : "";

  // Une ligne par detail, etiquette en gras : « Montant : 15 000 F CFA ».
  const ligneDetail = ([cle, valeur, genre]) => {
    const v = genre === "code"
      ? `<span style="font-family:Consolas,'Courier New',monospace;font-size:14px;background-color:${PALETTE.pastille};border-radius:4px;padding:3px 8px;color:${PALETTE.texte};letter-spacing:1px">${escapeHtml(valeur)}</span>`
      : escapeHtml(valeur);
    return `<p style="margin:0 0 14px;font-family:${POLICE};font-size:14px;line-height:1.5;color:${PALETTE.texte}"><b>${escapeHtml(cle)} :</b> ${v}</p>`;
  };
  const details = (o.details || []).length
    ? `${o.detailsTitre ? `<p style="margin:26px 0 18px;font-family:${POLICE};font-size:15px;font-weight:bold;color:${PALETTE.texte}">${escapeHtml(o.detailsTitre)}</p>` : ""}
       <div style="margin:0 0 22px">${(o.details || []).map(ligneDetail).join("")}</div>`
    : "";

  // Bouton construit en tableau : un <a> avec du rembourrage suffit partout
  // sauf sous Outlook, qui n'applique pas le padding a un lien en ligne.
  const bouton =
    lien && o.boutonTexte
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 10px">
           <tr><td align="center" bgcolor="${marque}" style="background-color:${marque};border-radius:6px">
             <a href="${escapeHtml(lien)}" target="_blank" rel="noopener"
                style="display:inline-block;padding:14px 40px;font-family:${POLICE};font-size:16px;font-weight:bold;color:${PALETTE.boutonTexte};text-decoration:none;border-radius:6px">${escapeHtml(o.boutonTexte)}</a>
           </td></tr>
         </table>`
      : "";

  const sourceLogo = logoCid ? `cid:${logoCid}` : logoUrl;
  const logo = sourceLogo
    ? `<img src="${escapeHtml(sourceLogo)}" width="240" alt="${eventName}" style="display:block;width:240px;max-width:80%;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none">`
    : `<div style="font-family:${POLICE};font-size:24px;font-weight:bold;color:${PALETTE.marqueFonce}">${eventName}</div>`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(o.titre || o.eventName || "")}</title>
</head>
<body style="margin:0;padding:0;background-color:${PALETTE.fond};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${PALETTE.fond};">
  <tr><td align="center" style="padding:26px 0 30px;">

    <!-- width="600" pour Outlook (moteur de Word) ; ailleurs, le style rend la
         carte fluide : pleine largeur sur telephone, 600 px au plus. -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background-color:${PALETTE.carte};">

      <tr><td align="center" style="padding:36px 30px 30px;">${logo}</td></tr>

      <tr><td style="padding:4px 30px 14px;">
        <h1 style="margin:0 0 16px;font-family:${POLICE};font-size:20px;line-height:1.35;font-weight:bold;color:${PALETTE.texte};">${escapeHtml(o.titre || "")}</h1>
        ${o.intro ? paragraphe(o.intro) : ""}
        ${paragraphes}
        ${encadre}
        ${details}
        ${conclusion}
        ${bouton}
      </td></tr>

      <tr><td style="padding:10px 30px 30px;">
        ${o.piedNote ? `<p style="margin:10px 0 0;padding-top:16px;border-top:1px solid ${PALETTE.bordure};font-family:${POLICE};font-size:12px;line-height:1.6;color:${PALETTE.texteDoux};">${escapeHtml(o.piedNote)}</p>` : ""}
      </td></tr>

    </table>

    <div style="font-family:${POLICE};font-size:11px;color:${PALETTE.texteDoux};padding:16px 10px 0;">${eventName}</div>

  </td></tr>
</table>
</body>
</html>`;
}

/* Version texte brut. Elle n'est pas facultative : un message envoye en HTML
   seul est note comme suspect par les filtres anti-spam, et certains clients
   n'affichent que le texte. */
function renderText(o = {}) {
  const lignes = [];
  if (o.titre) lignes.push(o.titre, "");
  if (o.intro) lignes.push(o.intro, "");
  (o.paragraphes || []).filter(Boolean).forEach((p) => lignes.push(p, ""));
  if (o.encadre) lignes.push(`${o.encadreLabel ? o.encadreLabel + " : " : ""}${o.encadre}`, "");
  if (o.detailsTitre && (o.details || []).length) lignes.push(o.detailsTitre, "");
  (o.details || []).forEach(([cle, valeur]) => lignes.push(`${cle} : ${valeur}`));
  if ((o.details || []).length) lignes.push("");
  (o.conclusion || []).filter(Boolean).forEach((p) => lignes.push(p, ""));
  if (o.boutonLien) lignes.push(`${o.boutonTexte || "Ouvrir"} : ${o.boutonLien}`, "");
  if (o.piedNote) lignes.push(o.piedNote);
  return lignes.join("\n").trim() + "\n";
}

module.exports = { renderEmail, renderText, escapeHtml, safeColor, safeUrl, PALETTE };
