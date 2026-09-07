/* Trois points animes pendant qu'un bouton attend.
 *
 * Remplace les libelles d'attente ecrits a la main ("Envoi...", "Preparation...",
 * "Verification...") : ils changeaient la largeur du bouton, disaient une chose
 * differente a chaque endroit, et ne bougeaient pas, donc rien ne distinguait
 * une attente d'un blocage.
 *
 * Usage :
 *   const fin = Chargement(bouton);   // ou Chargement(bouton, 150)
 *   try { ... } finally { fin(); }
 *
 * Le second parametre est un seuil en millisecondes : en dessous, les points
 * ne sont jamais poses. Utile pour une action presque toujours instantanee,
 * ou un affichage immediat ne serait qu'un clignotement.
 */
(function (global) {
  function Chargement(bouton, seuil) {
    if (!bouton || bouton.dataset.chargeActif === '1') return function () {};

    // Mesure AVANT de vider le bouton : trois points sont bien plus etroits
    // qu'un libelle, et sans largeur figee la mise en page sauterait sous le
    // doigt au moment meme du clic.
    const contenu = bouton.innerHTML;
    const largeur = bouton.offsetWidth;
    const hauteur = bouton.offsetHeight;
    let pose = false;

    function poser() {
      pose = true;
      bouton.dataset.chargeActif = '1';
      if (largeur) bouton.style.minWidth = largeur + 'px';
      if (hauteur) bouton.style.minHeight = hauteur + 'px';
      bouton.setAttribute('aria-busy', 'true');
      bouton.innerHTML =
        '<span class="pts" role="status" aria-label="Chargement en cours">' +
        '<i></i><i></i><i></i></span>';
    }

    bouton.disabled = true;
    const minuteur = seuil > 0 ? setTimeout(poser, seuil) : (poser(), 0);

    return function fin() {
      clearTimeout(minuteur);
      bouton.disabled = false;
      if (!pose) return;
      bouton.innerHTML = contenu;
      bouton.style.minWidth = '';
      bouton.style.minHeight = '';
      bouton.removeAttribute('aria-busy');
      delete bouton.dataset.chargeActif;
    };
  }

  global.Chargement = Chargement;
})(window);
