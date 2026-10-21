// GET /api/v4/anime/airing     (aliases: /v4/airing, /v4/currently-airing)
//
// t130 — currently-airing anime in ANILIST FORMAT (data.Page.media[]) with a
// 3-leg fallback chain so the site's hero slider keeps its anime pool while
// the AniList GraphQL API is down:
//   1. AniList GraphQL        — status RELEASING (richest + freshest; tried
//                               FIRST on every request so we auto-flip back
//                               to AniList the moment it recovers)
//   2. Supabase anikoto_data  — currently_airing=true rows; the anikoto
//                               automation keeps a full AniList media snapshot
//                               in anilist_full_cached (owner's DB — outage-proof)
//   3. Jikan                  — /seasons/now (self-hosted → public)
//
// Params: limit (default 50, cap 60 — t131 hero wants a 60-slide pool) · page (AniList leg only, default 1) ·
//         sfw (default true — drops Hentai/Ecchi + isAdult:false) ·
//         format=TV,ONA (csv filter; hero uses format=TV) ·
//         sort=popularity|score|trending|favourite (default popularity) ·
//         refresh=1 (bypass cache + stale layer)
// Cache:  exact-key 10-min memory TTL + s-maxage=600 + SWR 86400;
//         serve-stale-on-error; empty/corrupt upstream pools are never cached.

const cache = require("../../_lib/cache");
const { jsonRes, cacheKey } = require("../../_lib/http");
const { anilistQuery, supabaseSelect, jikanFetch } = require("../../_lib/backends");
const { LIST_COLS, SORT_MAP, buildMediaFromRow, jikanToAniList, isValidMediaList, applyListingFilters, parseFormatFilter } = require("../../_lib/listing");

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
query ($page: Int, $perPage: Int, $sort: [MediaSort], $formatIn: [MediaFormat], $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, status: RELEASING, sort: $sort, format_in: $formatIn, isAdult: $isAdult) {
${MEDIA_FIELDS}
    }
  }
}`;

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
  const limit = Math.min(Math.max(1, parseInt(q.limit || q.perPage, 10) || 50), 60);
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const sfw = q.sfw !== "false"; // default true
  const formatFilter = parseFormatFilter(q.format);
  const sortKey = String(q.sort || "popularity").toLowerCase();
  const anilistSort = SORT_MAP[sortKey] || SORT_MAP.popularity;

  const key = cacheKey("airing", { limit, page, sfw, formatFilter, sortKey });
  const hit = cache.lookup(key, 10 * 60 * 1000, { fresh: refresh });
  if (hit) {
    const body = { ...hit.body, cache: { ...hit.body.cache, served: hit.state === "HIT" ? "memory TTL hit" : "stale (upstream error guard)" }, _stale: hit.state === "STALE" || undefined };
    return jsonRes(res, 200, body);
  }

  const mkBody = (source, fallback, media, extra = {}) => ({
    ok: true,
    endpoint: "/api/v4/anime/airing",
    _source: source,
    _fallback: fallback,
    generatedAt: new Date().toISOString(),
    applied: { limit, page, sfw, format: formatFilter.length ? formatFilter : null, sort: anilistSort, refresh: refresh || null },
    ...extra,
    count: media.length,
    data: { Page: { pageInfo: { perPage: limit, currentPage: page, total: media.length }, media } },
  });

  // ── Leg 1: AniList GraphQL ──
  try {
    const d = await anilistQuery(QUERY, {
      page, perPage: limit,
      sort: [anilistSort],
      formatIn: formatFilter.length ? formatFilter : undefined,
      isAdult: sfw ? false : undefined,
    });
    const media = applyListingFilters(d.Page?.media || [], { sfw, formatFilter });
    if (!isValidMediaList(media, 1)) throw new Error("anilist pool empty");
    const body = mkBody("anilist_api", null, media, {
      cache: { ttl_seconds: 600, fetched_at: new Date().toISOString(), source: "anilist_api" },
      pagination: d.Page?.pageInfo || null,
    });
    cache.put(key, body);
    return jsonRes(res, 200, body);
  } catch (e1) {
    console.error("[v4/anime/airing] AniList failed:", e1.message, "→ Supabase");

    // ── Leg 2: Supabase anikoto_data (owner's DB — outage-proof) ──
    try {
      const rows = await supabaseSelect(
        `select=${LIST_COLS}` +
        `&currently_airing=eq.true` +
        `&anilist_full_cached->coverImage->>extraLarge=not.is.null` +
        `&order=al_popularity.desc.nullslast` +
        `&limit=200`
      );
      const media = applyListingFilters((Array.isArray(rows) ? rows : []).map(buildMediaFromRow), { sfw, formatFilter }).slice(0, limit);
      if (!isValidMediaList(media, 1)) throw new Error("supabase airing mirror empty");
      const body = mkBody("supabase_anikoto_data", `anilist_failed: ${e1.message}`, media, {
        cache: { ttl_seconds: 600, fetched_at: new Date().toISOString(), source: "supabase_anikoto_data", note: "anikoto_data.anilist_full_cached (profile ruristream) — independent of AniList API health" },
      });
      cache.put(key, body);
      return jsonRes(res, 200, body);
    } catch (e2) {
      console.error("[v4/anime/airing] Supabase failed:", e2.message, "→ Jikan");

      // ── Leg 3: Jikan /seasons/now (self-hosted → public) ──
      try {
        const pages = Math.ceil(limit / 25);
        const lists = await Promise.all(
          Array.from({ length: pages }, (_, i) =>
            jikanFetch(`/seasons/now?limit=25&page=${i + 1}${sfw ? "&sfw=true" : ""}`).catch(() => []))
        );
        let media = lists.flatMap((j) => (Array.isArray(j?.data) ? j.data : [])).map(jikanToAniList).filter(Boolean);
        media = applyListingFilters(media, { sfw, formatFilter }).slice(0, limit);
        if (!isValidMediaList(media, 1)) throw new Error("jikan seasons/now pool empty");
        const body = mkBody("jikan", `anilist_failed: ${e1.message}; supabase_failed: ${e2.message}`, media, {
          cache: { ttl_seconds: 600, fetched_at: new Date().toISOString(), source: "jikan" },
        });
        cache.put(key, body);
        return jsonRes(res, 200, body);
      } catch (e3) {
        console.error("[v4/anime/airing] Jikan failed too:", e3.message);

        // All legs failed — serve the stale copy if one exists (never cache the failure)
        const stale = cache.lookup(key, Infinity, { fresh: false });
        if (stale) {
          const body = { ...stale.body, cache: { ...stale.body.cache, served: "stale (all upstreams down)" }, _stale: true };
          return jsonRes(res, 200, body);
        }
        return jsonRes(res, 502, {
          ok: false,
          endpoint: "/api/v4/anime/airing",
          error: "All three sources failed (AniList, Supabase, Jikan)",
          details: { anilist: e1.message, supabase: e2.message, jikan: e3.message },
          hint: "Retry shortly or force ?refresh=1 once a source recovers.",
        });
      }
    }
  }
};
