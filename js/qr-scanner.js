/* Scanner QR reutilisable (app de scan + onglet Verifier de l'admin).
 *
 * Utilise BarcodeDetector quand le navigateur le fournit (Chrome/Android :
 * decodage natif, tres rapide) et retombe sinon sur jsQR, servi en local
 * depuis /js/vendor/jsqr.js — jamais depuis un CDN, sinon le scan casserait
 * des qu'il n'y a plus de reseau.
 */

(function (global) {
  const JSQR_URL = "/js/vendor/jsqr.js";
  let jsqrLoading = null;

  function loadJsQr() {
    if (global.jsQR) return Promise.resolve(true);
    if (jsqrLoading) return jsqrLoading;

    jsqrLoading = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = JSQR_URL;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });

    return jsqrLoading;
  }

  function createScanner(options) {
    const video = options.video;
    const onResult = options.onResult;
    const onError = options.onError || (() => {});
    const cooldownMs = options.cooldownMs || 1500;

    let stream = null;
    let rafId = null;
    let detector = null;
    let canvas = null;
    let context = null;
    let running = false;
    let lastValue = "";
    let lastAt = 0;

    function emit(raw) {
      const value = String(raw || "").trim();
      if (!value) return;

      // Anti-rebond : la camera relit le meme QR 30x par seconde tant qu'il
      // est dans le cadre. Sans ca on declencherait des dizaines de scans.
      const now = Date.now();
      if (value === lastValue && now - lastAt < cooldownMs) return;
      lastValue = value;
      lastAt = now;

      onResult(value);
    }

    async function tick() {
      if (!running) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes && codes.length) emit(codes[0].rawValue);
          } else if (global.jsQR) {
            const width = video.videoWidth;
            const height = video.videoHeight;

            if (width && height) {
              // On decode une image reduite : plus rapide, et suffisant pour
              // un QR tenu dans le cadre.
              const scale = Math.min(1, 640 / Math.max(width, height));
              canvas.width = Math.round(width * scale);
              canvas.height = Math.round(height * scale);
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const image = context.getImageData(0, 0, canvas.width, canvas.height);
              const found = global.jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
              if (found) emit(found.data);
            }
          }
        } catch (error) {
          /* une frame illisible ne doit pas arreter la boucle */
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    async function start() {
      if (running) return;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        onError(new Error("La camera n'est pas disponible sur cet appareil."));
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (error) {
        const message =
          error && error.name === "NotAllowedError"
            ? "Acces a la camera refuse. Autorise-le dans les reglages du navigateur."
            : "Impossible d'ouvrir la camera.";
        onError(new Error(message));
        return;
      }

      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play().catch(() => {});

      detector = null;
      if ("BarcodeDetector" in global) {
        try {
          const formats = await global.BarcodeDetector.getSupportedFormats();
          if (formats.includes("qr_code")) detector = new global.BarcodeDetector({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }

      if (!detector) {
        const ok = await loadJsQr();
        if (!ok) {
          onError(new Error("Moteur de lecture QR indisponible."));
          stop();
          return;
        }
        canvas = document.createElement("canvas");
        context = canvas.getContext("2d", { willReadFrequently: true });
      }

      running = true;
      tick();
    }

    function stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video) video.srcObject = null;
    }

    function resetCooldown() {
      lastValue = "";
      lastAt = 0;
    }

    async function toggleTorch(on) {
      if (!stream) return false;
      const track = stream.getVideoTracks()[0];
      if (!track) return false;
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      if (!capabilities.torch) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: !!on }] });
        return true;
      } catch {
        return false;
      }
    }

    return { start, stop, resetCooldown, toggleTorch, isRunning: () => running };
  }

  // Le QR peut contenir le code brut ou une URL du type .../verification.html?code=XXX
  function extractCode(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";

    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        const fromQuery = url.searchParams.get("code") || url.searchParams.get("c");
        if (fromQuery) return fromQuery.trim().toUpperCase();
        const last = url.pathname.split("/").filter(Boolean).pop();
        if (last) return last.trim().toUpperCase();
      } catch {
        /* URL malformee : on retombe sur la valeur brute */
      }
    }

    return value.toUpperCase();
  }

  global.QrScanner = { createScanner, extractCode, loadJsQr };
})(window);
