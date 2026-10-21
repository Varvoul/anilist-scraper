// GET /api/v4/anime  (also /v4/anime via vercel.json rewrite)
// AniList-powered "jikan-v4-shaped" airing-anime scraper — clean Vercel port
// of the owner's Cloudflare worker `anilist-scraper` (2026-10-16).
//
// t129: refactored onto the shared _lib and given an outage fallback so the
// endpoint keeps serving while graphql.anilist.co is down:
//   1. AniList GraphQL — live airing-this-season data (PRIMARY; auto-flips
//      back the moment AniList recovers because it is tried on every request)
//   2. Supabase anikoto_data — owner's DB mirror (currently_airing rows)
//
// Params (same contract as the worker):
//   page (1), limit (<=25), type (TV|MOVIE|OVA|ONA|SPECIAL), min_score,
//   max_score, order_by (score|popularity|trending|start_date|title|favourites),
//   sort (asc|desc), sfw (true|false), genres (csv of AniList genre names —
//   AND-ish filter applied post-fetch), genres_exclude (csv)
// Response: jikan-v4 style { request_hash, request_cached, request_cache_expiry,
//   _source, pagination, data[] } — AniList live when reachable.
//
// Cache: exact-URL in-memory 5 min (shared _lib/cache with serve-stale-on-error)
// plus CDN s-maxage=300. `?refresh=1` bypasses the cache.

const cache = require("../_lib/cache");
const { jsonRes, cacheKey } = require("../_lib/http");
const { anilistQuery, supabaseSelect } = require("../_lib/backends");
const {
  getCurrentSeason, mapSortParam, transformToV4Format, supabaseRowToV4,
} = require("../_lib/transform");

const AIRING_QUERY = `
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int, $sort: [MediaSort], $format: MediaFormat, $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, status: RELEASING, season: $season, seasonYear: $seasonYear, sort: $sort, format: $format, isAdult: $isAdult) {
      id idMal title { romaji english native userPreferred } type format status description(asHtml: false)
      startDate { year month day } endDate { year month day } season seasonYear episodes duration source
      trailer { id site thumbnail } coverImage { extraLarge large medium color } bannerImage
      genres synonyms averageScore meanScore popularity trending favourites tags { id name rank isGeneralSpoiler isMediaSpoiler isAdult }
      studios(isMain: true) { nodes { id name isAnimationStudio } }
      nextAiringEpisode { airingAt timeUntilAiring episode } externalLinks { url site type }
      siteUrl isAdult countryOfOrigin
    }
  }
}`;

// exact-key cache shared with the other t129 endpoints (5 min, stale-on-error);
// jsonRes + cacheKey come from ../_lib/http (required at the top).

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.statusCode = 204; res.setHeader("Access-Control-Allow-Origin", "*"); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { jsonRes(res, 405, { status: 405, error: "GET only" }); return; }

  const params = req.query || {};
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(params.limit, 10) || 25), 25);
  const type = params.type ? String(params.type).toUpperCase() : null;
  const minScore = params.min_score ? parseFloat(params.min_score) : null;
  const maxScore = params.max_score ? parseFloat(params.max_score) : null;
  const orderBy = params.order_by || "score";
  const sort = params.sort || "desc";
  const sfw = params.sfw === "true";
  const genreFilter = params.genres ? String(params.genres).split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const genreExclude = params.genres_exclude ? String(params.genres_exclude).split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  const key = cacheKey("anime", { page, limit, type, minScore, maxScore, orderBy, sort, sfw, genreFilter, genreExclude });
  const hit = cache.lookup(key, cache.TTL_MS_DEFAULT, { fresh: params.refresh === "1" || params.refresh === "true" });
  if (hit) {
    const body = { ...hit.body, request_cached: true, ...(hit.state === "STALE" ? { _stale: true } : {}) };
    return jsonRes(res, 200, body);
  }

  const currentSeason = getCurrentSeason();
  const variables = {
    page,
    perPage: limit,
    season: currentSeason.season,
    seasonYear: currentSeason.year,
    sort: [mapSortParam(orderBy, sort)],
    isAdult: !sfw,
  };
  if (type && type !== "TV") variables.format = type;

  let pageData, useFallback = false;
  try {
    const d = await anilistQuery(AIRING_QUERY, variables);
    pageData = d.Page;
    if (!pageData || !Array.isArray(pageData.media)) throw new Error("malformed AniList response");
  } catch (e) {
    console.error("[v4/anime] AniList fetch failed:", e.message, "→ Supabase fallback");
    // ── t129 fallback leg: the owner's Supabase mirror (unaffected by AniList) ──
    try {
      const rows = await supabaseSelect(
        `select=anilist_id,mal_id,title,native,titles,poster,episodes,duration,status,score,aired,rating,anime_type,season,year,season_year,genre,studios,producers,next_air_schedule_time,next_air_episode` +
        `&currently_airing=eq.true&order=score.descnullslast&limit=200`
      );
      let list = (Array.isArray(rows) ? rows : []).map(supabaseRowToV4);
      if (type) list = list.filter((m) => m.type === (type === "TV" ? "TV" : type));
      if (minScore !== null) list = list.filter((m) => m.score !== null && m.score >= minScore);
      if (maxScore !== null) list = list.filter((m) => m.score !== null && m.score <= maxScore);
      if (genreFilter.length) list = list.filter((m) => {
        const gs = (m.genres || []).map((g) => g.name.toLowerCase());
        return genreFilter.every((g) => gs.includes(g));
      });
      if (genreExclude.length) list = list.filter((m) => {
        const gs = (m.genres || []).map((g) => g.name.toLowerCase());
        return !genreExclude.some((g) => gs.includes(g));
      });
      const total = list.length;
      if (!total) throw new Error("supabase mirror empty");
      const start = (page - 1) * limit;
      const data = list.slice(start, start + limit);
      const body = {
        request_hash: `request:v4:anime:airing:${Date.now()}`,
        request_cached: false,
        request_cache_expiry: 300,
        _source: "supabase_anikoto_data",
        _fallback: `anilist_failed: ${e.message}`,
        _note: "AniList is unreachable — served from the owner's Supabase mirror (currently-airing titles).",
        pagination: {
          last_visible_page: Math.max(1, Math.ceil(total / limit)),
          has_next_page: page * limit < total,
          current_page: page,
          items: { count: data.length, total, per_page: limit },
        },
        data,
      };
      cache.put(key, body);
      return jsonRes(res, 200, body);
    } catch (e2) {
      console.error("[v4/anime] Supabase fallback failed too:", e2.message);
      return jsonRes(res, 200, {
        request_hash: `request:v4:anime:airing:${Date.now()}`,
        request_cached: true,
        request_cache_expiry: 60,
        _source: "error",
        _error: e.message,
        _fallback: `supabase: ${e2.message}`,
        _note: "AniList fetch failed and the Supabase mirror could not cover this request — consumers should retry or use their own fallback chain.",
        pagination: { last_visible_page: 0, has_next_page: false, current_page: page, items: { count: 0, total: 0, per_page: limit } },
        data: [],
      });
    }
  }

  let filteredMedia = pageData.media;
  if (minScore !== null) filteredMedia = filteredMedia.filter((m) => m.averageScore !== null && m.averageScore >= minScore * 10);
  if (maxScore !== null) filteredMedia = filteredMedia.filter((m) => m.averageScore !== null && m.averageScore <= maxScore * 10);
  if (sfw) filteredMedia = filteredMedia.filter((m) => !m.isAdult);
  if (genreFilter.length) filteredMedia = filteredMedia.filter((m) => {
    const gs = (m.genres || []).map(g => g.toLowerCase());
    return genreFilter.every((g) => gs.includes(g));
  });
  if (genreExclude.length) filteredMedia = filteredMedia.filter((m) => {
    const gs = (m.genres || []).map(g => g.toLowerCase());
    return !genreExclude.some((g) => gs.includes(g));
  });

  const transformedData = filteredMedia.map(transformToV4Format);
  const body = {
    request_hash: `request:v4:anime:airing:${Date.now()}`,
    request_cached: false,
    request_cache_expiry: 300,
    _source: "anilist_api",
    _note: "Live data from AniList (Vercel port of the CF anilist-scraper)",
    pagination: {
      last_visible_page: pageData.pageInfo?.lastPage || 1,
      has_next_page: pageData.pageInfo?.hasNextPage || false,
      current_page: pageData.pageInfo?.currentPage || page,
      items: { count: transformedData.length, total: pageData.pageInfo?.total || transformedData.length, per_page: limit },
    },
    data: transformedData,
  };
  store.set(key, { body, at: Date.now() });
  return jsonRes(res, 200, body);
};
