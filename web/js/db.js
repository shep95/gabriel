// thin indexeddb layer. one database, four stores, promise wrappers.
// every record except the profile is stored sealed (see crypto.js);
// this module never sees plaintext and never does anything clever.

const DB_NAME = 'gabriel';
const DB_VERSION = 2;
export const STORES = ['meta', 'devices', 'notes', 'seen', 'rooms', 'messages'];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      // messages are looked up per room; the room id is a local random value
      const tx = req.transaction;
      const messages = tx.objectStore('messages');
      if (!messages.indexNames.contains('room')) messages.createIndex('room', 'roomId', { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('indexeddb open failed'));
    req.onblocked = () => reject(new Error('indexeddb blocked by another tab'));
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error || new Error(`transaction failed on ${store}`));
    t.onabort = () => reject(t.error || new Error(`transaction aborted on ${store}`));
  });
}

export async function get(store, id) {
  const db = await openDb();
  return tx(db, store, 'readonly', (s) => s.get(id));
}

export async function put(store, record) {
  if (!record || typeof record.id !== 'string') throw new Error('record needs a string id');
  const db = await openDb();
  await tx(db, store, 'readwrite', (s) => s.put(record));
  return record;
}

export async function del(store, id) {
  const db = await openDb();
  await tx(db, store, 'readwrite', (s) => s.delete(id));
}

export async function all(store) {
  const db = await openDb();
  return tx(db, store, 'readonly', (s) => s.getAll());
}

export async function byIndex(store, index, value) {
  const db = await openDb();
  return tx(db, store, 'readonly', (s) => s.index(index).getAll(value));
}

export async function count(store) {
  const db = await openDb();
  return tx(db, store, 'readonly', (s) => s.count());
}

export async function clearAll() {
  const db = await openDb();
  for (const name of STORES) await tx(db, name, 'readwrite', (s) => s.clear());
}

// wipe drops the database itself, not just the rows, so nothing about the
// schema survives either. the caller must have closed the connection.
export function destroyDb() {
  return new Promise((resolve, reject) => {
    if (dbPromise) {
      dbPromise.then((db) => db.close()).catch(() => {});
      dbPromise = null;
    }
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('delete failed'));
    req.onblocked = () => resolve(); // the delete completes once other tabs close
  });
}

export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return { supported: false, persisted: false };
    const already = await navigator.storage.persisted();
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: granted };
  } catch {
    return { supported: false, persisted: false };
  }
}

export async function storageEstimate() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
