/* Applique le logo et le nom de l'evenement definis dans l'admin.
 *
 * Les COULEURS ne passent pas par ici : elles sont servies par /api/theme.css,
 * lie dans le <head>, pour etre appliquees des le premier rendu (pas de
 * clignotement). Ce script ne s'occupe que de ce que le CSS ne peut pas faire.
 *
 * Points d'accroche dans le HTML :
 *   [data-brand-logo]  -> <img> dont le src devient le logo (masque si aucun)
 *   [data-brand-mark]  -> element masque des qu'un logo est defini (ex. SVG par defaut)
 *   [data-brand-name]  -> element dont le texte devient le nom de l'evenement
 */

(function () {
  const DEFAULT_ICON = "/api/branding/default-icon.svg";

  function applyFavicon(url) {
    document.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove());
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = url;
    document.head.appendChild(link);
  }

  function apply(config) {
    const logo = config.logoUrl || "";

    document.querySelectorAll("[data-brand-logo]").forEach((element) => {
      if (logo) {
        element.src = logo;
        element.style.display = "";
      } else {
        element.style.display = "none";
      }
    });

    // Le marquage par defaut (SVG inline) s'efface des qu'un vrai logo existe.
    document.querySelectorAll("[data-brand-mark]").forEach((element) => {
      element.style.display = logo ? "none" : "";
    });

    if (config.eventName) {
      document.querySelectorAll("[data-brand-name]").forEach((element) => {
        element.textContent = config.eventName;
      });
      document.title = document.title.replace(/^[^—|]+/, `${config.eventName} `).trim();
    }

    // Toujours une icone : sans logo, le monogramme genere prend le relais.
    // Sinon le navigateur reclame /favicon.ico et se prend un 404 sur chaque page.
    applyFavicon(logo || DEFAULT_ICON);

    if (config.theme && config.theme.colors) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = config.theme.colors.bg;
    }

    window.__brand = config;
    document.dispatchEvent(new CustomEvent("brand:ready", { detail: config }));
  }

  fetch("/api/public-config")
    .then((response) => response.json())
    .then(apply)
    .catch(() => {
      /* hors-ligne : le HTML garde son logo et son nom par defaut */
    });
})();
