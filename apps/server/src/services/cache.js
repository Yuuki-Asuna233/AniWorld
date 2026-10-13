// Cache module - in-memory TTL cache with request de-duplication.

const CACHE_VERSION = 2;
const DEFAULT_TTL = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

const cache = Object.create(null);
const bridgeCache = Object.create(null);
const OI_SEARCH_CACHE = Object.create(null);
const pendingStores = new WeakMap();

function isFresh(entry, ttl) {
  return !!entry && Date.now() - entry.ts < (entry.ttl || ttl || DEFAULT_TTL);
}

function getCache(store, key, ttl = DEFAULT_TTL) {
  const entry = store[key];
  if (!isFresh(entry, ttl)) {
    if (entry) delete store[key];
    return null;
  }
  return entry.data;
}

function setCache(store, key, data, ttl = DEFAULT_TTL, meta = {}) {
  store[key] = { ...meta, ts: Date.now(), ttl, data };
  trimStore(store);
  return data;
}

function deleteCache(store, key) {
  delete store[key];
  pendingStores.get(store)?.delete(key);
}

async function getOrSetCache(store, key, ttl, producer, options = {}) {
  const { refresh = false, cacheWhen = () => true, ttlFor, ...meta } = options;
  if (refresh) deleteCache(store, key);
  const cached = getCache(store, key, ttl);
  if (cached !== null) return cached;

  let pending = pendingStores.get(store);
  if (!pending) pendingStores.set(store, pending = new Map());
  if (pending.has(key)) return pending.get(key);

  const task = Promise.resolve()
    .then(producer)
    .then(data => {
      // A refresh or invalidation may have superseded this producer.
      if (pending.get(key) === task && cacheWhen(data)) {
        setCache(store, key, data, ttlFor ? ttlFor(data) : ttl, meta);
      }
      return data;
    })
    .finally(() => { if (pending.get(key) === task) pending.delete(key); });
  pending.set(key, task);
  return task;
}

function trimStore(store) {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort((a, b) => (store[a]?.ts || 0) - (store[b]?.ts || 0))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach(k => delete store[k]);
}

function cleanupStore(store) {
  const now = Date.now();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || now - entry.ts > (entry.ttl || DEFAULT_TTL)) delete store[key];
  }
}

function getBridgeCache(key) {
  const vkey = 'v' + CACHE_VERSION + '_' + key;
  const data = getCache(bridgeCache, vkey, 60 * 60 * 1000);
  return data === null ? { found: false } : { found: true, data };
}

function setBridgeCache(key, data) {
  const vkey = 'v' + CACHE_VERSION + '_' + key;
  setCache(bridgeCache, vkey, data, 60 * 60 * 1000);
}

function getOiSearchCache(term) {
  const vkey = 'v' + CACHE_VERSION + '_' + term;
  const data = getCache(OI_SEARCH_CACHE, vkey, 30 * 60 * 1000);
  return data === null ? { found: false } : { found: true, data };
}

function setOiSearchCache(term, data) {
  const vkey = 'v' + CACHE_VERSION + '_' + term;
  setCache(OI_SEARCH_CACHE, vkey, data, 30 * 60 * 1000);
}

const cleanupTimer = setInterval(() => {
  cleanupStore(cache);
  cleanupStore(bridgeCache);
  cleanupStore(OI_SEARCH_CACHE);
}, CLEANUP_INTERVAL);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  cache,
  bridgeCache,
  OI_SEARCH_CACHE,
  getCache,
  deleteCache,
  setCache,
  getOrSetCache,
  getBridgeCache,
  setBridgeCache,
  getOiSearchCache,
  setOiSearchCache
};
