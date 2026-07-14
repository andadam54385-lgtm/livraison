// Wrapper Promise minimal autour d'IndexedDB. Pas de dependance externe :
// l'API native suffit pour les besoins de l'app (quelques stores, requetes
// simples par cle/index).

export function openDatabase(name, version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => {
      onUpgrade(req.result, event.oldVersion, event.newVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Ouverture IndexedDB bloquee (autre onglet ouvert ?)"));
  });
}

export function tx(db, storeNames, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction IndexedDB annulee"));
    Promise.resolve(run(t)).then((r) => {
      result = r;
    }, reject);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(db, storeName, key) {
  return tx(db, [storeName], "readonly", (t) => reqToPromise(t.objectStore(storeName).get(key)));
}

export async function getAll(db, storeName) {
  return tx(db, [storeName], "readonly", (t) => reqToPromise(t.objectStore(storeName).getAll()));
}

export async function getAllFromIndex(db, storeName, indexName, query) {
  return tx(db, [storeName], "readonly", (t) =>
    reqToPromise(t.objectStore(storeName).index(indexName).getAll(query))
  );
}

export async function put(db, storeName, value) {
  return tx(db, [storeName], "readwrite", (t) => reqToPromise(t.objectStore(storeName).put(value)));
}

export async function del(db, storeName, key) {
  return tx(db, [storeName], "readwrite", (t) => reqToPromise(t.objectStore(storeName).delete(key)));
}

export async function clear(db, storeName) {
  return tx(db, [storeName], "readwrite", (t) => reqToPromise(t.objectStore(storeName).clear()));
}

export async function count(db, storeName) {
  return tx(db, [storeName], "readonly", (t) => reqToPromise(t.objectStore(storeName).count()));
}

// Insere un grand nombre d'enregistrements par lots successifs (transactions
// separees) pour laisser l'UI respirer entre deux lots et remonter une
// progression -- utile pour les ~45k entrees BAN au premier import.
export async function bulkPutChunked(db, storeName, values, chunkSize, onProgress) {
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    await tx(db, [storeName], "readwrite", (t) => {
      const store = t.objectStore(storeName);
      for (const value of chunk) store.put(value);
    });
    if (onProgress) onProgress(Math.min(i + chunkSize, values.length), values.length);
    // Laisse le thread principal traiter d'autres taches (rendu progress bar).
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
