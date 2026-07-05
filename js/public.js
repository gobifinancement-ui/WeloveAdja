import { formatMontant, showToast } from "./utils.js";

const DEFAULT_CONFIG = {
  event_name: "Pluri Party",
  event_year: "2026",
  pickup_location: "APPLAHOUE AZOVE",
  participation_fee: "10000",
  payment_environment: "sandbox",
};
const MAX_CAPTURE_BYTES = 700000;

let config = { ...DEFAULT_CONFIG };
let step = 1;
let participantPhotoBase64 = null;
let participantPhotoName = "";
let paymentInitialized = false;
let paymentCompleted = false;
let paymentSent = false;
let paymentTransaction = null;
let pendingParticipant = null;
let pendingTransaction = null;
let selectedPaymentMode = "moov";
let paymentPollTimer = null;

const hdr = document.getElementById("hdr");
const form = document.getElementById("participationForm");
const panes = document.querySelectorAll(".pane");
const nodes = document.querySelectorAll(".p-node");
const bar1 = document.getElementById("bar1");
const bar2 = document.getElementById("bar2");
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const preview = document.getElementById("preview");
const submitBtn = document.getElementById("submitBtn");
const paymentEmbed = document.getElementById("payment-embed");
const paymentUnavailable = document.getElementById("payment-unavailable");
const paymentStatus = document.getElementById("payment-status");
let activePage = "home";

function getAmount() {
  const amount = Number(config.participation_fee);
  return Number.isFinite(amount) && amount > 0 ? amount : 10000;
}

function scrollToForm() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goToPage(pageName) {
  if (!pageName || pageName === activePage) {
    return;
  }

  const currentPage = document.querySelector(`[data-page="${activePage}"]`);
  const nextPage = document.querySelector(`[data-page="${pageName}"]`);
  if (!nextPage) {
    return;
  }

  nextPage.classList.add("is-active", "page-enter");
  currentPage?.classList.add("page-exit");
  window.scrollTo({ top: 0, behavior: "auto" });

  window.setTimeout(() => {
    currentPage?.classList.remove("is-active", "page-exit");
    nextPage.classList.remove("page-enter");
    activePage = pageName;
  }, 520);
}

function paintStepper() {
  panes.forEach((pane) => pane.classList.toggle("show", Number(pane.dataset.pane) === step));
  nodes.forEach((node) => {
    const value = Number(node.dataset.step);
    node.classList.toggle("active", value === step);
    node.classList.toggle("done", value < step);
  });
  bar1.style.width = step > 1 ? "100%" : "0";
  bar2.style.width = step > 2 ? "100%" : "0";
}

function goToStep(nextStep) {
  if (nextStep === 2 && !validateStep1()) {
    return;
  }
  if (nextStep === 3 && !participantPhotoBase64) {
    showErr("file", true);
    return;
  }

  step = nextStep;
  paintStepper();
  scrollToForm();

  if (step === 3) {
    initializePayment();
  }
}

function showErr(key, visible) {
  const error = document.querySelector(`[data-err="${key}"]`);
  const input = document.getElementById(key);
  error?.classList.toggle("show", visible);
  input?.classList.toggle("bad", visible);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateStep1() {
  const nom = document.getElementById("nom").value.trim();
  const wa = document.getElementById("wa").value.replace(/\D/g, "");
  const email = document.getElementById("email").value.trim();
  let ok = true;

  if (nom.length < 2) {
    showErr("nom", true);
    ok = false;
  } else {
    showErr("nom", false);
  }

  if (wa.length < 8) {
    showErr("wa", true);
    ok = false;
  } else {
    showErr("wa", false);
  }

  if (!validEmail(email)) {
    showErr("email", true);
    ok = false;
  } else {
    showErr("email", false);
  }

  return ok;
}

function updateDynamicCopy() {
  const amount = formatMontant(getAmount());
  const eventName = config.event_name || DEFAULT_CONFIG.event_name;
  const eventYear = config.event_year || DEFAULT_CONFIG.event_year;

  document.querySelectorAll("[data-amount]").forEach((element) => {
    element.textContent = amount;
  });
  document.getElementById("pay-amount").textContent = amount;
  document.querySelectorAll("[data-location]").forEach((element) => {
    element.textContent = config.pickup_location || DEFAULT_CONFIG.pickup_location;
  });
  document.querySelectorAll("[data-event-name]").forEach((element) => {
    element.textContent = eventName;
  });
  document.querySelectorAll("[data-event-year]").forEach((element) => {
    element.textContent = eventYear;
  });
  document.querySelectorAll("[data-event-title]").forEach((element) => {
    element.textContent = eventName;
  });
  document.querySelectorAll("[data-event-label]").forEach((element) => {
    element.textContent = `Inscription ${eventName} ${eventYear}`;
  });
  document.querySelectorAll("[data-event-footer]").forEach((element) => {
    element.textContent = `${eventYear} ${eventName}`;
  });
  document.title = `${eventName} ${eventYear}`;
}

function setSubmitState(label, disabled = true) {
  submitBtn.disabled = disabled;
  submitBtn.textContent = label;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;
        const max = 900;

        if (width > max) {
          height = Math.round((height * max) / width);
          width = max;
        }
        if (height > max) {
          width = Math.round((width * max) / height);
          height = max;
        }

        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);

        let quality = 0.75;
        let result = canvas.toDataURL("image/jpeg", quality);

        while (new TextEncoder().encode(result).length > MAX_CAPTURE_BYTES && quality > 0.15) {
          quality -= 0.1;
          result = canvas.toDataURL("image/jpeg", quality);
        }

        if (new TextEncoder().encode(result).length > MAX_CAPTURE_BYTES) {
          reject(new Error("Image trop lourde. Utilise une photo plus legere."));
          return;
        }

        resolve(result);
      };

      img.onerror = () => reject(new Error("Impossible de lire cette image."));
      img.src = event.target.result;
    };

    reader.onerror = () => reject(new Error("Impossible de lire ce fichier."));
    reader.readAsDataURL(file);
  });
}

async function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("Ajoute une image valide.", "error");
    return;
  }

  try {
    participantPhotoBase64 = await compressImage(file);
    participantPhotoName = file.name;
    showErr("file", false);

    document.getElementById("pvName").textContent = file.name;
    document.getElementById("pvSize").textContent = `${(file.size / 1024 / 1024).toFixed(2)} Mo`;
    document.getElementById("pvImg").src = participantPhotoBase64;
    preview.classList.add("show");
    drop.style.display = "none";
  } catch (error) {
    participantPhotoBase64 = null;
    participantPhotoName = "";
    fileInput.value = "";
    showToast(error.message || "Impossible de traiter l'image.", "error");
  }
}

function clearPhoto() {
  participantPhotoBase64 = null;
  participantPhotoName = "";
  resetPaymentSession();
  fileInput.value = "";
  preview.classList.remove("show");
  drop.style.display = "";
}

function resetPaymentSession() {
  paymentInitialized = false;
  paymentCompleted = false;
  paymentSent = false;
  paymentTransaction = null;
  pendingParticipant = null;
  pendingTransaction = null;
  if (paymentPollTimer) {
    clearInterval(paymentPollTimer);
    paymentPollTimer = null;
  }
  if (paymentStatus) {
    paymentStatus.textContent = "Choisis ton reseau puis lance la demande de paiement.";
  }
  paymentEmbed.classList.remove("hidden");
  paymentUnavailable.classList.add("hidden");
  setSubmitState("Lancer le paiement", step === 3 ? false : true);
}

function getRegistrationPayload() {
  return {
    nom: document.getElementById("nom").value.trim(),
    telephone: document.getElementById("wa").value.trim(),
    email: document.getElementById("email").value.trim(),
    participant_photo_base64: participantPhotoBase64,
    participant_photo_nom: participantPhotoName,
  };
}

async function createServerPayment() {
  const response = await fetch("/api/payments/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getRegistrationPayload()),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Paiement indisponible.");
  }

  pendingParticipant = data.participant;
  pendingTransaction = data.transaction;

  if (!pendingParticipant?.id || !pendingTransaction?.id) {
    throw new Error("Session de paiement incomplete.");
  }
}

function initializePayment() {
  if (paymentInitialized) {
    return;
  }

  paymentInitialized = true;
  setSubmitState("Lancer le paiement", false);
  if (paymentStatus) {
    paymentStatus.textContent = "Choisis ton reseau puis lance la demande de paiement.";
  }
}

async function startDirectPayment() {
  setSubmitState("Preparation du paiement...", true);
  try {
    if (!pendingParticipant || !pendingTransaction) {
      await createServerPayment();
    }

    const response = await fetch("/api/payments/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participant_id: pendingParticipant.id,
        fedapay_transaction_id: pendingTransaction.id,
        mode: selectedPaymentMode,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Paiement indisponible.");
    }

    paymentSent = true;
    paymentTransaction = pendingTransaction;
    if (paymentStatus) {
      paymentStatus.textContent = "Demande envoyee. Valide le paiement sur ton telephone, puis patiente quelques secondes.";
    }
    setSubmitState("Verifier le paiement", false);
    startPaymentPolling();
  } catch (error) {
    console.error(error);
    paymentUnavailable.classList.remove("hidden");
    setSubmitState("Reessayer le paiement", false);
    showToast(error.message || "Paiement indisponible.", "error");
  }
}

function showConfirmation(participant) {
  const nom = document.getElementById("nom").value.trim();
  const wa = document.getElementById("wa").value.trim();

  document.getElementById("c-name").textContent = nom.split(" ")[0] || "";
  document.getElementById("c-ref").textContent = participant.code_unique || participant.id || "PLURI";
  document.getElementById("c-r-name").textContent = nom;
  document.getElementById("c-r-wa").textContent = wa;
  document.getElementById("c-r-code").textContent = participant.code_unique || "-";
  document.getElementById("c-r-amount").textContent = formatMontant(getAmount());

  form.classList.add("hidden");
  document.getElementById("progress").classList.add("hidden");
  document.getElementById("reg-header").classList.add("hidden");
  document.getElementById("confirm").classList.add("show");
  scrollToForm();
}

async function submitRegistration(event) {
  event?.preventDefault?.();

  if (!validateStep1()) {
    goToStep(1);
    return;
  }

  if (!participantPhotoBase64) {
    showErr("file", true);
    goToStep(2);
    return;
  }

  if (!paymentSent) {
    await startDirectPayment();
    return;
  }

  await checkPaymentStatus(false);
}

async function checkPaymentStatus(silent = true) {
  if (!paymentTransaction?.id || !pendingParticipant?.id) {
    return;
  }

  setSubmitState("Verification du paiement...", true);

  try {
    const response = await fetch("/api/payments/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participant_id: pendingParticipant.id,
        fedapay_transaction_id: paymentTransaction.id,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Inscription impossible.");
    }

    if (data.status === "approved" && data.participant) {
      paymentCompleted = true;
      if (paymentPollTimer) {
        clearInterval(paymentPollTimer);
        paymentPollTimer = null;
      }
      showConfirmation(data.participant);
      return;
    }

    if (paymentStatus) {
      paymentStatus.textContent = "Paiement en attente. Termine la validation sur ton telephone.";
    }
    if (!silent) {
      showToast("Paiement encore en attente.", "error");
    }
    setSubmitState("Verifier le paiement", false);
  } catch (error) {
    console.error(error);
    if (!silent) {
      showToast(error.message || "Erreur pendant la verification.", "error");
    }
    setSubmitState("Verifier le paiement", false);
  }
}

function startPaymentPolling() {
  if (paymentPollTimer) {
    clearInterval(paymentPollTimer);
  }

  paymentPollTimer = setInterval(() => {
    checkPaymentStatus(true);
  }, 6000);
}

function resetForm() {
  form.reset();
  clearPhoto();
  step = 1;
  resetPaymentSession();
  paintStepper();
  form.classList.remove("hidden");
  document.getElementById("progress").classList.remove("hidden");
  document.getElementById("reg-header").classList.remove("hidden");
  document.getElementById("confirm").classList.remove("show");
  scrollToForm();
}

async function verifyPublicCode() {
  const codeInput = document.getElementById("public-code");
  const result = document.getElementById("publicVerifyResult");
  const code = codeInput.value.trim().toUpperCase();

  result.classList.remove("hidden");
  if (!code) {
    result.innerHTML = "<strong>Code obligatoire.</strong><br>Entre le code recu apres paiement.";
    return;
  }

  result.textContent = "Verification en cours...";

  try {
    const response = await fetch("/api/public/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Code introuvable.");
    }

    const participant = data.participant || {};
    const statusLabel = data.status === "already_used" ? "Code deja utilise" : "Participation validee";
    result.innerHTML = `
      <strong>${statusLabel}</strong><br>
      Nom : ${participant.nom || "-"}<br>
      Code : ${participant.code_unique || code}<br>
      Montant : ${participant.montant || formatMontant(getAmount())}<br>
      Retrait : ${participant.lieu_retrait || config.pickup_location || DEFAULT_CONFIG.pickup_location}
    `;
  } catch (error) {
    console.error(error);
    result.innerHTML = `<strong>Code non valide.</strong><br>${error.message || "Aucune participation confirmee avec ce code."}`;
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/public-config");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Configuration indisponible.");
    }
    config = { ...DEFAULT_CONFIG, ...data };
  } catch (error) {
    console.error(error);
    showToast("Parametres indisponibles. Valeurs par defaut chargees.", "error");
  }
  updateDynamicCopy();
}

async function loadStats() {
  try {
    const response = await fetch("/api/public-stats");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Stats indisponibles.");
    }
    const count = data.participants || 0;
    document.getElementById("live-count").textContent = `${count} inscrit${count > 1 ? "s" : ""}`;
    document.getElementById("hero-live").textContent = `${count} inscription${count > 1 ? "s" : ""}`;
  } catch (error) {
    console.error(error);
    document.getElementById("live-count").textContent = "Inscriptions ouvertes";
  }
}

function bindEvents() {
  window.addEventListener("scroll", () => hdr.classList.toggle("scrolled", window.scrollY > 20));

  document.querySelectorAll("[data-route]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.preventDefault();
      goToPage(element.dataset.route);
    });
  });

  document.querySelectorAll("[data-next]").forEach((button) => {
    button.addEventListener("click", () => goToStep(Number(button.dataset.next) + 1));
  });

  document.querySelectorAll("[data-back]").forEach((button) => {
    button.addEventListener("click", () => goToStep(Number(button.dataset.back) - 1));
  });

  drop.addEventListener("click", () => fileInput.click());
  ["dragover", "dragenter"].forEach((eventName) => {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.remove("drag");
    });
  });
  drop.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
  fileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
  document.getElementById("pvRemove").addEventListener("click", clearPhoto);
  document.getElementById("againBtn").addEventListener("click", resetForm);
  document.getElementById("publicVerifyBtn").addEventListener("click", verifyPublicCode);
  document.getElementById("public-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      verifyPublicCode();
    }
  });
  document.querySelectorAll("[data-pay-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (paymentSent) {
        showToast("Une demande de paiement est deja lancee.", "error");
        return;
      }
      selectedPaymentMode = button.dataset.payMode;
      document.querySelectorAll("[data-pay-mode]").forEach((item) => item.classList.toggle("sel", item === button));
    });
  });
  ["nom", "wa", "email"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      if (paymentInitialized || pendingParticipant) {
        resetPaymentSession();
      }
    });
  });
  form.addEventListener("submit", submitRegistration);
}

bindEvents();
paintStepper();
updateDynamicCopy();
loadConfig();
loadStats();
