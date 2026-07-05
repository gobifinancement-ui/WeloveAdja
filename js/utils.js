const TIMEZONE = "Africa/Porto-Novo";
const JOURS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

function pad(value) {
  return String(value).padStart(2, "0");
}

function getTimeZoneDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return parts.reduce((accumulator, part) => {
    if (part.type !== "literal") {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});
}

function getTimeZoneDate(date = new Date()) {
  const parts = getTimeZoneDateParts(date);
  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
  );
}

export function genererIdCommande() {
  const today = getDateKeyBenin().replace(/-/g, "");
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `BOX-${today}-${random}`;
}

export function dateFormatee() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export function getDateKeyBenin() {
  const parts = getTimeZoneDateParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function jourActuel() {
  const value = new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIMEZONE,
    weekday: "long",
  }).format(new Date());
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function estJourCommandable() {
  return ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"].includes(jourActuel());
}

export function formatMontant(value) {
  return `${Number(value || 0).toLocaleString("fr-FR")} FCFA`;
}

export function getSemaineActuelle() {
  const beninNow = getTimeZoneDate();
  const target = new Date(beninNow.valueOf());
  const dayNumber = (beninNow.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNumber + 3);

  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNumber = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNumber + 3);

  const diff = target - firstThursday;
  const week = 1 + Math.round(diff / 604800000);

  return `${target.getFullYear()}-W${pad(week)}`;
}

export function showToast(message, type = "success") {
  const root =
    document.getElementById("toast-root") ||
    Object.assign(document.body.appendChild(document.createElement("div")), {
      id: "toast-root",
      className: "toast-root",
    });

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  root.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 260);
  }, 3600);
}

export async function copierTexte(text, label = "Texte") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copie.`);
  } catch (error) {
    showToast("Impossible de copier automatiquement.", "error");
  }
}

export function transitionNavigate(href) {
  const layer = document.getElementById("page-transition");
  if (!layer) {
    window.location.href = href;
    return;
  }

  layer.classList.add("is-active");
  window.setTimeout(() => {
    window.location.href = href;
  }, 420);
}

export function bindPageTransitions() {
  document.querySelectorAll("[data-transition]").forEach((element) => {
    element.addEventListener("click", (event) => {
      const href = element.getAttribute("href") || element.dataset.transition;
      if (!href) {
        return;
      }

      event.preventDefault();
      transitionNavigate(href);
    });
  });
}
