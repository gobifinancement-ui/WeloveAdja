/* App de scan — contrôle d'entrée hors-ligne.
 *
 * Principe : le verdict est rendu LOCALEMENT, sans attendre le reseau. Le
 * registre IndexedDB fait autorite pour ce telephone ; le serveur n'est
 * sollicite que pour rafraichir l'instantane et remonter les scans.
 */

(function () {
  const TOKEN_KEY = "adja_scan_token";
  const $ = (id) => document.getElementById(id);

  let scanner = null;
  let eventItems = [];
  let current = null;
  let torchOn = false;

  /* ---------------- Session ---------------- */

  // localStorage (et non sessionStorage) : l'app de scan est fermee/rouverte
  // toute la journee, le jeton doit survivre.
  const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      clearToken();
      throw new Error("SESSION");
    }

    // 403 : le jeton est valide mais n'a pas le droit d'appeler cette route.
    // Ne pas effacer le jeton ici, sinon l'agent devrait se reconnecter alors
    // que son acces au scan, lui, fonctionne toujours.
    if (response.status === 403) {
      throw new Error("Ce compte n'a pas l'autorisation pour cette action.");
    }

    // Trop de requetes : on remonte le delai d'attente tel quel pour que
    // l'agent sache qu'il ne s'agit pas d'une panne.
    if (response.status === 429) {
      const info = await response.json().catch(() => ({}));
      throw new Error(info.error || "Trop de requêtes. Patiente un instant.");
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
    return data;
  }

  /* ---------------- UI utilitaires ---------------- */

  let toastTimer = null;
  function toast(message) {
    const element = $("toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
  }

  function buzz(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  // Sons synthetises : pas de fichier audio a charger, donc ca marche
  // hors-ligne des le premier scan.
  //
  // Facon terminal de paiement, pour qu'on les reconnaisse dans le bruit de
  // l'entree sans regarder l'ecran : accepte = « bi-bip » aigu et bref,
  // refuse = deux notes graves qui descendent, plus longues.
  //
  // Safari (iPhone) ne laisse sortir le son qu'apres un geste de
  // l'utilisateur. Un scan par la camera n'en est pas un : sans deblocage,
  // l'iPhone restait muet. Le contexte audio est donc cree et reveille au
  // premier toucher (connexion, bouton, n'importe ou sur l'ecran).
  let audioContext = null;
  function contexteAudio() {
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
      return audioContext;
    } catch {
      return null;
    }
  }
  function debloquerAudio() {
    const ctx = contexteAudio();
    if (!ctx) return;
    // Un son muet joue pendant le geste suffit a ouvrir la sortie audio.
    const tampon = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = tampon;
    source.connect(ctx.destination);
    source.start(0);
  }
  ["pointerdown", "touchend", "keydown"].forEach((type) =>
    window.addEventListener(type, debloquerAudio, { passive: true }));

  function note(ctx, debut, frequence, duree, forme, volume) {
    const oscillateur = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillateur.type = forme;
    oscillateur.frequency.setValueAtTime(frequence, debut);
    // Attaque tres courte, puis extinction : un « clic » sec comme un TPE,
    // sans craquement en debut et fin de note.
    gain.gain.setValueAtTime(0.0001, debut);
    gain.gain.exponentialRampToValueAtTime(volume, debut + 0.008);
    gain.gain.setValueAtTime(volume, debut + duree * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, debut + duree);
    oscillateur.connect(gain);
    gain.connect(ctx.destination);
    oscillateur.start(debut);
    oscillateur.stop(debut + duree + 0.02);
  }

  function beep(ok) {
    const ctx = contexteAudio();
    if (!ctx) return; /* audio indisponible : le verdict visuel suffit */
    try {
      const t = ctx.currentTime + 0.01;
      if (ok) {
        // Accepte : deux bips aigus rapproches.
        note(ctx, t, 2093, 0.07, "square", 0.18);
        note(ctx, t + 0.1, 2637, 0.12, "square", 0.18);
      } else {
        // Refuse : deux notes graves qui descendent, impossibles a confondre.
        note(ctx, t, 392, 0.22, "sawtooth", 0.22);
        note(ctx, t + 0.26, 262, 0.38, "sawtooth", 0.22);
      }
    } catch {
      /* audio indisponible : le verdict visuel suffit */
    }
  }

  const escapeHtml = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function timeAgo(timestamp) {
    if (!timestamp) return "–";
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "à l'instant";
    if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
    return new Date(timestamp).toLocaleDateString("fr-FR");
  }

  /* ---------------- État réseau ---------------- */

  function isOnline() {
    return navigator.onLine;
  }

  function paintNetwork() {
    const element = $("net");
    const online = isOnline();
    element.classList.toggle("off", !online);
    $("netTxt").textContent = online ? "En ligne" : "Hors-ligne";
  }

  async function paintStats() {
    const info = await ScanStore.getSnapshotInfo();
    const queue = await ScanStore.getQueue();
    const done = await ScanStore.countLedger();

    eventItems = info.eventItems || [];

    $("sCodes").textContent = info.count;
    $("sQueue").textContent = queue.length;
    $("sDone").textContent = done;
    $("sSync").textContent = info.at ? timeAgo(info.at) : "jamais";
    $("sQueueChip").classList.toggle("alert", queue.length > 0);
    $("sSyncChip").classList.toggle("alert", !info.at);

    $("mCodes").textContent = info.count;
    $("mQueue").textContent = queue.length;
    $("mSync").textContent = info.at ? new Date(info.at).toLocaleString("fr-FR") : "jamais";

    if (info.eventName) $("evName").textContent = info.eventName;
  }

  /* ---------------- Instantané & synchro ---------------- */

  async function refreshSnapshot(silent) {
    if (!isOnline()) {
      if (!silent) toast("Hors-ligne : mise à jour impossible");
      return false;
    }
    if (!getToken()) {
      if (!silent) askPassword();
      return false;
    }

    try {
      const snapshot = await api("/api/admin/scan/snapshot");
      await ScanStore.replaceSnapshot(snapshot);
      await paintStats();
      if (!silent) toast(`Base à jour — ${snapshot.codes.length} codes`);
      return true;
    } catch (error) {
      if (error.message === "SESSION") {
        askPassword();
      } else if (!silent) {
        toast("Mise à jour impossible");
      }
      return false;
    }
  }

  async function syncQueue(silent) {
    const queue = await ScanStore.getQueue();
    if (!queue.length) {
      if (!silent) toast("Rien à synchroniser");
      return;
    }
    if (!isOnline()) {
      if (!silent) toast(`${queue.length} scan(s) en attente de réseau`);
      return;
    }
    if (!getToken()) {
      if (!silent) askPassword();
      return;
    }

    try {
      const deviceId = await ScanStore.getDeviceId();
      const result = await api("/api/admin/scan/sync", {
        method: "POST",
        body: JSON.stringify({
          device_id: deviceId,
          scans: queue.map((entry) => ({ code: entry.code, scanned_at: entry.scanned_at, items: entry.items || null })),
        }),
      });

      // On ne vide la file que pour ce que le serveur a reellement traite.
      const settled = result.results.filter((r) => r.status !== "invalid").map((r) => r.code);
      await ScanStore.clearFromQueue(settled);

      const conflicts = result.results.filter((r) => r.status === "conflict");
      for (const conflict of conflicts) {
        await ScanStore.markConflict(conflict.code, conflict);
      }

      await paintStats();

      if (conflicts.length) {
        toast(`${result.synced} envoyé(s), ${conflicts.length} conflit(s) — voir l'admin`);
        buzz([90, 60, 90]);
      } else if (!silent) {
        toast(`${result.synced} scan(s) synchronisé(s)`);
      }
    } catch (error) {
      if (error.message === "SESSION") askPassword();
      else if (!silent) toast("Synchro impossible");
    }
  }

  /* ---------------- Photos hors-ligne ----------------
     Les photos ne sont pas dans l'instantane : trop lourdes pour etre
     rechargees a chaque synchronisation. On les telecharge une fois, sur
     demande, quand l'agent a du reseau - idealement en wifi avant l'evenement.

     Chaque photo est reduite a 256 px avant stockage : une photo de telephone
     pese 150 Ko, la vignette 15 Ko. Sur 300 participants, 4 Mo au lieu de 45. */

  async function majEtatPhotos() {
    const zone = $("dlEtat");
    if (!zone) return;
    try {
      const codes = await ScanStore.listCodes();
      const avecPhoto = codes.filter((c) => c.photo).length;
      const enCache = await ScanStore.countPhotos();
      zone.textContent = avecPhoto
        ? `${enCache} photo(s) en local sur ${avecPhoto} attendue(s).`
        : "Aucune photo à télécharger : mets d'abord la base à jour.";
    } catch {
      zone.textContent = "—";
    }
  }

  async function telechargerPhotos() {
    const bouton = $("dlPhotos");
    const barre = $("dlBar");
    const remplissage = $("dlBarFill");
    const zone = $("dlEtat");

    if (!isOnline()) {
      zone.textContent = "Pas de réseau. Reconnecte-toi puis réessaie.";
      return;
    }

    const codes = (await ScanStore.listCodes()).filter((c) => c.photo);
    if (!codes.length) {
      zone.textContent = "Aucune photo à télécharger : mets d'abord la base à jour.";
      return;
    }

    bouton.disabled = true;
    barre.classList.add("on");
    let faits = 0, echecs = 0, ignores = 0;

    for (const entree of codes) {
      // Deja en cache : on ne retelecharge pas. Reprendre un telechargement
      // interrompu doit couter le moins possible sur un reseau fragile.
      const deja = await ScanStore.getPhoto(entree.code).catch(() => null);
      if (deja) { ignores++; }
      else {
        try {
          const res = await fetch(entree.photo, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const petit = await ScanStore.shrinkImage(await res.blob());
          await ScanStore.putPhoto(entree.code, petit);
          faits++;
        } catch {
          echecs++;
        }
      }

      const total = faits + echecs + ignores;
      remplissage.style.width = Math.round((total / codes.length) * 100) + "%";
      zone.textContent = `${total} / ${codes.length}…`;
    }

    bouton.disabled = false;
    barre.classList.remove("on");
    remplissage.style.width = "0";
    zone.textContent =
      `${faits} téléchargée(s)` +
      (ignores ? `, ${ignores} déjà en local` : "") +
      (echecs ? `, ${echecs} en échec` : "") + ".";
  }

  if ($("dlPhotos")) $("dlPhotos").addEventListener("click", telechargerPhotos);

  /* ---------------- Vérification d'identité ----------------
     Le controleur doit voir le visage AVANT de decider. Le code n'est donc
     consomme qu'apres confirmation : consomme avant, un refus laisserait le
     billet brule alors que la personne n'est pas entree. */

  let attenteIdentite = null;   // { code, known, onConfirm }
  let urlPhotoAffichee = "";

  function fermerIdentite() {
    $("idSheet").classList.remove("show");
    if (urlPhotoAffichee) {
      URL.revokeObjectURL(urlPhotoAffichee);
      urlPhotoAffichee = "";
    }
    attenteIdentite = null;
  }

  /* Charge la photo : d'abord le magasin local, sinon le reseau. L'ordre
     compte : hors-ligne, seul le local repond, et le jour J le reseau sera
     sature. */
  async function chargerPhoto(code, urlDistante) {
    const local = await ScanStore.getPhoto(code).catch(() => null);
    if (local) return { blob: local, source: "local" };

    if (!urlDistante || !isOnline()) return null;
    try {
      const res = await fetch(urlDistante, { cache: "force-cache" });
      if (!res.ok) return null;
      const blob = await res.blob();
      // Mise en cache au passage : la prochaine fois, plus besoin de reseau.
      ScanStore.shrinkImage(blob).then((petit) => ScanStore.putPhoto(code, petit)).catch(() => {});
      return { blob, source: "réseau" };
    } catch {
      return null;
    }
  }

  async function demanderIdentite({ code, known, meta, avertissement, onConfirm }) {
    fermerIdentite();
    attenteIdentite = { code, onConfirm };

    $("idName").textContent = (known && known.nom) || "—";
    $("idCode").textContent = code;
    $("idMeta").innerHTML = (meta || [])
      .filter(Boolean)
      .map((t) => `<span>${escapeHtml(t)}</span>`)
      .join("");

    const zoneAvert = $("idWarn");
    zoneAvert.hidden = !avertissement;
    if (avertissement) zoneAvert.innerHTML = avertissement;

    // On affiche l'écran tout de suite et on remplit la photo ensuite : le
    // controleur ne doit pas attendre devant un ecran vide.
    $("idPhoto").removeAttribute("src");
    $("idNoPhoto").hidden = false;
    $("idNoPhotoTxt").textContent = "Chargement de la photo…";
    $("idSheet").classList.add("show");

    const photo = await chargerPhoto(code, known && known.photo);
    if (!attenteIdentite || attenteIdentite.code !== code) return;   // deja referme

    if (photo) {
      urlPhotoAffichee = URL.createObjectURL(photo.blob);
      $("idPhoto").src = urlPhotoAffichee;
      $("idNoPhoto").hidden = true;
    } else {
      $("idNoPhoto").hidden = false;
      $("idNoPhotoTxt").textContent = isOnline()
        ? "Aucune photo enregistrée pour ce participant"
        : "Photo indisponible hors-ligne. Télécharge les photos depuis les réglages quand tu auras du réseau.";
    }
  }

  $("idConfirm").addEventListener("click", async () => {
    const attente = attenteIdentite;
    if (!attente) return;
    fermerIdentite();
    await attente.onConfirm();
  });

  $("idRefuse").addEventListener("click", () => {
    // Sans verification en cours, il n'y a rien a refuser : un double appui
    // apres fermeture ne doit pas afficher un verdict sorti de nulle part.
    if (!attenteIdentite) return;
    const code = attenteIdentite.code;
    fermerIdentite();
    beep(false);
    buzz([90, 60, 90]);
    // Rien n'est consomme : le billet reste valable pour son vrai porteur.
    showVerdict("ko", "Entrée refusée", "Le billet n'a pas été utilisé",
      { nom: "—", code: code || "—" },
      "Le code reste <b>valable</b>. La personne inscrite peut se présenter avec ce même billet.");
  });

  /* ---------------- Verdict ---------------- */

  const ICONS = {
    ok: '<svg width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>',
    used: '<svg width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    ko: '<svg width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };

  function showVerdict(kind, title, subtitle, participant, warning) {
    const colors = { ok: "var(--ok)", used: "var(--warn)", ko: "var(--ko)" };
    $("sheetCard").style.setProperty("--x", colors[kind]);
    $("vIc").innerHTML = ICONS[kind === "ok" ? "ok" : kind === "used" ? "used" : "ko"];
    $("vTitle").textContent = title;
    $("vSub").textContent = subtitle || "";

    if (participant) {
      $("who").style.display = "";
      $("wName").textContent = participant.nom || "—";
      $("wCode").textContent = participant.code || "—";
      const meta = [];
      if (participant.montant) meta.push(`<span>${escapeHtml(participant.montant)}</span>`);
      if (participant.lieu_retrait) meta.push(`<span>${escapeHtml(participant.lieu_retrait)}</span>`);
      $("wMeta").innerHTML = meta.join("");
    } else {
      $("who").style.display = "none";
    }

    $("warnHost").innerHTML = warning ? `<div class="warnbox">${warning}</div>` : "";

    const showItems = kind === "ok" && eventItems.length > 0;
    $("itemsHost").style.display = showItems ? "" : "none";
    if (showItems) renderItems(participant);

    $("sheet").classList.add("show");
  }

  function renderItems(participant) {
    const received = (current && current.items) || {};
    $("itemsList").innerHTML = eventItems
      .map((item) => {
        const id = item.id || item.name || item.label;
        const label = item.name || item.label || id;
        const done = received[id] ? " done" : "";
        return `<label class="item${done}" data-item="${escapeHtml(id)}">
          <input type="checkbox" ${received[id] ? "checked" : ""}>
          <span>${escapeHtml(label)}</span>
        </label>`;
      })
      .join("");

    $("itemsList")
      .querySelectorAll(".item")
      .forEach((element) => {
        element.addEventListener("click", (event) => {
          event.preventDefault();
          const id = element.dataset.item;
          const checkbox = element.querySelector("input");
          const next = !checkbox.checked;
          checkbox.checked = next;
          element.classList.toggle("done", next);
          if (current) {
            current.items = current.items || {};
            current.items[id] = next;
            // La case cochee part avec le scan a la prochaine synchro.
            ScanStore.updateQueueItems(current.code, current.items).catch(() => {});
          }
        });
      });
  }

  function closeSheet() {
    $("sheet").classList.remove("show");
    current = null;
    if (scanner) scanner.resetCooldown();
  }

  /* ---------------- Traitement d'un scan ---------------- */

  async function handleCode(raw) {
    const code = QrScanner.extractCode(raw);
    if (!code) return;

    const known = await ScanStore.lookup(code);

    // Code absent de la base locale : soit la base est perimee, soit le QR
    // n'est pas des notres. En ligne on demande l'avis du serveur.
    if (!known) {
      if (isOnline() && getToken()) {
        try {
          // peek : on regarde sans consommer. La consommation n'aura lieu
          // qu'apres confirmation visuelle par le controleur.
          const result = await api("/api/admin/verify-code", {
            method: "POST",
            body: JSON.stringify({ code, peek: true }),
          });
          if (result.status === "valid") {
            // ATTENTION : le serveur a DEJA marque le code utilise en
            // repondant "valid". Un refus ici ne peut donc plus l'annuler
            // localement ; on le signale au controleur plutot que de le
            // laisser croire que le billet reste valable.
            await demanderIdentite({
              code,
              known: {
                nom: result.participant.nom,
                photo: result.participant.participant_photo_url || "",
              },
              meta: [result.participant.montant, result.participant.lieu_retrait],
              onConfirm: async () => {
                // C'est ici seulement que le code est reellement consomme,
                // cote serveur comme en local.
                await api("/api/admin/verify-code", {
                  method: "POST",
                  body: JSON.stringify({ code }),
                }).catch(() => { /* la file de synchro rattrapera */ });
                await ScanStore.consume(code, { origin: "local" });
                await ScanStore.clearFromQueue([code]); // deja applique cote serveur
                beep(true);
                buzz(60);
                current = { code, items: {} };
                showVerdict("ok", "Accès autorisé", "Vérifié en ligne", {
                  nom: result.participant.nom,
                  code,
                  montant: result.participant.montant,
                  lieu_retrait: result.participant.lieu_retrait,
                });
                await paintStats();
              },
            });
            return;
          }
          if (result.status === "already_used") {
            beep(false);
            buzz([80, 50, 80]);
            showVerdict("used", "Code déjà utilisé", "Ce billet a déjà servi", {
              nom: result.participant.nom,
              code,
            });
            return;
          }
        } catch (error) {
          if (error.message === "SESSION") {
            askPassword();
            return;
          }
          /* serveur injoignable : on retombe sur le verdict local */
        }
      }

      beep(false);
      buzz([120, 60, 120]);
      showVerdict(
        "ko",
        "Code inconnu",
        isOnline() ? "Introuvable" : "Absent de la base locale",
        { nom: "—", code },
        isOnline()
          ? "Ce code ne correspond à aucun billet validé."
          : "Ce téléphone est <b>hors-ligne</b> et ce code n'est pas dans la base locale. Il peut s'agir d'une inscription plus récente que la dernière mise à jour — reconnecte-toi puis mets la base à jour avant de refuser la personne.",
      );
      return;
    }

    // Verification d'identite AVANT toute consommation.
    await demanderIdentite({
      code,
      known,
      meta: [known.montant, known.lieu_retrait],
      onConfirm: () => finaliserEntree(code, known),
    });
  }

  /* Consomme le code et affiche le verdict. Appelee uniquement apres que le
     controleur a confirme que la personne est bien la bonne. */
  async function finaliserEntree(code, known) {
    // Le registre local tranche : une seule consommation possible, jamais deux.
    const outcome = await ScanStore.consume(code, { items: {} });

    if (!outcome.accepted) {
      const previous = outcome.previous || {};
      const origin =
        previous.origin === "serveur"
          ? "Déjà marqué utilisé sur le serveur"
          : previous.origin === "conflit"
            ? "Déjà scanné sur un autre poste"
            : `Déjà scanné sur ce poste ${timeAgo(previous.scanned_at)}`;

      beep(false);
      buzz([80, 50, 80]);
      showVerdict("used", "Code déjà utilisé", origin, { nom: known.nom, code, montant: known.montant });
      return;
    }

    beep(true);
    buzz(60);
    current = { code, items: {} };
    showVerdict("ok", "Accès autorisé", isOnline() ? "Validé" : "Validé hors-ligne", {
      nom: known.nom,
      code,
      montant: known.montant,
      lieu_retrait: known.lieu_retrait,
    });

    await paintStats();
    majEtatPhotos();
    if (isOnline()) syncQueue(true);
  }

  /* ---------------- Caméra ---------------- */

  function showCamMessage(message) {
    $("camMsgTxt").innerHTML = message;
    $("camMsg").classList.add("show");
  }

  async function startCamera() {
    $("camMsg").classList.remove("show");

    scanner = QrScanner.createScanner({
      video: $("video"),
      onResult: handleCode,
      onError: (error) => showCamMessage(escapeHtml(error.message)),
    });

    await scanner.start();

    if (scanner.isRunning()) {
      $("hint").textContent = "Place le QR code dans le cadre";
      const hasTorch = await scanner.toggleTorch(false);
      $("torchBtn").style.display = hasTorch ? "grid" : "none";
    }
  }

  /* ---------------- Mot de passe ---------------- */

  // Lien d'acces de l'agent : https://…/scan.html#acces=<jeton>. Accepte aussi
  // le lien colle tel quel dans l'app installee (sur iPhone, l'app de l'ecran
  // d'accueil ne voit pas ce qui a ete ouvert dans Safari).
  function jetonDepuisLien(texte) {
    const valeur = String(texte || "").trim();
    const trouve = /[#&?]acces=([A-Za-z0-9_-]{20,200})/.exec(valeur);
    return trouve ? trouve[1] : "";
  }

  // Echeance de l'acces de 24 h, pour la rappeler a l'agent.
  const EXPIRE_KEY = "adja_scan_expire";
  function heureFin(ms) {
    return new Date(ms).toLocaleString("fr-FR", { weekday: "long", hour: "2-digit", minute: "2-digit" });
  }

  function askPassword(jetonRecu) {
    if (document.getElementById("pwOverlay")) return;

    // Un acces de 24 h qui vient d'expirer : on le dit, plutot que de
    // reposer la question sans explication.
    const expire = Number(localStorage.getItem(EXPIRE_KEY) || 0);
    const accesExpire = !jetonRecu && expire && expire < Date.now();
    if (accesExpire) localStorage.removeItem(EXPIRE_KEY);

    const overlay = document.createElement("div");
    overlay.id = "pwOverlay";
    overlay.className = "modal show";
    overlay.innerHTML = `
      <div class="box">
        <h3>${jetonRecu ? "Accès agent de scan" : "Connexion"}</h3>
        <p class="gsub">${jetonRecu
          ? "Saisis le mot de passe reçu avec ton lien d'accès."
          : accesExpire
            ? "Ton accès de 24 h a expiré. Demande un nouveau lien à l'organisation, puis ouvre-le ou colle-le ci-dessous."
            : "Ouvre le lien d'accès reçu de l'organisation, ou colle-le ci-dessous avec son mot de passe."}</p>
        <div class="f" id="pwLienBloc" ${jetonRecu ? 'style="display:none"' : ""}>
          <label>Lien d'accès reçu</label>
          <input class="in" id="pwLien" type="url" placeholder="https://…/scan.html#acces=…" autocomplete="off">
        </div>
        <div class="f">
          <label>Mot de passe</label>
          <input class="in" id="pwIn" type="password" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX">
        </div>
        <div id="pwErr" class="gsub" style="color:var(--ko);display:none"></div>
        <button class="btn btn-gold" id="pwGo" style="width:100%">Se connecter</button>
        <button class="btn btn-ghost" id="pwSkip" style="width:100%;margin-top:8px">Continuer hors-ligne</button>
      </div>`;
    document.body.appendChild(overlay);

    const submit = async () => {
      const password = document.getElementById("pwIn").value;
      const jeton = jetonRecu || jetonDepuisLien(document.getElementById("pwLien").value);
      const error = document.getElementById("pwErr");
      try {
        // Avec un lien : acces d'agent (24 h). Sans lien : mot de passe des
        // postes de scan ou de l'administrateur, comme avant.
        const response = jeton
          ? await fetch("/api/scan/acces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jeton, mot_de_passe: password }),
          })
          : await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Échec");
        setToken(data.token);
        if (data.expire_le) {
          localStorage.setItem(EXPIRE_KEY, String(data.expire_le));
          toast(`Accès valable jusqu'à ${heureFin(data.expire_le)}`);
        } else {
          localStorage.removeItem(EXPIRE_KEY);
        }
        overlay.remove();
        await refreshSnapshot(false);
        await syncQueue(true);
        if (jeton) proposerInstallation(jeton);
      } catch (err) {
        error.textContent = err.message;
        error.style.display = "block";
      }
    };

    document.getElementById("pwGo").addEventListener("click", submit);
    document.getElementById("pwIn").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    document.getElementById("pwSkip").addEventListener("click", () => overlay.remove());
  }

  // Exposee uniquement pour les tests automatises : le module reste ferme,
  // aucune donnee ni aucun etat interne n'est accessible depuis l'exterieur.
  // `window` et non `global` : ce module est enveloppe dans une fonction SANS
  // parametre, `global` n'y existe pas et levait une ReferenceError qui
  // interrompait le reste du fichier, boot() compris.
  window.__scanHandleCode = handleCode;

  /* ---------------- Saisie manuelle ---------------- */

  function askCode() {
    const value = prompt("Code du participant :");
    if (value) handleCode(value.trim().toUpperCase());
  }

  /* ---------------- Installation de l'app ---------------- */

  // Le navigateur n'emet beforeinstallprompt que si l'app est installable
  // (HTTPS + service worker + manifest). On garde l'evenement pour declencher
  // l'installation au clic sur le bouton des reglages.
  let installPrompt = null;
  function setupInstall() {
    const button = $("installBtn");
    if (!button) return;

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      button.style.display = "block";
    });

    button.addEventListener("click", async () => {
      if (!installPrompt) {
        toast("Ouvre le menu du navigateur puis « Installer l'application »");
        return;
      }
      installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      installPrompt = null;
      if (choice.outcome === "accepted") {
        button.style.display = "none";
        toast("Application installée");
      }
    });

    window.addEventListener("appinstalled", () => {
      button.style.display = "none";
    });
  }

  // Apres l'ouverture d'un lien d'acces, on recommande d'installer l'app sur
  // l'ecran d'accueil : elle s'ouvre en un geste, en plein ecran, et l'agent
  // ne la perd pas au milieu de ses onglets le jour J.
  function estInstallee() {
    return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  }
  function estIphone() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function proposerInstallation(jeton) {
    if (estInstallee() || document.getElementById("installOverlay")) return;
    const lien = `${location.origin}/scan.html#acces=${jeton}`;
    const iphone = estIphone();
    const boutonInstaller = !iphone && installPrompt;

    const overlay = document.createElement("div");
    overlay.id = "installOverlay";
    overlay.className = "modal show";
    // Sur iPhone, l'app de l'ecran d'accueil ne partage pas la connexion
    // faite dans Safari : il faut y recoller le lien. Sur Android, la
    // connexion est partagee, rien a refaire.
    overlay.innerHTML = `
      <div class="box">
        <h3>Installe l'app de scan</h3>
        <p class="gsub">Ajoute-la à l'écran d'accueil de ton téléphone : elle s'ouvre en un geste, en plein écran, et continue de marcher si le réseau tombe à l'entrée.</p>
        ${iphone ? `
          <ol class="gsub install-etapes">
            <li>En bas de Safari, touche <b>Partager</b> (le carré avec une flèche vers le haut).</li>
            <li>Choisis <b>« Sur l'écran d'accueil »</b>, puis <b>Ajouter</b>.</li>
            <li>Ouvre l'app depuis l'écran d'accueil, colle ton lien (bouton ci-dessous) et ton mot de passe.</li>
          </ol>
          <button class="btn btn-gold" id="installCopier" style="width:100%;margin-bottom:8px">Copier mon lien d'accès</button>`
        : boutonInstaller ? "" : `
          <ol class="gsub install-etapes">
            <li>Ouvre le menu du navigateur (<b>⋮</b> en haut à droite).</li>
            <li>Choisis <b>« Installer l'application »</b> ou <b>« Ajouter à l'écran d'accueil »</b>.</li>
          </ol>`}
        ${boutonInstaller ? '<button class="btn btn-gold" id="installGo" style="width:100%;margin-bottom:8px">Installer l\'app</button>' : ""}
        <button class="btn btn-ghost" id="installPlusTard" style="width:100%">Plus tard</button>
      </div>`;
    document.body.appendChild(overlay);

    const fermer = () => overlay.remove();
    $("installPlusTard").addEventListener("click", fermer);
    const installer = $("installGo");
    if (installer) {
      installer.addEventListener("click", async () => {
        installPrompt.prompt();
        const choix = await installPrompt.userChoice;
        installPrompt = null;
        if (choix.outcome === "accepted") toast("Application installée");
        fermer();
      });
    }
    const copier = $("installCopier");
    if (copier) {
      copier.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(lien);
          toast("Lien copié : colle-le dans l'app installée");
        } catch {
          prompt("Copie ce lien :", lien);
        }
      });
    }
  }

  /* ---------------- Démarrage ---------------- */

  /* Avertissement d'origine non securisee.
   *
   * Sur http://192.168.x.x (ou toute IP locale), le navigateur ne fournit ni
   * navigator.mediaDevices ni les service workers. Concretement : la camera
   * ne s'ouvrira JAMAIS, et le mode hors-ligne ne peut pas s'installer. Ce
   * n'est pas une panne de l'appareil, c'est une regle de securite du
   * navigateur, et rien dans l'interface ne le disait.
   *
   * On le dit donc des l'ouverture, avant que l'agent ne cherche ailleurs.
   */
  function warnInsecureContext() {
    if (window.isSecureContext) return;

    const banner = document.createElement("div");
    banner.id = "insecure-warn";
    banner.innerHTML =
      "<b>Caméra indisponible sur cette adresse</b>" +
      "Le navigateur n'autorise la caméra et le mode hors-ligne que sur une adresse " +
      "<b>https://</b>. Sur <b>" + escapeHtml(location.host) + "</b> ils sont bloqués. " +
      "La saisie manuelle du code reste utilisable.";
    banner.style.cssText = [
      "position:sticky", "top:0", "z-index:900",
      "background:#8a2b12", "color:#fff",
      "font:400 .78rem/1.5 system-ui,sans-serif",
      "padding:10px 14px", "text-align:left",
    ].join(";");
    banner.querySelectorAll("b").forEach((el) => { el.style.fontWeight = "800"; });
    banner.firstChild.style.display = "block";
    banner.firstChild.style.marginBottom = "3px";
    document.body.prepend(banner);
  }

  async function boot() {
    warnInsecureContext();
    paintNetwork();

    const deviceId = await ScanStore.getDeviceId();
    const label = await ScanStore.getDeviceLabel();
    $("devIdOut").textContent = deviceId;
    $("devLabelIn").value = label;
    $("devLabel").textContent = label || "Poste non nommé";

    await paintStats();
    majEtatPhotos();

    // Branding : appliqué depuis le cache si hors-ligne.
    fetch("/api/public-config")
      .then((response) => response.json())
      .then((config) => {
        if (config.logoUrl) $("brandLogo").src = config.logoUrl;
        if (config.eventName) $("evName").textContent = config.eventName;
      })
      .catch(() => {});

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    setupInstall();

    // Ouvert par un lien d'acces d'agent : le jeton est retire tout de suite
    // de la barre d'adresse (une capture d'ecran ou un partage ne le
    // montrerait plus), puis on demande le mot de passe qui l'accompagne.
    const jetonLien = jetonDepuisLien(location.hash);
    if (jetonLien) history.replaceState(null, "", location.pathname + location.search);

    if (jetonLien) {
      askPassword(jetonLien);
    } else if (!getToken()) {
      askPassword();
    } else {
      await refreshSnapshot(true);
      await syncQueue(true);
    }

    startCamera();
  }

  /* ---------------- Événements ---------------- */

  $("closeSheet").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (event) => {
    if (event.target === $("sheet")) closeSheet();
  });

  $("scanBtn").addEventListener("click", () => {
    closeSheet();
    if (!scanner || !scanner.isRunning()) startCamera();
  });

  $("syncBtn").addEventListener("click", async () => {
    await refreshSnapshot(false);
    await syncQueue(false);
  });

  $("camRetry").addEventListener("click", startCamera);
  $("typeBtn").addEventListener("click", askCode);

  $("torchBtn").addEventListener("click", async () => {
    torchOn = !torchOn;
    const ok = await scanner.toggleTorch(torchOn);
    if (ok) $("torchBtn").classList.toggle("on", torchOn);
    else torchOn = false;
  });

  $("openSettings").addEventListener("click", () => $("settings").classList.add("show"));
  $("closeSettings").addEventListener("click", () => $("settings").classList.remove("show"));
  $("refreshBtn").addEventListener("click", () => refreshSnapshot(false));

  $("devLabelIn").addEventListener("change", async (event) => {
    const label = event.target.value.trim();
    await ScanStore.setDeviceLabel(label);
    $("devLabel").textContent = label || "Poste non nommé";
    toast("Nom du poste enregistré");
  });

  $("wipeBtn").addEventListener("click", async () => {
    const queue = await ScanStore.getQueue();
    const message = queue.length
      ? `${queue.length} scan(s) ne sont pas encore synchronisés et seront PERDUS. Effacer quand même ?`
      : "Effacer la base locale et le registre anti-double-scan de ce téléphone ?";
    if (!confirm(message)) return;
    await ScanStore.wipe();
    await paintStats();
    toast("Données locales effacées");
  });

  window.addEventListener("online", () => {
    paintNetwork();
    toast("Réseau retrouvé — synchronisation…");
    syncQueue(true).then(() => refreshSnapshot(true));
  });

  window.addEventListener("offline", () => {
    paintNetwork();
    toast("Hors-ligne — les scans sont mis en attente");
  });

  // La camera est coupee en arriere-plan (batterie) et relancee au retour.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && scanner) scanner.stop();
    else if (!document.hidden && scanner && !scanner.isRunning() && !$("sheet").classList.contains("show")) startCamera();
  });

  boot();
})();
