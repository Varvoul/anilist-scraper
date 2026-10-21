// GET /api/v4/studios/{studio_name}   (alias: /v4/studio/{name} via rewrite)
//
// Jikan-v4-shaped studio listing with a 3-leg fallback chain (t129):
//   1. AniList GraphQL  — Studio(search) → media edges → jikan-v4 transform
//   2. Supabase         — anikoto_data.studios ilike match (owner's DB)
//   3. Jikan            — /anime?q={name} filtered by studios array
//
// Params: page (1), limit (<=25), sfw, type, min_score, max_score, isMain=true
//         (only shows where the studio is the MAIN animation studio)
// Cache:  exact-key 5-min TTL + s-maxage=300 + serve-stale-on-error; ?refresh=1.

const cache = require("../../_lib/cache");
const { jsonRes, cacheKey } = require("../../_lib/http");
const { anilistQuery, supabaseSelect, jikanFetch } = require("../../_lib/backends");
const { transformToV4Format, supabaseRowToV4, parseMaybeJsonStringArray } = require("../../_lib/transform");

const STUDIO_QUERY = `
query ($search: String, $page: Int, $perPage: Int, $sort: [MediaSort], $format: MediaFormat, $isAdult: Boolean) {
  Studio(search: $search) {
    id
    name
    media(page: $page, perPage: $perPage, sort: $sort, format: $format, isAdult: $isAdult) {
      edges { isMainStudio node {
        id idMal title { romaji english native userPreferred } type format status description(asHtml: false)
        startDate { year month day } endDate { year month day } season seasonYear episodes duration source
        trailer { id site thumbnail } coverImage { extraLarge large medium color } bannerImage
        genres synonyms averageScore meanScore popularity trending favourites tags { id name rank isGeneralSpoiler isMediaSpoiler isAdult }
        studios(isMain: true) { nodes { id name isAnimationStudio } }
        nextAiringEpisode { airingAt timeUntilAiring episode } externalLinks { url site type }
        siteUrl isAdult countryOfOrigin
      } }
    }
  }
}`;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.statusCode = 204; res.setHeader("Access-Control-Allow-Origin", "*"); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { return jsonRes(res, 405, { status: 405, error: "GET only" }); }

  const rawName = (req.query.name || "").trim();
  if (!rawName) {
    return jsonRes(res, 400, { status: 400, error: "Missing studio name — usage: /v4/studios/{studio_name}?page=1&limit=25" });
  }

  const p = req.query;
  const fresh = p.refresh === "1" || p.refresh === "true";
  const limit = Math.min(Math.max(1, parseInt(p.limit, 10) || 25), 25);
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  const sfw = p.sfw === "true";
  const type = p.type ? String(p.type).toUpperCase() : null;
  const minScore = p.min_score ? parseFloat(p.min_score) : null;
  const maxScore = p.max_score ? parseFloat(p.max_score) : null;
  const isMain = p.isMain !== "false"; // default: main-studio productions only

  const key = cacheKey("studio", { name: rawName.toLowerCase(), page, limit, sfw, type, minScore, maxScore, isMain });
  const hit = cache.lookup(key, cache.TTL_MS_DEFAULT, { fresh });
  if (hit) {
    const body = { ...hit.body, request_cached: true, ...(hit.state === "STALE" ? { _stale: true } : {}) };
    return jsonRes(res, 200, body);
  }

  const wanted = rawName.toLowerCase();
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const studioMatchRow = (name) => {
    const n = norm(name);
    if (!n) return false;
    const toks = norm(wanted).split(/\s+/).filter(Boolean);
    return n === norm(wanted) || (toks.length && toks.every((t) => n.includes(t)));
  };
  const studioMatch = (m) => {
    const names = (m.studios || []).map((s) => String(s.name || ""));
    if (names.some((n) => norm(n) === norm(wanted))) return true;
    const toks = norm(wanted).split(/\s+/).filter(Boolean);
    return names.some((n) => { const x = norm(n); return toks.length && toks.every((t) => x.includes(t)); });
  };

  // ── Leg 1: AniList ──
  const variables = { search: rawName, page, perPage: limit, sort: ["POPULARITY_DESC"], isAdult: !sfw };
  if (type) variables.format = type;
  try {
    const d = await anilistQuery(STUDIO_QUERY, variables);
    const studio = d.Studio;
    if (!studio) throw new Error(`studio "${rawName}" not found on AniList`);
    let edges = studio.media?.edges || [];
    if (isMain) edges = edges.filter((e) => e.isMainStudio !== false);
    let data = edges.map((e) => transformToV4Format(e.node)).filter((m) => studioMatch(m));
    if (minScore !== null) data = data.filter((m) => m.score !== null && m.score >= minScore);
    if (maxScore !== null) data = data.filter((m) => m.score !== null && m.score <= maxScore);
    const body = {
      request_hash: `request:v4:studios:${wanted}:${Date.now()}`,
      request_cached: false,
      request_cache_expiry: 300,
      _source: "anilist_api",
      _fallback: null,
      studio: { id: studio.id || null, name: studio.name || rawName, match: studio.name || rawName },
      pagination: { last_visible_page: page, has_next_page: edges.length >= limit, current_page: page, items: { count: data.length, total: data.length, per_page: limit } },
      data,
    };
    cache.put(key, body);
    return jsonRes(res, 200, body);
  } catch (e1) {
    console.error("[v4/studios] AniList failed:", e1.message, "→ Supabase");
    // ── Leg 2: Supabase ──
    try {
      // NOTE: `studios` is jsonb → PostgREST ilike on it 404s, so filter in JS.
      const rows = await supabaseSelect(
        `select=anilist_id,mal_id,title,native,titles,poster,episodes,duration,status,score,aired,rating,anime_type,season,year,season_year,genre,studios,producers,next_air_schedule_time,next_air_episode` +
        `&currently_airing=eq.true&order=score.desc.nullslast&limit=200`
      );
      let data = (Array.isArray(rows) ? rows : [])
        .filter((r) => parseMaybeJsonStringArray(r.studios).some((n) => studioMatchRow(n)))
        .map(supabaseRowToV4)
        .filter((m) => studioMatch(m));
      if (minScore !== null) data = data.filter((m) => m.score !== null && m.score >= minScore);
      if (maxScore !== null) data = data.filter((m) => m.score !== null && m.score <= maxScore);
      const total = data.length;
      if (!total) throw new Error("supabase studio mirror empty");
      const start = (page - 1) * limit;
      const body = {
        request_hash: `request:v4:studios:${wanted}:${Date.now()}`,
        request_cached: false,
        request_cache_expiry: 300,
        _source: "supabase_anikoto_data",
        _fallback: `anilist_failed: ${e1.message}`,
        _note: "Served from the owner's Supabase mirror (anikoto_data) — currently-airing titles only.",
        studio: { id: null, name: rawName, match: rawName },
        pagination: { last_visible_page: Math.max(1, Math.ceil(total / limit)), has_next_page: page * limit < total, current_page: page, items: { count: data.slice(start, start + limit).length, total, per_page: limit } },
        data: data.slice(start, start + limit),
      };
      cache.put(key, body);
      return jsonRes(res, 200, body);
    } catch (e2) {
      console.error("[v4/studios] Supabase failed:", e2.message, "→ Jikan");
      // ── Leg 3: Jikan — search anime by the studio name, keep studio matches ──
      try {
        const j = await jikanFetch(`/anime?q=${encodeURIComponent(rawName)}&limit=25&order_by=members&sort=desc${sfw ? "&sfw=true" : ""}`);
        const data = (j.data || []).filter((a) => {
          const names = (a.studios || []).map((s) => String(s.name || "").toLowerCase());
          const toks = wanted.split(/\s+/).filter(Boolean);
          return names.some((n) => n === wanted) || (toks.length && names.some((n) => toks.every((t) => n.includes(t))));
        });
        const body = {
          request_hash: j.request_hash || `request:v4:studios:${wanted}:${Date.now()}`,
          request_cached: !!j.request_cached,
          request_cache_expiry: j.request_cache_expiry ?? 300,
          _source: "jikan",
          _fallback: `anilist_failed: ${e1.message}; supabase_failed: ${e2.message}`,
          studio: { id: null, name: rawName, match: null },
          pagination: j.pagination || null,
          data,
        };
        cache.put(key, body);
        return jsonRes(res, 200, body);
      } catch (e3) {
        console.error("[v4/studios] Jikan failed too:", e3.message);
        return jsonRes(res, 200, {
          request_hash: `request:v4:studios:${wanted}:${Date.now()}`,
          request_cached: false, request_cache_expiry: 0,
          _source: "error",
          _fallback: `anilist: ${e1.message}; supabase: ${e2.message}; jikan: ${e3.message}`,
          studio: { id: null, name: rawName, match: null },
          pagination: { last_visible_page: 0, has_next_page: false, current_page: page, items: { count: 0, total: 0, per_page: limit } },
          data: [],
        });
      }
    }
  }
};
