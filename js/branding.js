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

    // Le HTML pointe deja sur l'icone generee par le serveur (monogramme aux
    // couleurs du theme) : on ne remplace la source que si un vrai logo existe.
    if (logo) {
      document.querySelectorAll("[data-brand-logo]").forEach((element) => {
        element.src = logo;
      });
    }

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

    showDemoBanner(config.demoMode === true);

    window.__brand = config;
    document.dispatchEvent(new CustomEvent("brand:ready", { detail: config }));
  }

  /* Bandeau du mode demonstration.
   *
   * Tant qu'il est actif, les inscriptions sont validees sans paiement : le
   * bandeau est donc volontairement impossible a manquer, et affiche sur
   * TOUTES les pages qui chargent ce script. C'est le seul garde-fou contre
   * l'oubli, puisque le mode ne s'eteint que manuellement.
   */
  function showDemoBanner(active) {
    const existing = document.getElementById("demo-banner");

    if (!active) {
      if (existing) existing.remove();
      document.documentElement.style.removeProperty("--demo-banner-h");
      return;
    }

    if (existing) return;

    const banner = document.createElement("div");
    banner.id = "demo-banner";
    banner.setAttribute("role", "status");
    banner.textContent =
      "MODE DÉMONSTRATION — les inscriptions sont validées sans paiement réel.";
    banner.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:9999",
      "background:#b3241f", "color:#fff",
      "font:700 .78rem/1.35 system-ui,sans-serif",
      "letter-spacing:.04em", "text-align:center",
      "padding:9px 14px", "pointer-events:none",
      "box-shadow:0 2px 14px rgba(0,0,0,.45)",
    ].join(";");

    document.body.appendChild(banner);
    // Le bandeau est fixe : sans decalage il recouvrirait l'en-tete du site.
    document.documentElement.style.setProperty("--demo-banner-h", banner.offsetHeight + "px");
    document.body.style.paddingTop = banner.offsetHeight + "px";
  }

  // Expose pour l'admin : quand l'organisateur bascule l'interrupteur, le
  // bandeau doit apparaitre ou disparaitre tout de suite. La configuration a
  // ete lue au chargement de la page, elle ne se remet pas a jour toute seule.
  window.setDemoBanner = showDemoBanner;

  fetch("/api/public-config")
    .then((response) => response.json())
    .then(apply)
    .catch(() => {
      /* hors-ligne : le HTML garde son logo et son nom par defaut */
    });
})();
