// Shared in-memory IndexedDB double for isolated tests (same as scripts/test-production-records.mjs). Never touches a real browser database.
export const databases = new Map();
// Small IndexedDB transaction double: records are cloned just like browser IDB.

globalThis.indexedDB = {
  open(name, version) {
    const request = {};
    queueMicrotask(() => {
      let db = databases.get(name);
      const fresh = !db;
      if (!db) {
        const stores = new Map();
        db = {
          version,
          objectStoreNames: { contains: (key) => stores.has(key) },
          close() {},
          createObjectStore(key, options) {
            const state = { keyPath: options.keyPath, data: new Map(), indexes: new Map() };
            stores.set(key, state);
            return { createIndex: (indexName, field, opts) => state.indexes.set(indexName, { field, unique: opts.unique }) };
          },
          transaction() {
            const tx = { pending: 0, error: null, addEventListener(){}, abort() { queueMicrotask(() => tx.onabort?.()); }, objectStore(key) { const state = stores.get(key); return {
              get(id) { return act(() => state.data.get(id)); },
              getAll() { return act(() => [...state.data.values()]); },
              add(value) { return act(() => { if (state.data.has(value[state.keyPath])) throw new Error("duplicate key"); state.data.set(value[state.keyPath], structuredClone(value)); }); },
              delete(id) { return act(() => state.data.delete(id)); },
              clear() { return act(() => state.data.clear()); },
              count() { return act(() => state.data.size); },
              put(value) { return act(() => { for (const index of state.indexes.values()) if (index.unique && [...state.data.values()].some((item) => item[index.field] === value[index.field] && item[state.keyPath] !== value[state.keyPath])) throw new Error("duplicate index"); state.data.set(value[state.keyPath], structuredClone(value)); }); },
              index(indexName) { return { get(value) { return act(() => [...state.data.values()].find((item) => item[state.indexes.get(indexName).field] === value)); } }; },
            }; } };
            function act(fn) { const listeners={};const req = {transaction:tx,addEventListener(name,fn){(listeners[name]??=[]).push(fn);}}; tx.pending++; queueMicrotask(() => { try { req.result = structuredClone(fn()); req.onsuccess?.();for(const fn of listeners.success??[])fn(); } catch (error) { tx.error = error; req.error = error; req.onerror?.();for(const fn of listeners.error??[])fn(); tx.onerror?.(); return; } if (--tx.pending === 0) queueMicrotask(() => tx.oncomplete?.()); }); return req; }
            return tx;
          },
        };
        databases.set(name, db);
      }
      request.result = db;
      if (fresh || version > db.version) { request.onupgradeneeded?.(); db.version = version; }
      request.onsuccess?.();
    });
    return request;
  },
};
