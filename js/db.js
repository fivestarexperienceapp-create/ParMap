// Tiny key-value persistence layer.
// Primary: IndexedDB (large quota, stores scorecard photos).
// Fallback: localStorage (private modes / old browsers), then memory.

const DB_NAME = 'parmap';
const STORE = 'kv';
const LS_PREFIX = 'parmap:';

let backend = 'memory';
let dbPromise = null;
const mem = new Map();

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

function idb(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  }));
}

function lsAvailable() {
  try {
    localStorage.setItem(LS_PREFIX + '__t', '1');
    localStorage.removeItem(LS_PREFIX + '__t');
    return true;
  } catch { return false; }
}

export async function initDB() {
  try {
    await Promise.race([openDB(), new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB timeout')), 4000))]);
    backend = 'indexeddb';
  } catch (e) {
    console.warn('[ParMap] IndexedDB unavailable, falling back:', e?.message);
    backend = lsAvailable() ? 'localstorage' : 'memory';
  }
  return backend;
}

export const kv = {
  get backend() { return backend; },

  async get(key) {
    if (backend === 'indexeddb') return idb('readonly', (s) => s.get(key));
    if (backend === 'localstorage') {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v == null ? undefined : JSON.parse(v);
    }
    return mem.get(key);
  },

  async set(key, value) {
    if (backend === 'indexeddb') return idb('readwrite', (s) => s.put(value, key));
    if (backend === 'localstorage') {
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      } catch (e) {
        throw new Error('Device storage is full. Export a backup and remove old data.', { cause: e });
      }
      return;
    }
    mem.set(key, value);
  },

  async del(key) {
    if (backend === 'indexeddb') return idb('readwrite', (s) => s.delete(key));
    if (backend === 'localstorage') { localStorage.removeItem(LS_PREFIX + key); return; }
    mem.delete(key);
  },

  async keys() {
    if (backend === 'indexeddb') return idb('readonly', (s) => s.getAllKeys());
    if (backend === 'localstorage') {
      return Object.keys(localStorage).filter((k) => k.startsWith(LS_PREFIX)).map((k) => k.slice(LS_PREFIX.length));
    }
    return [...mem.keys()];
  },

  // Photos only go to IndexedDB; localStorage is too small for them.
  get supportsBlobs() { return backend === 'indexeddb'; },
};

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage, quota: e.quota } : null;
  } catch { return null; }
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch { return false; }
}
