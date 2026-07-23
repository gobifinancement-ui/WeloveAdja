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

  // Un bip synthetise : pas de fichier audio a charger, donc ca marche
  // hors-ligne des le premier scan.
  let audioContext = null;
  function beep(ok) {
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.frequency.value = ok ? 880 : 240;
      oscillator.type = ok ? "sine" : "square";
      gain.gain.setValueAtTime(0.14, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + (ok ? 0.16 : 0.32));
      oscillator.start();
      oscillator.stop(audioContext.currentTime + (ok ? 0.16 : 0.32));
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
          const result = await api("/api/admin/verify-code", {
            method: "POST",
            body: JSON.stringify({ code }),
          });
          if (result.status === "valid") {
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

  function askPassword() {
    if (document.getElementById("pwOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "pwOverlay";
    overlay.className = "modal show";
    overlay.innerHTML = `
      <div class="box">
        <h3>Connexion</h3>
        <p class="gsub">Saisis le mot de passe administrateur pour autoriser ce poste à télécharger la liste des codes.</p>
        <div class="f">
          <label>Mot de passe</label>
          <input class="in" id="pwIn" type="password" autocomplete="current-password">
        </div>
        <div id="pwErr" class="gsub" style="color:var(--ko);display:none"></div>
        <button class="btn btn-gold" id="pwGo" style="width:100%">Se connecter</button>
        <button class="btn btn-ghost" id="pwSkip" style="width:100%;margin-top:8px">Continuer hors-ligne</button>
      </div>`;
    document.body.appendChild(overlay);

    const submit = async () => {
      const password = document.getElementById("pwIn").value;
      const error = document.getElementById("pwErr");
      try {
        const response = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Échec");
        setToken(data.token);
        overlay.remove();
        await refreshSnapshot(false);
        await syncQueue(true);
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

  /* ---------------- Démarrage ---------------- */

  async function boot() {
    paintNetwork();

    const deviceId = await ScanStore.getDeviceId();
    const label = await ScanStore.getDeviceLabel();
    $("devIdOut").textContent = deviceId;
    $("devLabelIn").value = label;
    $("devLabel").textContent = label || "Poste non nommé";

    await paintStats();

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

    if (!getToken()) {
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
