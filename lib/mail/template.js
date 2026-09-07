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

const PALETTE = {
  marque: "#12662c",
  marqueClair: "#2fa84f",
  fond: "#eef2ee",
  carte: "#ffffff",
  texte: "#14231a",
  texteDoux: "#5b6b60",
  bordure: "#dde5df",
  boutonTexte: "#ffffff",
};

/**
 * Construit le corps HTML complet d'un e-mail.
 *
 * @param {object} o
 * @param {string} o.eventName    nom de l'evenement, affiche dans le bandeau
 * @param {string} [o.logoUrl]    URL absolue du logo (ignoree si relative)
 * @param {string} o.titre        titre principal du message
 * @param {string} [o.intro]      phrase d'accroche sous le titre
 * @param {string[]} [o.paragraphes]  paragraphes de contenu (texte brut)
 * @param {string} [o.encadre]    valeur mise en avant (un code, un montant)
 * @param {string} [o.encadreLabel] intitule au-dessus de l'encadre
 * @param {Array<[string,string]>} [o.details] lignes cle/valeur
 * @param {string} [o.boutonTexte] libelle du bouton
 * @param {string} [o.boutonLien]  lien du bouton
 * @param {string} [o.piedNote]    mention discrete en bas
 * @param {string} [o.couleur]     couleur de marque
 */
function renderEmail(o = {}) {
  const marque = safeColor(o.couleur, PALETTE.marque);
  const eventName = escapeHtml(o.eventName || "");
  const logo = safeUrl(o.logoUrl);
  const lien = safeUrl(o.boutonLien);

  const paragraphes = (o.paragraphes || [])
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${PALETTE.texte}">${escapeHtml(p)}</p>`,
    )
    .join("");

  const encadre = o.encadre
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 20px">
         <tr><td align="center" style="background-color:#f3f8f4;border:1px dashed ${marque};border-radius:10px;padding:18px 16px">
           ${
             o.encadreLabel
               ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${PALETTE.texteDoux};margin-bottom:8px">${escapeHtml(o.encadreLabel)}</div>`
               : ""
           }
           <div style="font-family:Arial,Helvetica,sans-serif;font-size:30px;font-weight:bold;letter-spacing:6px;color:${marque}">${escapeHtml(o.encadre)}</div>
         </td></tr>
       </table>`
    : "";

  const details = (o.details || []).length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;border:1px solid ${PALETTE.bordure};border-radius:10px">
         ${(o.details || [])
           .map(
             ([cle, valeur], i) =>
               `<tr>
                  <td style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${PALETTE.texteDoux};${i ? `border-top:1px solid ${PALETTE.bordure};` : ""}">${escapeHtml(cle)}</td>
                  <td align="right" style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:${PALETTE.texte};${i ? `border-top:1px solid ${PALETTE.bordure};` : ""}">${escapeHtml(valeur)}</td>
                </tr>`,
           )
           .join("")}
       </table>`
    : "";

  // Bouton construit en tableau : un <a> avec du rembourrage suffit partout
  // sauf sous Outlook, qui n'applique pas le padding a un lien en ligne.
  const bouton =
    lien && o.boutonTexte
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px">
           <tr><td align="center" bgcolor="${marque}" style="background-color:${marque};border-radius:8px">
             <a href="${escapeHtml(lien)}" target="_blank" rel="noopener"
                style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${PALETTE.boutonTexte};text-decoration:none;border-radius:8px">${escapeHtml(o.boutonTexte)}</a>
           </td></tr>
         </table>`
      : "";

  const enteteLogo = logo
    ? `<img src="${escapeHtml(logo)}" width="54" height="54" alt="${eventName}" style="display:block;border:0;outline:none;text-decoration:none;border-radius:8px">`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#ffffff">${eventName}</div>`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${eventName}</title>
</head>
<body style="margin:0;padding:0;background-color:${PALETTE.fond};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${PALETTE.fond};">
  <tr><td align="center" style="padding:24px 12px;">

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background-color:${PALETTE.carte};border-radius:14px;overflow:hidden;">

      <tr><td align="center" bgcolor="${marque}" style="background-color:${marque};padding:22px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding-right:12px;">${enteteLogo}</td>
          <td style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;color:#ffffff;letter-spacing:1px;">${eventName}</td>
        </tr></table>
      </td></tr>

      <tr><td style="padding:28px 26px 8px;">
        <h1 style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:21px;line-height:1.35;color:${PALETTE.texte};">${escapeHtml(o.titre || "")}</h1>
        ${o.intro ? `<p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${PALETTE.texteDoux};">${escapeHtml(o.intro)}</p>` : ""}
        ${paragraphes}
        ${encadre}
        ${details}
        ${bouton}
      </td></tr>

      <tr><td style="padding:8px 26px 26px;">
        ${o.piedNote ? `<p style="margin:14px 0 0;padding-top:14px;border-top:1px solid ${PALETTE.bordure};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:${PALETTE.texteDoux};">${escapeHtml(o.piedNote)}</p>` : ""}
      </td></tr>

    </table>

    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${PALETTE.texteDoux};padding:14px 10px 0;">${eventName}</div>

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
  (o.details || []).forEach(([cle, valeur]) => lignes.push(`${cle} : ${valeur}`));
  if ((o.details || []).length) lignes.push("");
  if (o.boutonLien) lignes.push(`${o.boutonTexte || "Ouvrir"} : ${o.boutonLien}`, "");
  if (o.piedNote) lignes.push(o.piedNote);
  return lignes.join("\n").trim() + "\n";
}

module.exports = { renderEmail, renderText, escapeHtml, safeColor, safeUrl, PALETTE };
