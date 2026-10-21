// _lib/backends.js — upstream fetch helpers shared by every endpoint (t129).
//
// Fallback chain philosophy ("must not be affected by anilist api goes down"):
//   1. AniList GraphQL        — richest data, tried FIRST on every request so
//                               the endpoints auto-flip back to AniList the
//                               moment it recovers.
//   2. Supabase anikoto_data  — the owner's own DB (profile "ruristream"),
//                               pre-cached AniList-style JSON blobs written by
//                               the anikoto-automation worker. Fully independent
//                               of AniList's health.
//   3. Jikan (self-hosted → api.jikan.moe) — last resort, MAL-based.

const ANILIST_URL = "https://graphql.anilist.co";
const SUPABASE_URL = "https://uhjucwqiadymmogmwkxc.supabase.co/rest/v1";
const SUPABASE_KEY = "sb_publishable_gfCCFMcqyR3fWo0cbUfVqg_OrzqCeBu";
const JIKAN_SELF = "https://jikan-api-bohb.onrender.com/v4";
const JIKAN_PUBLIC = "https://api.jikan.moe/v4";
const UA = "anilist-scraper/2.1 (+vercel; t129 fallback chain)";

function fetchWithTimeout(url, init = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** POST to AniList GraphQL. Resolves the whole JSON, throws on !ok / errors[]. */
async function anilistQuery(query, variables) {
  const r = await fetchWithTimeout(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables }),
  }, 12000);
  let j;
  try { j = await r.json(); } catch { throw new Error(`AniList bad JSON (HTTP ${r.status})`); }
  if (!r.ok || (j.errors && j.errors.length)) {
    throw new Error((j.errors && j.errors[0]?.message) || `AniList HTTP ${r.status}`);
  }
  if (!j.data) throw new Error("AniList empty data");
  return j.data;
}

/** GET Supabase PostgREST. Returns parsed JSON (array or object), throws on !ok. */
async function supabaseSelect(queryString) {
  const r = await fetchWithTimeout(`${SUPABASE_URL}/anikoto_data?${queryString}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: "application/json" },
  }, 12000);
  const j = await r.json();
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${(j && j.message) || "unknown"}`);
  return j;
}

/**
 * GET Jikan v4 — self-hosted instance first (no rate limit), then the public
 * api.jikan.moe as the second leg. Resolves the parsed body (already the full
 * jikan envelope), throws only if BOTH legs fail.
 */
async function jikanFetch(path, ms = 9000) {
  const legs = [`${JIKAN_SELF}${path}`, `${JIKAN_PUBLIC}${path}`];
  let lastErr = null;
  for (const url of legs) {
    try {
      const r = await fetchWithTimeout(url, { headers: { Accept: "application/json", "User-Agent": UA } }, ms);
      if (!r.ok) { lastErr = new Error(`Jikan HTTP ${r.status} (${url.includes("onrender") ? "self" : "public"})`); continue; }
      const j = await r.json();
      // Jikan error payloads can arrive with HTTP 200-style wrappers — validate
      if (j && (j.error || j.status === 400 || j.status === 500)) {
        lastErr = new Error(`Jikan body error (${url.includes("onrender") ? "self" : "public"})`);
        continue;
      }
      return j;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Jikan unreachable");
}

module.exports = { anilistQuery, supabaseSelect, jikanFetch, fetchWithTimeout };
