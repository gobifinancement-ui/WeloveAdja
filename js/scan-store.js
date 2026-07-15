/* Magasin local de l'app de scan (IndexedDB).
 *
 * C'est la piece qui garantit qu'un meme QR code ne peut pas etre accepte
 * deux fois sur ce telephone, meme sans reseau et meme apres redemarrage :
 *  - `codes`   : instantane des codes valides telecharge quand il y a du reseau
 *  - `ledger`  : registre des codes deja consommes SUR CET APPAREIL. Il est
 *                ecrit AVANT d'afficher le resultat, donc un rescan retombe
 *                dessus meme si l'app est tuee entre-temps.
 *  - `queue`   : scans en attente de remontee au serveur
 *
 * Limite assumee : deux telephones hors-ligne en meme temps ne peuvent pas se
 * voir. Le serveur tranche a la synchro et renvoie un "conflict".
 */

(function (global) {
  const DB_NAME = "adja-scan";
  const DB_VERSION = 1;
  const STORES = { codes: "codes", ledger: "ledger", queue: "queue", meta: "meta" };

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.codes)) db.createObjectStore(STORES.codes, { keyPath: "code" });
        if (!db.objectStoreNames.contains(STORES.ledger)) db.createObjectStore(STORES.ledger, { keyPath: "code" });
        if (!db.objectStoreNames.contains(STORES.queue)) db.createObjectStore(STORES.queue, { keyPath: "code" });
        if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: "key" });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  async function tx(storeName, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try {
        result = run(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function get(storeName, key) {
    const db = await openDb();
    return reqToPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
  }

  async function setMeta(key, value) {
    return tx(STORES.meta, "readwrite", (store) => store.put({ key, value }));
  }

  async function getMeta(key) {
    const row = await get(STORES.meta, key);
    return row ? row.value : null;
  }

  /* ---------- Identite de l'appareil ---------- */

  async function getDeviceId() {
    let id = await getMeta("device_id");
    if (!id) {
      id = `dev_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
      await setMeta("device_id", id);
    }
    return id;
  }

  async function getDeviceLabel() {
    return (await getMeta("device_label")) || "";
  }

  async function setDeviceLabel(label) {
    await setMeta("device_label", String(label || "").trim());
  }

  /* ---------- Instantane ---------- */

  // Remplace l'instantane. Les codes deja marques "utilise" cote serveur sont
  // reportes dans le registre local : un code consomme sur un autre poste est
  // donc refuse ici des la premiere synchro.
  async function replaceSnapshot(snapshot) {
    const db = await openDb();
    const codes = Array.isArray(snapshot.codes) ? snapshot.codes : [];

    await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.codes, STORES.ledger], "readwrite");
      const codeStore = transaction.objectStore(STORES.codes);
      const ledgerStore = transaction.objectStore(STORES.ledger);

      codeStore.clear();
      codes.forEach((entry) => {
        codeStore.put(entry);
        if (entry.used) {
          ledgerStore.put({
            code: entry.code,
            scanned_at: entry.used_at || Date.now(),
            origin: "serveur",
          });
        }
      });

      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });

    await setMeta("snapshot_version", snapshot.version || Date.now());
    await setMeta("snapshot_at", Date.now());
    await setMeta("event_items", snapshot.event_items || []);
    await setMeta("event_name", snapshot.event_name || "");
  }

  async function getSnapshotInfo() {
    const codes = await getAll(STORES.codes);
    return {
      count: codes.length,
      version: await getMeta("snapshot_version"),
      at: await getMeta("snapshot_at"),
      eventItems: (await getMeta("event_items")) || [],
      eventName: (await getMeta("event_name")) || "",
    };
  }

  async function lookup(code) {
    return get(STORES.codes, String(code || "").toUpperCase());
  }

  /* ---------- Registre anti-double-scan ---------- */

  async function isConsumed(code) {
    const row = await get(STORES.ledger, String(code || "").toUpperCase());
    return row || null;
  }

  // Consomme un code de facon atomique : si une entree existe deja, on ne
  // l'ecrase pas et on signale le doublon. Tout se joue dans UNE transaction
  // pour qu'un double scan rapide ne puisse pas passer deux fois.
  async function consume(code, extra) {
    const key = String(code || "").toUpperCase();
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.ledger, STORES.queue], "readwrite");
      const ledger = transaction.objectStore(STORES.ledger);
      const queue = transaction.objectStore(STORES.queue);
      let outcome = null;

      const existing = ledger.get(key);
      existing.onsuccess = () => {
        if (existing.result) {
          outcome = { accepted: false, previous: existing.result };
          return;
        }

        const entry = {
          code: key,
          scanned_at: Date.now(),
          origin: "local",
          ...(extra || {}),
        };
        ledger.put(entry);
        queue.put(entry);
        outcome = { accepted: true, entry };
      };

      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  /* ---------- File de synchro ---------- */

  async function getQueue() {
    return getAll(STORES.queue);
  }

  // Met a jour les items d'un scan deja en file, sans toucher au registre :
  // le code reste consomme, seule la checklist evolue.
  async function updateQueueItems(code, items) {
    const key = String(code).toUpperCase();
    const existing = (await get(STORES.queue, key)) || { code: key, scanned_at: Date.now(), origin: "local" };
    return tx(STORES.queue, "readwrite", (store) => store.put({ ...existing, items }));
  }

  async function clearFromQueue(codes) {
    const keys = codes.map((code) => String(code).toUpperCase());
    return tx(STORES.queue, "readwrite", (store) => keys.forEach((key) => store.delete(key)));
  }

  async function markConflict(code, info) {
    return tx(STORES.ledger, "readwrite", (store) =>
      store.put({
        code: String(code).toUpperCase(),
        scanned_at: Date.now(),
        origin: "conflit",
        conflict: info || true,
      }),
    );
  }

  async function countLedger() {
    const rows = await getAll(STORES.ledger);
    return rows.filter((row) => row.origin === "local").length;
  }

  async function wipe() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(Object.values(STORES), "readwrite");
      Object.values(STORES).forEach((name) => {
        if (name !== STORES.meta) transaction.objectStore(name).clear();
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  global.ScanStore = {
    getDeviceId,
    getDeviceLabel,
    setDeviceLabel,
    replaceSnapshot,
    getSnapshotInfo,
    lookup,
    isConsumed,
    consume,
    getQueue,
    updateQueueItems,
    clearFromQueue,
    markConflict,
    countLedger,
    wipe,
  };
})(window);
