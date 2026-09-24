/* Thread dedie a la generation des badges PDF.
 *
 * Tourne dans son propre isolat V8 (worker_threads) : dessiner un badge est
 * un calcul synchrone (pdfkit) qui, execute dans le thread principal,
 * gelerait tout le serveur pour tous les visiteurs pendant sa duree. Ici,
 * seule la file d'attente de CE thread est affectee ; le reste du site
 * continue de repondre normalement pendant qu'un badge se dessine.
 *
 * Protocole : le thread principal poste { id, participant, settings }, ce
 * fichier repond { id, buffer } ou { id, error }. `id` sert uniquement a
 * faire correspondre chaque reponse a sa demande cote thread principal.
 */

"use strict";

const { parentPort } = require("worker_threads");
const { renderTicketPdf } = require("./ticket-pdf");

if (!parentPort) {
  throw new Error("ticket-pdf-worker.js doit etre lance comme worker_thread.");
}

parentPort.on("message", async (msg) => {
  const { id, participant, settings } = msg || {};
  try {
    const buffer = await renderTicketPdf(participant, settings);
    // Pas de liste de transfert : le badge pese quelques dizaines de Ko, la
    // copie est negligeable et evite tout risque autour du buffer partage
    // sous-jacent (Buffer.concat peut renvoyer une vue sur un pool memoire
    // partage avec d'autres donnees, qu'un transfert detruirait).
    parentPort.postMessage({ id, buffer });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || String(error) });
  }
});
