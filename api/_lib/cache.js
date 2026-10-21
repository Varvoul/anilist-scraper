// _lib/cache.js — exact-key TTL cache with serve-stale-on-error.
// Shared by every endpoint in this project (t129).
//
// Contract the owner asked for:
//   • TTL cache, and when a param/filter changes → different key →
//     automatic miss → fresh upstream fetch (exact-key semantics).
//   • When the upstream (AniList / Supabase / Jikan) is down, a stale
//     copy already in memory is served instead of an error (marked
//     `_stale: true`), so consumers keep rendering during outages.
//   • `?refresh=1` bypasses both the cache and the stale layer.
//
// The value stored is the full response body object. Callers build it
// once and cache it; `request_cached` / `_stale` flags are patched on
// read so the body always reflects how it was served.

const TTL_MS_DEFAULT = 5 * 60 * 1000; // 5 min — same rhythm as the original anime.js

const store = new Map(); // key -> { body, at }
const MAX_ENTRIES = 300; // tiny footprint guard (serverless instance memory)

/**
 * @param {string} key   exact serialized key (endpoint + sorted params)
 * @param {number} ttlMs cache TTL in ms
 * @param {object} opts  { fresh: bool } — true when ?refresh=1 bypass is requested
 * @returns {null | { body: object, state: 'HIT' | 'STALE' }}
 */
function lookup(key, ttlMs = TTL_MS_DEFAULT, opts = {}) {
  if (opts.fresh) {
    store.delete(key);
    return null;
  }
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at < ttlMs) {
    return { body: entry.body, state: "HIT" };
  }
  // expired → serve stale once (upstream may be down), then let caller refresh
  return { body: entry.body, state: "STALE" };
}

/** Store a successful body. Evicts oldest entries over the cap. */
function put(key, body, ttlMs = TTL_MS_DEFAULT) {
  void ttlMs; // TTL is applied at read time so it can be tuned without flush
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(key, { body, at: Date.now() });
}

module.exports = { lookup, put, TTL_MS_DEFAULT };
