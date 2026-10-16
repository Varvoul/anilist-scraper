// GET /api/v4/anime  (also /v4/anime via vercel.json rewrite)
// AniList-powered "jikan-v4-shaped" airing-anime scraper — clean Vercel port
// of the owner's Cloudflare worker `anilist-scraper` (2026-10-16).
//
// WHY the move: the CF worker's egress IPs are blocked by AniList (every live
// fetch failed and the worker served static SAMPLE data forever), and its
// deployed bundle was corrupted (broken identifiers like `apSortParam`,
// `seasonNamesedia.season]` — bracket sequences eaten). Vercel egress IPs
// reach graphql.anilist.co fine (proven by anilist-my-proxy).
//
// Params (same contract as the worker):
//   page (1), limit (<=25), type (TV|MOVIE|OVA|ONA|SPECIAL), min_score,
//   max_score, order_by (score|popularity|trending|start_date|title|favourites),
//   sort (asc|desc), sfw (true|false), genres (csv of AniList genre names —
//   AND-ish filter applied post-fetch), genres_exclude (csv)
// Response: jikan-v4 style { request_hash, request_cached, request_cache_expiry,
//   _source, pagination, data[] } — AniList live when reachable.
//
// Cache: exact-URL in-memory 5 min (same rhythm as the worker's intent) plus
// CDN s-maxage=300. Errors are never cached.

const ANILIST_URL = "https://graphql.anilist.co";

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

function getCurrentSeason() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  let season;
  if (month >= 1 && month <= 3) season = "WINTER";
  else if (month >= 4 && month <= 6) season = "SPRING";
  else if (month >= 7 && month <= 9) season = "SUMMER";
  else season = "FALL";
  return { season, year };
}

function mapSortParam(orderBy, sort) {
  const asc = sort === "asc";
  switch (orderBy) {
    case "title": return asc ? "TITLE_ROMAJI" : "TITLE_ROMAJI_DESC";
    case "popularity": return asc ? "POPULARITY" : "POPULARITY_DESC";
    case "trending": return asc ? "TRENDING" : "TRENDING_DESC";
    case "start_date": return asc ? "START_DATE" : "START_DATE_DESC";
    case "favourites": return asc ? "FAVOURITES" : "FAVOURITES_DESC";
    case "score":
    default: return asc ? "SCORE" : "SCORE_DESC";
  }
}

function scoreToRating(score, isAdult) {
  if (isAdult) return "Rx - Hentai";
  if (score === null || score === undefined) return null;
  if (score >= 80) return "R - 17+ (violence & profanity)";
  if (score >= 70) return "PG-13 - Teens 13 or older";
  if (score >= 50) return "PG - Children";
  return "G - All Ages";
}

function mapFormatToType(format) {
  const formatMap = {
    TV: "TV", TV_SHORT: "TV", MOVIE: "Movie", OVA: "OVA",
    ONA: "ONA", SPECIAL: "Special", MUSIC: "Music",
  };
  return formatMap[format] || format || "Unknown";
}

function transformToV4Format(media) {
  const startDate = media.startDate || {};
  const endDate = media.endDate || {};
  const nextAiring = media.nextAiringEpisode || {};
  const studios = (media.studios?.nodes || []).filter((s) => s.isAnimationStudio);
  const trailer = media.trailer || {};
  const coverImage = media.coverImage || {};
  const imageUrl = coverImage.extraLarge || coverImage.large || coverImage.medium || null;

  let broadcast = null;
  if (nextAiring?.airingAt) {
    try {
      const airingDate = new Date(nextAiring.airingAt * 1000);
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const dayName = days[airingDate.getUTCDay()];
      const hours = String(airingDate.getUTCHours()).padStart(2, "0");
      const minutes = String(airingDate.getUTCMinutes()).padStart(2, "0");
      broadcast = {
        day: dayName.toLowerCase() + "s",
        time: `${hours}:${minutes}`,
        timezone: "Asia/Tokyo",
        string: `${dayName}s at ${hours}:${minutes} (JST)`,
      };
    } catch (e) { /* leave null */ }
  }

  const titles = [];
  if (media.title?.romaji) titles.push({ type: "Japanese", title: media.title.romaji });
  if (media.title?.english) titles.push({ type: "English", title: media.title.english });
  if (media.title?.native) titles.push({ type: "Default", title: media.title.native });
  if (!titles.length && media.title?.userPreferred) titles.push({ type: "Default", title: media.title.userPreferred });

  const producers = studios.map((s) => ({
    mal_id: s.id, type: "anime", name: s.name,
    url: `https://myanimelist.net/anime/producer/${s.id}`,
  }));
  const genres = (media.genres || []).map((g) => ({
    mal_id: null, type: "anime", name: g,
    url: `https://myanimelist.net/anime/genre/${g.toLowerCase().replace(/\s+/g, "_")}`,
  }));

  let fromDate = null, toDate = null;
  if (startDate.year) fromDate = new Date(Date.UTC(startDate.year, (startDate.month || 1) - 1, startDate.day || 1)).toISOString();
  if (endDate.year) toDate = new Date(Date.UTC(endDate.year, (endDate.month || 1) - 1, endDate.day || 1)).toISOString();
  const aired = {
    from: fromDate,
    to: toDate,
    prop: {
      from: { day: startDate.day || null, month: startDate.month || null, year: startDate.year || null },
      to: { day: endDate.day || null, month: endDate.month || null, year: endDate.year || null },
    },
    string: `${startDate.month || "?"}/${startDate.day || "?"}/${startDate.year || "?"}` +
            (endDate.year ? ` to ${endDate.month || "?"}/${endDate.day || "?"}/${endDate.year}` : " to ?"),
  };

  let premiered = null;
  if (media.season && media.seasonYear) {
    const seasonNames = { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" };
    premiered = `${seasonNames[media.season] || media.season} ${media.seasonYear}`;
  }

  const score = media.averageScore !== null && media.averageScore !== undefined
    ? Math.round((media.averageScore / 10) * 100) / 100
    : null;
  const themes = (media.tags || [])
    .filter((t) => !t.isGeneralSpoiler && !t.isMediaSpoiler && !t.isAdult)
    .slice(0, 5)
    .map((t) => ({
      mal_id: t.id, type: "anime", name: t.name,
      url: `https://myanimelist.net/anime/tag/${t.name.toLowerCase().replace(/\s+/g, "_")}`,
    }));

  return {
    mal_id: media.idMal || null,
    url: media.idMal ? `https://myanimelist.net/anime/${media.idMal}` : `https://anilist.co/anime/${media.id}`,
    images: {
      jpg: {
        image_url: imageUrl,
        small_image_url: coverImage.medium || null,
        large_image_url: coverImage.extraLarge || coverImage.large || null,
      },
      webp: {
        image_url: imageUrl,
        small_image_url: coverImage.medium || null,
        large_image_url: coverImage.extraLarge || coverImage.large || null,
      },
    },
    trailer: {
      youtube_id: trailer?.id || null,
      url: trailer?.id ? `https://www.youtube.com/watch?v=${trailer.id}` : null,
      embed_url: trailer?.id ? `https://www.youtube.com/embed/${trailer.id}` : null,
      images: {
        image_url: trailer?.thumbnail || null,
        small_image_url: trailer?.thumbnail || null,
        medium_image_url: trailer?.thumbnail || null,
        large_image_url: trailer?.thumbnail || null,
        maximum_image_url: trailer?.thumbnail || null,
      },
    },
    approved: true,
    titles,
    title: media.title?.romaji || media.title?.english || media.title?.userPreferred || media.title?.native || "Unknown",
    title_english: media.title?.english || null,
    title_japanese: media.title?.native || null,
    synonyms: media.synonyms || [],
    type: mapFormatToType(media.format),
    source: media.source ? String(media.source).toLowerCase().replace(/_/g, " ") : null,
    episodes: media.episodes ?? null,
    status: media.status === "RELEASING" ? "Currently Airing" : (media.status || null),
    airing: media.status === "RELEASING",
    aired,
    premiere: premiered,
    broadcast,
    related: {},
    producers,
    licensors: [],
    studios: producers,
    genres,
    explicit_genres: [],
    themes,
    demographics: [],
    relations: [],
    theme: { openings: [], endings: [] },
    external: (media.externalLinks || []).map((l) => ({ name: l.site, url: l.url })),
    score,
    scored_by: null,
    rank: null,
    popularity: media.popularity ?? null,
    members: null,
    favorites: media.favourites ?? null,
    synopsis: media.description || null,
    season: media.season ? String(media.season).toLowerCase() : null,
    year: media.seasonYear || null,
    rating: scoreToRating(media.averageScore, !!media.isAdult),
    duration: media.duration ? `${media.duration} min per ep` : null,
    aired_from: fromDate,
    aired_to: toDate,
    anilist_id: media.id,
    trending: media.trending ?? null,
    site_url: media.siteUrl || null,
    next_episode: nextAiring?.episode
      ? { episode: nextAiring.episode, airing_at: nextAiring.airingAt ? new Date(nextAiring.airingAt * 1000).toISOString() : null, time_until: nextAiring.timeUntilAiring ?? null }
      : null,
  };
}

// exact-URL cache (5 min) — mirrors the owner's endpoint cache convention
const store = new Map(); // key -> { body, at }
const TTL_MS = 5 * 60 * 1000;

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", status === 200 ? "public, max-age=60, s-maxage=300" : "no-store");
  res.end(JSON.stringify(body));
}

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

  const key = JSON.stringify([page, limit, type, minScore, maxScore, orderBy, sort, sfw, genreFilter, genreExclude]);
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return jsonRes(res, 200, hit.body);

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const r = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "anilist-scraper/2.0 (+vercel)" },
      body: JSON.stringify({ query: AIRING_QUERY, variables }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const j = await r.json();
    if (!r.ok || (j.errors && j.errors.length)) throw new Error((j.errors && j.errors[0]?.message) || `AniList HTTP ${r.status}`);
    pageData = j.data.Page;
    if (!pageData || !Array.isArray(pageData.media)) throw new Error("malformed AniList response");
  } catch (e) {
    console.error("[v4/anime] AniList fetch failed:", e.message);
    return jsonRes(res, 200, {
      request_hash: `request:v4:anime:airing:${Date.now()}`,
      request_cached: true,
      request_cache_expiry: 60,
      _source: "error",
      _error: e.message,
      _note: "AniList fetch failed — no sample fallback in this port (the old worker served stale samples; consumers should retry or use their own fallback chain).",
      pagination: { last_visible_page: 0, has_next_page: false, current_page: page, items: { count: 0, total: 0, per_page: limit } },
      data: [],
    });
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
