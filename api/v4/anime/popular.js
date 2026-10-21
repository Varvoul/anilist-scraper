// GET /api/v4/anime/popular    (aliases: /v4/popular)
//
// t130 — all-time popular anime in ANILIST FORMAT (data.Page.media[]),
// feeding the site's "Popular Anime" section when the Neon-backed
// /api/popular-anime endpoint comes back empty.
//
// OWNER CACHE SPEC (verbatim intent):
//   • "popular anime section ttl cache must be much long time duration
//      because they do not change so often, ttl time 30days"
//   • "cache data won't be overwritten if live api has down/corrupted/
//      empty datas etc."
// Implementation:
//   • memory TTL 30 days; upstream only re-queried after expiry (or ?refresh=1)
//   • edge: s-maxage 6h (lets a recovered upstream propagate) + SWR 30d
//   • bad-data guard: a pool that is empty / <10 titles / missing ids or
//     titles is NEVER written to the cache — a previously-cached good copy
//     is served stale instead (marked _stale + _stale_reason)
//   • valid fresh data overwrites the cache normally (auto-recover)
//
// 3-leg fallback chain (same as /v4/anime/airing):
//   1. AniList GraphQL (sort per ?sort=, default POPULARITY_DESC)
//   2. Supabase anikoto_data — full-table slim scan (paged, parallel) sorted
//      by anilist_full_cached.popularity in JS (jsonb ORDER BY times out)
//   3. Jikan /top/anime?filter=bypopularity
//
// Params: limit (default 40, cap 50) · sort=popularity|score|favourite|trending|newest ·
//         sfw (default true) · format=TV,MOVIE (csv) · refresh=1

const cache = require("../../_lib/cache");
const { jsonRes, cacheKey } = require("../../_lib/http");
const { anilistQuery, supabaseSelect, jikanFetch } = require("../../_lib/backends");
const { LIST_COLS, SORT_MAP, buildMediaFromRow, jikanToAniList, isValidMediaList, applyListingFilters, parseFormatFilter } = require("../../_lib/listing");

const TTL_POPULAR_MS = 30 * 24 * 3600 * 1000;   // owner spec: 30 days
const MIN_VALID_ITEMS = 10;                     // guard threshold (scales down with ?limit=)

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

function popularQuery(sort) {
  return `
query ($page: Int, $perPage: Int, $sort: [MediaSort], $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, sort: $sort, isAdult: $isAdult) {
${MEDIA_FIELDS}
    }
  }
}`;
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
  const refresh = q.refresh === "1" || q.refresh === "true";
  const limit = Math.min(Math.max(1, parseInt(q.limit || q.perPage, 10) || 40), 50);
  const sfw = q.sfw !== "false"; // default true
  const formatFilter = parseFormatFilter(q.format);
  const sortKey = String(q.sort || "popularity").toLowerCase();
  const anilistSort = SORT_MAP[sortKey] || SORT_MAP.popularity;

  const key = cacheKey("popular", { limit, sfw, formatFilter, sortKey });
  const minValid = Math.min(MIN_VALID_ITEMS, limit); // ?limit=3 must not demand 10 rows
  const hit = cache.lookup(key, TTL_POPULAR_MS, { fresh: refresh });
  if (hit && hit.state === "HIT") {
    const body = { ...hit.body, cache: { ...hit.body.cache, served: "memory TTL hit (30d)" } };
    return jsonRes(res, 200, body, { "Cache-Control": "public, max-age=300, s-maxage=21600, stale-while-revalidate=2592000" });
  }
  // STALE (older than 30d) → fall through and try a fresh fetch; the stale
  // copy is re-served below only if every upstream fails/returns garbage.

  const mkBody = (source, fallback, media, extra = {}) => ({
    ok: true,
    endpoint: "/api/v4/anime/popular",
    _source: source,
    _fallback: fallback,
    generatedAt: new Date().toISOString(),
    applied: { limit, sfw, format: formatFilter.length ? formatFilter : null, sort: anilistSort, refresh: refresh || null },
    ...extra,
    count: media.length,
    data: { Page: { pageInfo: { perPage: limit, total: media.length }, media } },
  });

  const cacheCtl = "public, max-age=300, s-maxage=21600, stale-while-revalidate=2592000";

  // ── Leg 1: AniList GraphQL ──
  try {
    const d = await anilistQuery(popularQuery(anilistSort), {
      page: 1, perPage: limit,
      sort: [anilistSort],
      isAdult: sfw ? false : undefined,
    });
    const media = applyListingFilters(d.Page?.media || [], { sfw, formatFilter });
    if (!isValidMediaList(media, minValid)) throw new Error(`anilist pool invalid/empty (${(d.Page?.media || []).length} rows)`);
    const body = mkBody("anilist_api", null, media, {
      cache: { ttl_seconds: TTL_POPULAR_MS / 1000, ttl_human: "30 days", fetched_at: new Date().toISOString(), source: "anilist_api", guard: "empty/corrupt pools never overwrite this cache" },
      pagination: d.Page?.pageInfo || null,
    });
    cache.put(key, body);
    return jsonRes(res, 200, body, { "Cache-Control": cacheCtl });
  } catch (e1) {
    console.error("[v4/anime/popular] AniList failed:", e1.message, "→ Supabase");

    // ── Leg 2: Supabase — single index-backed ordered query ──
    // al_popularity / al_score / al_favourites are GENERATED columns extracted
    // from anilist_full_cached (auto-synced on every automation write) with
    // DESC indexes — jsonb-path ORDER BY used to time out (~3s statement
    // timeout); the generated columns answer in <1s for any sort.
    try {
      const orderCol = sortKey === "score" ? "al_score" : sortKey === "favourite" || sortKey === "favorites" ? "al_favourites" : "al_popularity";
      const rows = await supabaseSelect(
        `select=${LIST_COLS}` +
        `&${orderCol}=not.is.null` +
        `&order=${orderCol}.desc.nullslast` +
        `&limit=200`
      );
      const seen = new Set();
      let media = [];
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const idKey = row.anilist_id || row.mal_id || row.title;
        if (seen.has(idKey)) continue; // anikoto_data keeps duplicate anilist_ids across anikoto rows
        seen.add(idKey);
        media.push(buildMediaFromRow(row));
      }
      media = applyListingFilters(media, { sfw, formatFilter }).slice(0, limit);
      if (!isValidMediaList(media, minValid)) throw new Error(`supabase popular pool invalid/empty (${media.length} rows)`);
      const body = mkBody("supabase_anikoto_data", `anilist_failed: ${e1.message}`, media, {
        cache: { ttl_seconds: TTL_POPULAR_MS / 1000, ttl_human: "30 days", fetched_at: new Date().toISOString(), source: "supabase_anikoto_data", note: "anikoto_data.anilist_full_cached (profile ruristream) — independent of AniList API health", guard: "empty/corrupt pools never overwrite this cache" },
        coverage: { rows_fetched: (Array.isArray(rows) ? rows.length : 0), served: media.length, order_column: orderCol },
      });
      cache.put(key, body);
      return jsonRes(res, 200, body, { "Cache-Control": cacheCtl });
    } catch (e2) {
      console.error("[v4/anime/popular] Supabase failed:", e2.message, "→ Jikan");

      // ── Leg 3: Jikan top/anime ──
      try {
        const pages = Math.ceil(limit / 25);
        const filter = sortKey === "score" ? "" : (sortKey === "favourite" || sortKey === "favorites") ? "favorite" : "bypopularity";
        const lists = await Promise.all(
          Array.from({ length: pages }, (_, i) =>
            jikanFetch(`/top/anime?limit=25&page=${i + 1}${filter ? `&filter=${filter}` : ""}${sfw ? "&sfw=true" : ""}`).catch(() => []))
        );
        let media = lists.flatMap((j) => (Array.isArray(j?.data) ? j.data : [])).map(jikanToAniList).filter(Boolean);
        media = applyListingFilters(media, { sfw, formatFilter }).slice(0, limit);
        if (!isValidMediaList(media, minValid)) throw new Error("jikan top/anime pool invalid/empty");
        const body = mkBody("jikan", `anilist_failed: ${e1.message}; supabase_failed: ${e2.message}`, media, {
          cache: { ttl_seconds: TTL_POPULAR_MS / 1000, ttl_human: "30 days", fetched_at: new Date().toISOString(), source: "jikan", guard: "empty/corrupt pools never overwrite this cache" },
        });
        cache.put(key, body);
        return jsonRes(res, 200, body, { "Cache-Control": cacheCtl });
      } catch (e3) {
        console.error("[v4/anime/popular] Jikan failed too:", e3.message);

        // All legs failed OR returned garbage → serve the last GOOD cached
        // copy no matter how old it is (owner rule: never overwrite good
        // cache data with down/corrupted/empty results). Never cache the junk.
        const stale = cache.lookup(key, Infinity, { fresh: false });
        if (stale) {
          const body = {
            ...stale.body,
            cache: { ...stale.body.cache, served: "stale (all upstreams down/invalid — 30d pool preserved)" },
            _stale: true,
            _stale_reason: `upstreams failed: ${e1.message} / ${e2.message} / ${e3.message}`,
          };
          return jsonRes(res, 200, body, { "Cache-Control": cacheCtl });
        }
        return jsonRes(res, 502, {
          ok: false,
          endpoint: "/api/v4/anime/popular",
          error: "All three sources failed and no cached pool exists yet",
          details: { anilist: e1.message, supabase: e2.message, jikan: e3.message },
          hint: "Retry shortly or force ?refresh=1 once a source recovers.",
        });
      }
    }
  }
};
