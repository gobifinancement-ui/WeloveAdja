/* Pages legales : coordonnees et informations reglees dans l'admin.
 *
 *   [data-contact="email"]  lien mailto vers l'email de contact
 *   [data-contact="wa"]     lien vers le WhatsApp officiel
 *   [data-legal="cle"]      texte d'une information legale (adresse...)
 *   [data-si="cle"]         bloc montre seulement si l'information existe
 *
 * Une information absente est masquee plutot qu'affichee vide : une ligne
 * « Hebergeur : » sans rien derriere ressemble a une page inachevee.
 */
(function () {
  "use strict";

  function appliquer(cfg) {
    var legal = cfg.legal || {};
    var infos = {
      email: cfg.email || "",
      wa: cfg.waLink || "",
      adresse: legal.adresse || "",
      responsable: legal.responsable || "",
      hebergeur: legal.hebergeur || "",
    };

    document.querySelectorAll('[data-contact="email"]').forEach(function (a) {
      if (!infos.email) return;
      a.href = "mailto:" + infos.email;
      a.textContent = infos.email;
    });
    document.querySelectorAll('[data-contact="wa"]').forEach(function (a) {
      if (infos.wa) a.href = infos.wa;
    });
    document.querySelectorAll("[data-legal]").forEach(function (el) {
      el.textContent = infos[el.dataset.legal] || "";
    });
    // Masques dans le HTML, montres ici une fois l'information connue.
    document.querySelectorAll("[data-si]").forEach(function (el) {
      el.hidden = !infos[el.dataset.si];
    });
  }

  fetch("/api/public-config")
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(appliquer);
})();
