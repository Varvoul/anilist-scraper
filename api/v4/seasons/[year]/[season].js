// GET /api/v4/seasons/{year}/{season}
//   aliases (vercel.json rewrites):
//     /v4/season/{season}/{year}          — owner's original path style
//     /v4/season/{season}/year/{year}     — "?season/x year/y" style
//     /v4/seasons/now/fall                — year='now' resolves to current
//
// Jikan-v4-shaped season listing with a 3-leg fallback chain so it keeps
// serving while the AniList GraphQL API is down (t129):
//   1. AniList GraphQL  — Page(season, seasonYear) → jikan-v4 transform
//   2. Supabase         — anikoto_data (owner's DB) season/year columns
//   3. Jikan            — /seasons/{year}/{season} (self-hosted → public)
//
// Params: page (1), limit (<=25), sfw=true|false, type (TV|MOVIE|OVA|ONA|SPECIAL),
//         min_score, max_score, order_by, sort, genres, genres_exclude
// Cache:  exact-key 5-min TTL + s-maxage=300 + serve-stale-on-error; ?refresh=1 bypass.

const cache = require("../../../_lib/cache");
const { jsonRes, cacheKey } = require("../../../_lib/http");
const { anilistQuery, supabaseSelect, jikanFetch } = require("../../../_lib/backends");
const {
  getCurrentSeason, mapSortParam, transformToV4Format, supabaseRowToV4,
} = require("../../../_lib/transform");

const SEASON_QUERY = `
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int, $sort: [MediaSort], $format: MediaFormat, $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: $sort, format: $format, isAdult: $isAdult) {
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

const SEASONS = new Set(["winter", "spring", "summer", "fall"]);

function resolveSeasonYear(yearRaw, seasonRaw) {
  // handles: /v4/seasons/2026/fall · /v4/seasons/now/fall (year='now')
  const cur = getCurrentSeason();
  let year = parseInt(yearRaw, 10);
  if (!Number.isFinite(year) || year < 1960 || year > 2200) year = cur.year;
  let season = String(seasonRaw || "").toLowerCase();
  if (!SEASONS.has(season)) season = cur.season.toLowerCase();
  return { season: season.toUpperCase(), year };
}

function applyPostFilters(list, p) {
  let out = list;
  if (p.minScore !== null) out = out.filter((m) => m.score !== null && m.score >= p.minScore);
  if (p.maxScore !== null) out = out.filter((m) => m.score !== null && m.score <= p.maxScore);
  if (p.sfw) out = out.filter((m) => m.rating !== "Rx - Hentai");
  if (p.genreFilter.length) out = out.filter((m) => {
    const gs = (m.genres || []).map((g) => g.name.toLowerCase());
    return p.genreFilter.every((g) => gs.includes(g));
  });
  if (p.genreExclude.length) out = out.filter((m) => {
    const gs = (m.genres || []).map((g) => g.name.toLowerCase());
    return !p.genreExclude.some((g) => gs.includes(g));
  });
  return out;
}

function paginate(list, page, limit) {
  const start = (page - 1) * limit;
  return list.slice(start, start + limit);
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.statusCode = 204; res.setHeader("Access-Control-Allow-Origin", "*"); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { return jsonRes(res, 405, { status: 405, error: "GET only" }); }

  const p = req.query || {};
  const fresh = p.refresh === "1" || p.refresh === "true";
  const limit = Math.min(Math.max(1, parseInt(p.limit, 10) || 25), 25);
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  const sfw = p.sfw === "true";
  const type = p.type ? String(p.type).toUpperCase() : null;
  const minScore = p.min_score ? parseFloat(p.min_score) : null;
  const maxScore = p.max_score ? parseFloat(p.max_score) : null;
  const orderBy = p.order_by || "score";
  const sort = p.sort || "desc";
  const genreFilter = p.genres ? String(p.genres).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  const genreExclude = p.genres_exclude ? String(p.genres_exclude).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];

  const { season, year } = resolveSeasonYear(req.query.year, req.query.season);
  const postParams = { minScore, maxScore, sfw, genreFilter, genreExclude };

  const key = cacheKey("season", { season, year, page, limit, sfw, type, minScore, maxScore, orderBy, sort, genreFilter, genreExclude });
  const hit = cache.lookup(key, cache.TTL_MS_DEFAULT, { fresh });
  if (hit) {
    const body = { ...hit.body, request_cached: true, ...(hit.state === "STALE" ? { _stale: true } : {}) };
    return jsonRes(res, 200, body);
  }

  // ── Leg 1: AniList ──
  const variables = {
    page, perPage: limit, season, seasonYear: year,
    sort: [mapSortParam(orderBy, sort)], isAdult: !sfw,
  };
  if (type) variables.format = type;
  try {
    const d = await anilistQuery(SEASON_QUERY, variables);
    const media = d.Page?.media || [];
    const data = applyPostFilters(media.map(transformToV4Format), postParams);
    const body = {
      request_hash: `request:v4:seasons:${year}/${season.toLowerCase()}:${Date.now()}`,
      request_cached: false,
      request_cache_expiry: 300,
      _source: "anilist_api",
      _fallback: null,
      pagination: {
        last_visible_page: d.Page?.pageInfo?.lastPage || 1,
        has_next_page: !!d.Page?.pageInfo?.hasNextPage,
        current_page: d.Page?.pageInfo?.currentPage || page,
        items: { count: data.length, total: d.Page?.pageInfo?.total ?? data.length, per_page: limit },
      },
      data,
    };
    cache.put(key, body);
    return jsonRes(res, 200, body);
  } catch (e1) {
    console.error("[v4/seasons] AniList failed:", e1.message, "→ Supabase");
    // ── Leg 2: Supabase (own DB — unaffected by AniList outages) ──
    try {
      const rows = await supabaseSelect(
        `select=anilist_id,mal_id,title,native,titles,poster,episodes,duration,status,score,aired,rating,anime_type,season,year,season_year,genre,studios,producers,next_air_schedule_time,next_air_episode` +
        `&season=eq.${season.toLowerCase()}&year=eq.${year}&currently_airing=eq.true&order=score.desc.nullslast&limit=200`
      );
      const list = applyPostFilters((Array.isArray(rows) ? rows : []).map(supabaseRowToV4), postParams);
      const total = list.length;
      if (!total) throw new Error("supabase season mirror empty");
      const data = paginate(list, page, limit);
      const body = {
        request_hash: `request:v4:seasons:${year}/${season.toLowerCase()}:${Date.now()}`,
        request_cached: false,
        request_cache_expiry: 300,
        _source: "supabase_anikoto_data",
        _fallback: `anilist_failed: ${e1.message}`,
        _note: "Served from the owner's Supabase mirror (anikoto_data) — currently-airing titles only.",
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
      console.error("[v4/seasons] Supabase failed:", e2.message, "→ Jikan");
      // ── Leg 3: Jikan (self-hosted → public) ──
      try {
        const j = await jikanFetch(`/seasons/${year}/${season.toLowerCase()}?limit=${limit}&page=${page}${sfw ? "&sfw=true" : ""}`);
        const body = {
          request_hash: j.request_hash || `request:v4:seasons:${year}/${season.toLowerCase()}:${Date.now()}`,
          request_cached: !!j.request_cached,
          request_cache_expiry: j.request_cache_expiry ?? 300,
          _source: "jikan",
          _fallback: `anilist_failed: ${e1.message}; supabase_failed: ${e2.message}`,
          pagination: j.pagination || null,
          data: j.data || [],
        };
        cache.put(key, body);
        return jsonRes(res, 200, body);
      } catch (e3) {
        console.error("[v4/seasons] Jikan failed too:", e3.message);
        return jsonRes(res, 200, {
          request_hash: `request:v4:seasons:${year}/${season.toLowerCase()}:${Date.now()}`,
          request_cached: false, request_cache_expiry: 0,
          _source: "error",
          _fallback: `anilist: ${e1.message}; supabase: ${e2.message}; jikan: ${e3.message}`,
          pagination: { last_visible_page: 0, has_next_page: false, current_page: page, items: { count: 0, total: 0, per_page: limit } },
          data: [],
        });
      }
    }
  }
};
