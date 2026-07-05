import { bindPageTransitions, formatMontant, showToast } from "./utils.js";

const CHAMPS_PARAMS = [
  { id: "event_name", label: "Nom de l'evenement", type: "text", aide: "Nom affiche sur le site public et dans les emails." },
  { id: "event_year", label: "Annee de l'evenement", type: "text", aide: "Exemple : 2026." },
  { id: "vendeur_email", label: "Email organisateur", type: "email" },
  { id: "vendeur_whatsapp", label: "WhatsApp organisateur (sans +)", type: "tel" },
  { id: "pickup_location", label: "Lieu de retrait", type: "text", aide: "Affiche sur la page publique et dans l'email du participant." },
  { id: "participation_fee", label: "Montant participation", type: "number", aide: "Changer ce montant met a jour toute la page publique." },
  { id: "moov_nom", label: "Nom affiche sur le numero Moov", type: "text" },
  { id: "moov_numero", label: "Numero Moov Money", type: "tel" },
  { id: "mtn_nom", label: "Nom affiche sur le numero MTN", type: "text" },
  { id: "mtn_numero", label: "Numero MTN MoMo", type: "tel" },
  { id: "payment_secret_key", label: "Cle secrete paiement", type: "password", aide: "Cle API secrete utilisee uniquement par le serveur." },
  { id: "payment_environment", label: "Environnement paiement (sandbox/live)", type: "text" },
  { id: "fedapay_webhook_secret", label: "Secret webhook paiement", type: "password", aide: "Sert a securiser la confirmation automatique des paiements." },
  { id: "public_base_url", label: "URL publique du site", type: "url", aide: "Necessaire pour les webhooks et le QR code dans l'email." },
  { id: "wachap_instance_id", label: "WaChap Instance ID", type: "text" },
  { id: "wachap_access_token", label: "WaChap Access Token", type: "password" },
  { id: "resend_api_key", label: "Resend API Key", type: "password", aide: "Cle d'envoi des emails de confirmation." },
  { id: "resend_from", label: "Resend expediteur", type: "text" },
  { id: "admin_password", label: "Mot de passe admin", type: "password" },
];

const loginScreen = document.getElementById("login-screen");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("login-form");

let filtreActif = "tous";
let paramsState = {};

function getAdminToken() {
  return sessionStorage.getItem("admin_token") || "";
}

function setAdminToken(token) {
  sessionStorage.setItem("admin_token", token);
  sessionStorage.setItem("admin_ok", "1");
}

function clearAdminToken() {
  sessionStorage.removeItem("admin_token");
  sessionStorage.removeItem("admin_ok");
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAdminToken()}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      clearAdminToken();
    }
    throw new Error(data.error || "Requete impossible.");
  }

  return data;
}

function getConfigString(key, fallback = "") {
  const value = paramsState?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getParticipationAmount() {
  const raw = Number(paramsState?.participation_fee);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

function getPickupLocation() {
  return getConfigString("pickup_location", "APPLAHOUE AZOVE");
}

function ouvrirOnglet(tab) {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  });

  document.querySelectorAll(".admin-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === `panel-${tab}`);
  });
}

function afficherDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  ouvrirOnglet("participants");
}

function getDisplayStatus(participant) {
  if (participant.statut_code === "utilise") {
    return "Utilise";
  }
  if (participant.statut_paiement === "Valide") {
    return "Valide";
  }
  return "En attente";
}

function getStatusBadge(label) {
  if (label === "Utilise") {
    return '<span class="status-badge info">Code utilise</span>';
  }
  if (label === "Valide") {
    return '<span class="status-badge success">Paiement valide</span>';
  }
  return '<span class="status-badge warning">En attente</span>';
}

function normalizeStatus(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("valid")) {
    return "valide";
  }
  if (normalized.includes("utilis")) {
    return "utilise";
  }
  if (normalized.includes("attente")) {
    return "attente";
  }
  return normalized;
}

function getProofLink(participant) {
  return participant.preuve_url || participant.capture_b64 || participant.preuve_paiement || "";
}

function getPhotoLink(participant) {
  return participant.participant_photo_url || "";
}

async function chargerParticipants() {
  const data = await apiFetch("/api/admin/participants");
  const participants = data.participants || [];
  const stats = data.stats || {};
  const tbody = document.getElementById("tbody-participants");

  document.getElementById("stat-total").textContent = stats.total || 0;
  document.getElementById("stat-attente").textContent = stats.attente || 0;
  document.getElementById("stat-actifs").textContent = stats.actifs || 0;
  document.getElementById("stat-utilises").textContent = stats.utilises || 0;

  if (participants.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">Aucun participant enregistre pour le moment.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = participants
    .map((participant) => {
      const statut = getDisplayStatus(participant);
      const proofHref = getProofLink(participant);
      const photoHref = getPhotoLink(participant);

      return `
        <tr data-status="${statut}">
          <td class="cell-id" data-label="ID">
            <div class="table-primary">${participant.id}</div>
            <div class="cell-sub cell-id-date">${participant.date || "-"}</div>
          </td>
          <td class="cell-date" data-label="Date">${participant.date || "-"}</td>
          <td data-label="Participant">
            <div class="table-primary">${participant.nom || "-"}</div>
            <div class="muted cell-sub">${participant.lieu_retrait || getPickupLocation()}</div>
            ${photoHref ? `<a class="proof-link" href="${photoHref}" target="_blank" rel="noreferrer">Voir photo</a>` : ""}
          </td>
          <td data-label="Contact">
            <div class="table-primary">${participant.telephone || "-"}</div>
            <div class="muted cell-sub">${participant.email || "Email non renseigne"}</div>
          </td>
          <td data-label="Paiement">
            <div class="table-primary">${participant.montant || formatMontant(getParticipationAmount())}</div>
            <div class="muted cell-sub">${participant.operateur_paiement || "Mobile Money"}</div>
            ${participant.fedapay_reference ? `<div class="muted cell-sub">${participant.fedapay_reference}</div>` : ""}
          </td>
          <td data-label="Code">
            <div class="table-primary">${participant.code_unique || "Pas encore genere"}</div>
            <div class="muted cell-sub">${
              participant.statut_code === "actif"
                ? "Code actif"
                : participant.statut_code === "utilise"
                  ? "Code utilise"
                  : "Validation requise"
            }</div>
          </td>
          <td class="cell-status" data-label="Statut">${getStatusBadge(statut)}</td>
          <td class="cell-actions" data-label="Action">
            <div class="action-stack">
              ${
                proofHref
                  ? `<a class="proof-link" href="${proofHref}" target="_blank" rel="noreferrer">Voir preuve</a>`
                  : `<span class="muted">Pas de preuve</span>`
              }
              ${
                participant.statut_paiement === "Valide"
                  ? `<button class="btn btn-secondary" type="button" disabled>Deja valide</button>`
                  : `<button class="btn btn-primary" type="button" onclick="validerPaiement('${participant.id}')">Valider paiement</button>`
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  filtrerParticipants(filtreActif);
}

window.filtrerParticipants = function filtrerParticipants(statut) {
  filtreActif = statut;

  document.querySelectorAll(".filter-btn").forEach((button) => {
    const actif = button.dataset.filter === statut;
    button.classList.toggle("is-active", actif);
    button.setAttribute("aria-pressed", actif ? "true" : "false");
  });

  document.querySelectorAll("#tbody-participants tr").forEach((row) => {
    const visible = statut === "tous" || normalizeStatus(row.dataset.status) === normalizeStatus(statut);
    row.style.display = visible ? "" : "none";
  });
};

window.validerPaiement = async function validerPaiement(id) {
  try {
    const data = await apiFetch("/api/admin/validate-payment", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    showToast(data.email_sent ? "Paiement valide et email envoye." : "Paiement valide. Email non envoye.", data.email_sent ? "success" : "error");
    await chargerParticipants();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Impossible de valider le paiement.", "error");
  }
};

function renderVerificationResult(type, title, participant = null) {
  const result = document.getElementById("verification-result");

  if (!participant) {
    result.innerHTML = `<div class="verify-status ${type}">${title}</div>`;
    return;
  }

  result.innerHTML = `
    <div class="verify-status ${type}">${title}</div>
    <div class="verify-details">
      <p><strong>Nom :</strong> ${participant.nom || "-"}</p>
      <p><strong>Email :</strong> ${participant.email || "-"}</p>
      <p><strong>WhatsApp :</strong> ${participant.telephone || "-"}</p>
      <p><strong>Code :</strong> ${participant.code_unique || "-"}</p>
      <p><strong>Retrait :</strong> ${participant.lieu_retrait || getPickupLocation()}</p>
    </div>
  `;
}

window.verifierCodeParticipant = async function verifierCodeParticipant() {
  const input = document.getElementById("verification-code");
  const code = input.value.trim().toUpperCase();

  if (!code) {
    showToast("Saisissez un code a verifier.", "error");
    return;
  }

  try {
    const data = await apiFetch("/api/admin/verify-code", {
      method: "POST",
      body: JSON.stringify({ code }),
    });

    if (data.status === "already_used") {
      renderVerificationResult("warning", "Code deja utilise", data.participant);
      return;
    }

    renderVerificationResult("success", "Retrait autorise", data.participant);
    await chargerParticipants();
  } catch (error) {
    if (error.message === "Code incorrect.") {
      renderVerificationResult("error", "Code incorrect");
      return;
    }
    console.error(error);
    showToast("Impossible de verifier ce code.", "error");
  }
};

async function chargerParametres() {
  paramsState = await apiFetch("/api/admin/settings");
  const container = document.getElementById("params-form");

  container.innerHTML = CHAMPS_PARAMS.map((champ) => {
    const placeholder = champ.type === "password" ? "Nouvelle valeur" : "Valeur";
    return `
      <div class="form-field">
        <label class="form-label" for="param-${champ.id}">${champ.label}</label>
        <input
          class="form-input"
          id="param-${champ.id}"
          type="${champ.type}"
          value="${paramsState[champ.id] || ""}"
          placeholder="${placeholder}"
        />
        ${champ.aide ? `<p class="helper-text">${champ.aide}</p>` : ""}
      </div>
    `;
  }).join("");
}

window.sauvegarderParametres = async function sauvegarderParametres() {
  try {
    const payload = {};

    CHAMPS_PARAMS.forEach((champ) => {
      payload[champ.id] = document.getElementById(`param-${champ.id}`).value.trim();
    });

    paramsState = await apiFetch("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showToast("Parametres sauvegardes.");
    await chargerParticipants();
  } catch (error) {
    console.error(error);
    showToast("Impossible de sauvegarder les parametres.", "error");
  }
};

async function chargerDashboard() {
  await Promise.all([chargerParametres(), chargerParticipants()]);
}

window.deconnexionAdmin = function deconnexionAdmin() {
  clearAdminToken();
  window.location.reload();
};

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => ouvrirOnglet(button.dataset.tab));
});

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("admin-password").value }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Connexion impossible.");
    }

    setAdminToken(data.token);
    afficherDashboard();
    await chargerDashboard();
    showToast("Connexion admin reussie.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Connexion impossible.", "error");
  }
});

bindPageTransitions();

if (getAdminToken()) {
  afficherDashboard();
  chargerDashboard().catch((error) => {
    console.error(error);
    clearAdminToken();
    showToast(error.message || "Impossible de charger le dashboard.", "error");
    window.setTimeout(() => window.location.reload(), 900);
  });
}
