// GET /api/v4/anime/list?pool=new|upcoming|completed|trending[|airing]
// (friendly aliases: /v4/new-releases, /v4/upcoming, /v4/completed, /v4/trending)
//
// t131 — AniList-shaped listing pools for the ruristream index sections
// (Top Airing / New Releases / Upcoming Shows / Recently Completed /
// Trending Now). Same contract as /v4/anime/airing (t130): the consumer
// normalizes AniList media objects directly, so every leg emits
// `data.Page.media[]`.
//
// 3-leg fallback chain per pool (must survive AniList API outages):
//   1. AniList GraphQL        — tried FIRST on every request (auto-flip back
//                               the moment AniList recovers)
//   2. Supabase anikoto_data  — the owner's DB mirror (anilist_full_cached
//                               snapshot + aired/year/season columns); fully
//                               independent of AniList health
//   3. Jikan                  — self-hosted (onrender) → api.jikan.moe
//
// OWNER CACHE RULES (t131): every pool has its own TTL, and an
// empty/corrupt/short upstream pool is NEVER written into the cache
// (isValidMediaList guard) — the last good copy keeps serving stale
// instead, exactly like the t130 popular endpoint.
//   trending  10 min   · new 1h · upcoming 6h · completed 6h
//   ?refresh=1 bypasses the TTL read (and the stale layer).
//
// Params: pool (required) · limit (default 50, cap 60) · page (AniList leg
// only) · sfw (default true) · format=TV,TV_SHORT (csv, all legs) ·
// sort=popularity|score|trending|favourite|newest|start_date (pool default) ·
// refresh=1

const cache = require("../../_lib/cache");
const { jsonRes, cacheKey } = require("../../_lib/http");
const { anilistQuery, supabaseSelect, jikanFetch } = require("../../_lib/backends");
const {
  LIST_SCAN_COLS, SORT_MAP, buildMediaFromRow, jikanToAniList,
  isValidMediaList, applyListingFilters, parseFormatFilter,
} = require("../../_lib/listing");

const MEDIA_FIELDS = `
      id idMal
      title { romaji english native userPreferred }
      coverImage { extraLarge large medium color }
      bannerImage
      format status episodes duration season seasonYear
      startDate { year month day } endDate { year month day }
      averageScore meanScore popularity trending favourites
      genres
      studios(isMain: true) { nodes { id name isAnimationStudio } }
      nextAiringEpisode { airingAt timeUntilAiring episode }
      description(asHtml: false)
      siteUrl isAdult source countryOfOrigin`;

const QUERY = `
query ($page: Int, $perPage: Int, $status: MediaStatus, $sort: [MediaSort], $formatIn: [MediaFormat], $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, status: $status, sort: $sort, format_in: $formatIn, isAdult: $isAdult) {
${MEDIA_FIELDS}
    }
  }
}`;

const ANILIST_STATUS = {
  new: "RELEASING",
  trending: "RELEASING",
  airing: "RELEASING",
  upcoming: "NOT_YET_RELEASED",
  completed: "FINISHED",
};
// Owner-chosen default sorts per pool. AniList MediaSort tokens.
const POOL_SORT = {
  new: "START_DATE_DESC",      // newest premieres first
  trending: "TRENDING_DESC",   // AniList live trending rank
  airing: "POPULARITY_DESC",
  upcoming: "POPULARITY_DESC", // "most anticipated" ordering (site's own query)
  completed: "END_DATE_DESC",  // finished most recently first
};
// Owner-chosen TTLs per pool (seconds) — memory + edge.
const POOL_TTL_SEC = {
  trending: 600,      // 10 min — fast-moving
  airing: 600,
  new: 3600,          // 1 h
  upcoming: 6 * 3600, // 6 h — release dates move slowly
  completed: 6 * 3600,
};

// ── helpers ──────────────────────────────────────────────────────────────
const SEASON_RANK = { winter: 1, spring: 2, summer: 3, fall: 4 };

/** "Oct 4, 2026 to ?" / "2026-08-28" / "Nov 27, 2026" → epoch ms | null. */
function parseAiredStart(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/);
  if (m) return Date.parse(m[1].replace(/\s+/g, " "));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}`);
  const y = s.match(/^(\d{4})/);
  if (y) return Date.parse(`${y[1]}-01-01`);
  return null;
}

/** "… to Mar 27, 2026" / "… to 2026-03-27" → epoch ms | null ("to ?" → null). */
function parseAiredEnd(str) {
  if (!str) return null;
  const s = String(str).trim();
  const idx = s.toLowerCase().indexOf(" to ");
  const tail = idx >= 0 ? s.slice(idx + 4).trim() : "";
  if (!tail || tail === "?") return null;
  let m = tail.match(/^([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/);
  if (m) return Date.parse(m[1].replace(/\s+/g, " "));
  m = tail.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}`);
  return null;
}

function prevSeason(now = new Date()) {
  // JST-shifted clock: months 0-2 winter, 3-5 spring, 6-8 summer, 9-11 fall.
  const d = new Date(now.getTime() + 9 * 3600e3);
  const y = d.getUTCFullYear();
  const idx = Math.floor(d.getUTCMonth() / 3); // 0 winter … 3 fall
  if (idx === 0) return { season: "fall", year: y - 1 }; // winter's previous season is last year's fall
  return { season: ["winter", "spring", "summer", "fall"][idx - 1], year: y };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonRes(res, 405, { ok: false, error: "Method not allowed. Use GET." });
  }

  const q = req.query || {};
  const pool = String(q.pool || "").toLowerCase();
  if (!ANILIST_STATUS[pool]) {
    return jsonRes(res, 400, {
      ok: false,
      endpoint: "/api/v4/anime/list",
      error: "Unknown or missing pool",
      allowed: Object.keys(ANILIST_STATUS),
      hint: "Example: /api/v4/anime/list?pool=upcoming&limit=50",
    });
  }
  const refresh = q.refresh === "1" || q.refresh === "true";
  const limit = Math.min(Math.max(1, parseInt(q.limit || q.perPage, 10) || 50), 60);
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const sfw = q.sfw !== "false"; // default true
  const formatFilter = parseFormatFilter(q.format);
  const sortKey = String(q.sort || "").toLowerCase();
  const anilistSort = SORT_MAP[sortKey] || POOL_SORT[pool];
  const ttlSec = POOL_TTL_SEC[pool];

  const key = cacheKey(`list:${pool}`, { limit, page, sfw, formatFilter, sortKey: sortKey || null });
  const edgeCC = `public, max-age=60, s-maxage=${ttlSec}, stale-while-revalidate=86400`;
  const hit = cache.lookup(key, ttlSec * 1000, { fresh: refresh });
  if (hit) {
    const body = { ...hit.body, cache: { ...hit.body.cache, served: hit.state === "HIT" ? "memory TTL hit" : "stale (upstream error guard)" }, _stale: hit.state === "STALE" || undefined };
    return jsonRes(res, 200, body, { "Cache-Control": edgeCC });
  }

  const mkBody = (source, fallback, media, extra = {}) => ({
    ok: true,
    endpoint: "/api/v4/anime/list",
    pool,
    _source: source,
    _fallback: fallback,
    generatedAt: new Date().toISOString(),
    applied: { pool, limit, page, sfw, format: formatFilter.length ? formatFilter : null, sort: anilistSort, refresh: refresh || null },
    ...extra,
    count: media.length,
    data: { Page: { pageInfo: { perPage: limit, currentPage: page, total: media.length }, media } },
  });

  // ── Leg 1: AniList GraphQL ────────────────────────────────────────────
  try {
    const d = await anilistQuery(QUERY, {
      page, perPage: limit,
      status: ANILIST_STATUS[pool],
      sort: [anilistSort],
      formatIn: formatFilter.length ? formatFilter : undefined,
      isAdult: sfw ? false : undefined,
    });
    const media = applyListingFilters(d.Page?.media || [], { sfw, formatFilter });
    if (!isValidMediaList(media, 1)) throw new Error("anilist pool empty");
    const body = mkBody("anilist_api", null, media, {
      cache: { ttl_seconds: ttlSec, fetched_at: new Date().toISOString(), source: "anilist_api" },
      pagination: d.Page?.pageInfo || null,
    });
    cache.put(key, body);
    return jsonRes(res, 200, body, { "Cache-Control": edgeCC });
  } catch (e1) {
    console.error(`[v4/anime/list:${pool}] AniList failed:`, e1.message, "→ Supabase");

    // ── Leg 2: Supabase anikoto_data (owner's DB — outage-proof) ────────
    try {
      let media;
      if (pool === "completed") {
        // Recently completed = FINISHED, started within the last ~2 years,
        // ranked by parsed `aired` end date (the blob has no endDate).
        const cutoff = new Date().getUTCFullYear() - 1;
        const rows = await supabaseSelect(
          `select=${LIST_SCAN_COLS},aired` +
          `&al_status=eq.FINISHED` +
          `&year=gte.${cutoff}` +
          `&order=year.desc.nullslast,al_popularity.desc.nullslast` +
          `&limit=150`
        );
        media = (Array.isArray(rows) ? rows : [])
          .map((r) => ({ ...buildMediaFromRow(r), _aired: r.aired }))
          .map((m) => ({ ...m, _end: parseAiredEnd(m._aired) }))
          .sort((a, b) => {
            if (a._end !== b._end) return (b._end || 0) - (a._end || 0); // ended most recently first, nulls last
            return (b.popularity || 0) - (a.popularity || 0);
          })
          .map(({ _aired, _end, ...rest }) => rest);
      } else if (pool === "upcoming") {
        // Soonest releases first — parse the `aired` start string.
        const rows = await supabaseSelect(
          `select=${LIST_SCAN_COLS},aired` +
          `&al_status=eq.NOT_YET_RELEASED` +
          `&order=year.asc.nullslast` +
          `&limit=120`
        );
        media = (Array.isArray(rows) ? rows : [])
          .map((r) => ({ ...buildMediaFromRow(r), _start: parseAiredStart(r.aired) }))
          .sort((a, b) => {
            if (a._start !== b._start) return (a._start || Infinity) - (b._start || Infinity); // soonest first, unknown last
            return (b.popularity || 0) - (a.popularity || 0);
          })
          .map(({ _aired, _start, ...rest }) => rest);
      } else if (pool === "new") {
        // Newest premieres among currently-airing titles (year+season desc).
        const rows = await supabaseSelect(
          `select=${LIST_SCAN_COLS}` +
          `&currently_airing=eq.true` +
          `&order=year.desc.nullslast,al_popularity.desc.nullslast` +
          `&limit=200`
        );
        media = (Array.isArray(rows) ? rows : [])
          .map(buildMediaFromRow)
          .sort((a, b) => {
            const ra = ((a.seasonYear || a.startDate?.year || 0) * 10) + (SEASON_RANK[String(a.season || "").toLowerCase()] || 0);
            const rb = ((b.seasonYear || b.startDate?.year || 0) * 10) + (SEASON_RANK[String(b.season || "").toLowerCase()] || 0);
            if (ra !== rb) return rb - ra;
            return (b.popularity || 0) - (a.popularity || 0);
          });
      } else {
        // trending / airing — popular currently-airing proxy, index-backed.
        const rows = await supabaseSelect(
          `select=${LIST_SCAN_COLS}` +
          `&currently_airing=eq.true` +
          `&order=al_popularity.desc.nullslast` +
          `&limit=200`
        );
        media = (Array.isArray(rows) ? rows : []).map(buildMediaFromRow);
      }
      media = applyListingFilters(media, { sfw, formatFilter }).slice(0, limit);
      if (!isValidMediaList(media, 1)) throw new Error(`supabase ${pool} mirror empty`);
      const body = mkBody("supabase_anikoto_data", `anilist_failed: ${e1.message}`, media, {
        cache: { ttl_seconds: ttlSec, fetched_at: new Date().toISOString(), source: "supabase_anikoto_data", note: "anikoto_data.anilist_full_cached (profile ruristream) — independent of AniList API health" },
      });
      cache.put(key, body);
      return jsonRes(res, 200, body, { "Cache-Control": edgeCC });
    } catch (e2) {
      console.error(`[v4/anime/list:${pool}] Supabase failed:`, e2.message, "→ Jikan");

      // ── Leg 3: Jikan (self-hosted → public) ──────────────────────────
      try {
        let media = [];
        const pages = Math.ceil(limit / 25);
        if (pool === "completed") {
          // No direct jikan route — the previous season's list, filtered to
          // "Finished Airing", is the closest "recently completed" pool.
          const ps = prevSeason();
          const lists = await Promise.all(
            Array.from({ length: pages }, (_, i) =>
              jikanFetch(`/seasons/${ps.year}/${ps.season}?limit=25&page=${i + 1}${sfw ? "&sfw=true" : ""}`).catch(() => []))
          );
          media = lists.flatMap((j) => (Array.isArray(j?.data) ? j.data : []))
            .filter((a) => a && a.status === "Finished Airing");
        } else if (pool === "upcoming") {
          const lists = await Promise.all(
            Array.from({ length: pages }, (_, i) =>
              jikanFetch(`/seasons/upcoming?limit=25&page=${i + 1}${sfw ? "&sfw=true" : ""}`).catch(() => []))
          );
          media = lists.flatMap((j) => (Array.isArray(j?.data) ? j.data : []));
        } else if (pool === "new") {
          const lists = await Promise.all(
            Array.from({ length: pages }, (_, i) =>
              jikanFetch(`/seasons/now?limit=25&page=${i + 1}${sfw ? "&sfw=true" : ""}`).catch(() => []))
          );
          media = lists.flatMap((j) => (Array.isArray(j?.data) ? j.data : []));
        } else {
          // trending / airing
          const lists = await Promise.all(
            Array.from({ length: pages }, (_, i) =>
              jikanFetch(`/top/anime?filter=airing&limit=25&page=${i + 1}${sfw ? "&sfw=true" : ""}`).catch(() => []))
          );
          media = lists.flatMap((j) => (Array.isArray(j?.data) ? j.data : []));
        }
        media = media.map(jikanToAniList).filter(Boolean);
        media = applyListingFilters(media, { sfw, formatFilter }).slice(0, limit);
        if (!isValidMediaList(media, 1)) throw new Error(`jikan ${pool} pool empty`);
        const body = mkBody("jikan", `anilist_failed: ${e1.message}; supabase_failed: ${e2.message}`, media, {
          cache: { ttl_seconds: ttlSec, fetched_at: new Date().toISOString(), source: "jikan" },
        });
        cache.put(key, body);
        return jsonRes(res, 200, body, { "Cache-Control": edgeCC });
      } catch (e3) {
        console.error(`[v4/anime/list:${pool}] Jikan failed too:`, e3.message);

        // All legs failed — serve the stale copy if one exists (never cache the failure)
        const stale = cache.lookup(key, Infinity, { fresh: false });
        if (stale) {
          const body = { ...stale.body, cache: { ...stale.body.cache, served: "stale (all upstreams down)" }, _stale: true };
          return jsonRes(res, 200, body, { "Cache-Control": edgeCC });
        }
        return jsonRes(res, 502, {
          ok: false,
          endpoint: "/api/v4/anime/list",
          pool,
          error: "All three sources failed (AniList, Supabase, Jikan)",
          details: { anilist: e1.message, supabase: e2.message, jikan: e3.message },
          hint: "Retry shortly or force ?refresh=1 once a source recovers.",
        });
      }
    }
  }
};
