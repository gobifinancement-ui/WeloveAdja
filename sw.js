/* Service worker : rend l'app de scan et l'admin utilisables sans reseau.
 *
 * Regles :
 *  - coquille de l'app (HTML/JS/CSS) : cache d'abord, on sert instantanement
 *    et hors-ligne. Une revalidation en tache de fond garde le cache frais.
 *  - /api/theme.css : RESEAU d'abord, cache en secours. Un cache-d'abord
 *    servirait l'ancienne palette apres un changement dans l'admin (le site
 *    resterait en retard d'un rechargement) ; les couleurs doivent etre justes
 *    des qu'il y a du reseau, et survivre hors-ligne.
 *  - reste de /api/ : reseau uniquement. Les donnees sensibles (participants)
 *    ne doivent jamais trainer dans le cache HTTP ; l'app de scan gere son
 *    propre instantane cote IndexedDB.
 */

const VERSION = "v13";
const SHELL_CACHE = `adja-shell-${VERSION}`;
const RUNTIME_CACHE = `adja-runtime-${VERSION}`;

const SHELL_ASSETS = [
  "/scan.html",
  "/admin.html",
  "/installer.html",
  "/js/vendor/jsqr.js",
  "/js/scan-store.js",
  "/js/scan-app.js",
  "/js/branding.js",
  "/api/theme.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll est tout-ou-rien : un seul 404 ferait echouer l'installation.
      // On tolere donc les absences pour ne jamais bloquer la mise a jour.
      .then((cache) => Promise.all(SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

function isShellAsset(url) {
  return SHELL_ASSETS.some((asset) => url.pathname === asset) || url.pathname.startsWith("/js/");
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || network || new Response("", { status: 504, statusText: "Hors-ligne" });
}

// Reseau d'abord : la reponse fraiche gagne toujours, le cache ne sert que de
// filet hors-ligne.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response("", { status: 504, statusText: "Hors-ligne" });
  }
}

// Ouverture d'une page. Le reseau reste prioritaire (un correctif du matin
// doit se voir tout de suite), mais sur un reseau qui traine, la derniere
// version gardee s'affiche au bout de 4 s : dans un village mal couvert, le
// site repond au lieu de laisser une page blanche. La version fraiche,
// quand elle finit par arriver, est gardee pour la visite suivante.
async function naviguer(request, cacheName = SHELL_CACHE) {
  const cache = await caches.open(cacheName);
  const reseau = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  });
  const garde = await cache.match(request);
  if (!garde) {
    try {
      return await reseau;
    } catch {
      if (request.mode !== "navigate") return new Response("", { status: 504, statusText: "Hors-ligne" });
      return (await caches.match("/scan.html")) || new Response("Hors-ligne", { status: 503 });
    }
  }
  const patience = new Promise((resolve) => setTimeout(() => resolve(garde), 4000));
  try {
    return await Promise.race([reseau, patience]);
  } catch {
    return garde;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // L'ouverture d'une page passe TOUJOURS par le reseau d'abord, cache en
  // secours. Ce test doit precéder isShellAsset : sinon /scan.html serait servi
  // depuis le cache, et un correctif deploye le matin de l'evenement
  // n'apparaitrait qu'a la deuxieme ouverture de l'app.
  if (request.mode === "navigate") {
    event.respondWith(naviguer(request));
    return;
  }

  if (url.pathname === "/api/theme.css") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // Scripts : meme regle que les pages. Servis « garde d'abord » ils
  // pouvaient, juste apres une mise en ligne, arriver dans leur ancienne
  // version sous une page neuve.
  if (isShellAsset(url)) {
    event.respondWith(naviguer(request, SHELL_CACHE));
    return;
  }

  // Les donnees participants ne sont jamais mises en cache HTTP.
  if (url.pathname.startsWith("/api/")) return;

  // Ni les fichiers televerses : photos des participants, QR codes (qui
  // encodent un code d'entree valide), logo. Un telephone de scan partage
  // entre agents ne doit pas garder ces images apres la deconnexion.
  if (url.pathname.startsWith("/uploads/")) return;

  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});

// L'app demande une synchro des que le reseau revient.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
