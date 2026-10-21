// _lib/transform.js — shared mappers between AniList / Supabase data and the
// jikan-v4-shaped response contract of this project (t129).

// ── AniList → jikan-v4 anime object (moved verbatim from the original
//    api/v4/anime.js so every endpoint emits the same shape) ──

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

// ── Supabase anikoto_data row → jikan-v4 anime object (fallback backends) ──
// Rows are slim-selected (no giant anilist_full_cached blobs) and mapped from
// the flat table columns. Accepts the *already-extracted* row shape produced
// by the endpoint's select aliases.

function parseMaybeJsonStringArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch { return []; }
  }
  return [];
}

function parseAiredString(s) {
  // "May 3, 2023 to ?" | "2026-10-04" | null
  const out = { from: null, to: null, prop: { from: { day: null, month: null, year: null }, to: { day: null, month: null, year: null } }, string: s || null };
  if (!s) return out;
  const parts = String(s).split(/\s+to\s+/i);
  const parseOne = (t) => {
    t = (t || "").trim();
    if (!t || t === "?") return null;
    let d = new Date(t);
    if (isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(t)) d = new Date(`${t}T00:00:00Z`);
    if (isNaN(d.getTime())) return null;
    return { iso: d.toISOString(), day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
  };
  const f = parseOne(parts[0]);
  const to = parseOne(parts[1]);
  if (f) { out.from = f.iso; out.prop.from = { day: f.day, month: f.month, year: f.year }; }
  if (to) { out.to = to.iso; out.prop.to = { day: to.day, month: to.month, year: to.year }; }
  return out;
}

function supabaseRowToV4(row) {
  const genres = parseMaybeJsonStringArray(row.genre);
  const studios = parseMaybeJsonStringArray(row.studios);
  const producers = parseMaybeJsonStringArray(row.producers);
  const aired = parseAiredString(row.aired);
  const poster = row.poster || null;
  const scoreNum = row.score != null && !isNaN(parseFloat(row.score)) ? parseFloat(row.score) : null;
  const typeMap = { tv: "TV", ona: "ONA", ova: "OVA", movie: "Movie", special: "Special", music: "Music" };
  const t = String(row.anime_type || "").toLowerCase();

  const mkEnt = (name, i) => ({ mal_id: null, type: "anime", name, url: `https://myanimelist.net/anime/genre/${String(name).toLowerCase().replace(/\s+/g, "_")}${i ? "" : ""}` });

  return {
    mal_id: row.mal_id ? parseInt(row.mal_id, 10) || null : null,
    url: row.mal_id ? `https://myanimelist.net/anime/${row.mal_id}` : (row.anilist_id ? `https://anilist.co/anime/${row.anilist_id}` : null),
    images: {
      jpg: { image_url: poster, small_image_url: poster, large_image_url: poster },
      webp: { image_url: poster, small_image_url: poster, large_image_url: poster },
    },
    trailer: { youtube_id: null, url: null, embed_url: null, images: { image_url: null, small_image_url: null, medium_image_url: null, large_image_url: null, maximum_image_url: null } },
    approved: true,
    titles: [
      ...(row.title ? [{ type: "Default", title: row.title }] : []),
      ...(row.native && row.native !== row.title ? [{ type: "Japanese", title: row.native }] : []),
    ],
    title: row.title || "Unknown",
    title_english: row.title || null,
    title_japanese: row.native || null,
    synonyms: parseMaybeJsonStringArray(row.titles),
    type: typeMap[t] || (row.anime_type ? String(row.anime_type).toUpperCase() : "Unknown"),
    source: null,
    episodes: row.episodes != null && !isNaN(parseInt(row.episodes, 10)) ? parseInt(row.episodes, 10) : null,
    status: row.status || null,
    airing: String(row.status || "").toLowerCase() === "currently airing",
    aired,
    premiere: null,
    broadcast: null,
    related: [],
    producers: producers.map((n) => ({ mal_id: null, type: "anime", name: n, url: `https://myanimelist.net/anime/producer/unknown` })),
    licensors: [],
    studios: studios.map((n) => ({ mal_id: null, type: "anime", name: n, url: `https://myanimelist.net/anime/producer/unknown` })),
    genres: genres.map((n) => mkEnt(n)),
    explicit_genres: [],
    themes: [],
    demographics: [],
    relations: [],
    theme: { openings: [], endings: [] },
    external: [],
    score: scoreNum,
    scored_by: null,
    rank: null,
    popularity: null,
    members: null,
    favorites: null,
    synopsis: row.synopsis || null,
    season: row.season || null,
    year: row.year || row.season_year || null,
    rating: row.rating || null,
    duration: row.duration || null,
    aired_from: aired.from,
    aired_to: aired.to,
    anilist_id: row.anilist_id ? parseInt(row.anilist_id, 10) || row.anilist_id : null,
    trending: null,
    site_url: row.anilist_id ? `https://anilist.co/anime/${row.anilist_id}` : null,
    next_episode: row.next_air_episode
      ? { episode: row.next_air_episode, airing_at: row.next_air_schedule_time ? new Date(String(row.next_air_schedule_time).replace(" ", "T") + "+09:00").toISOString() : null, time_until: null }
      : null,
  };
}

// ── Supabase cached AniList characters edges → jikan /anime/{id}/characters ──

function cachedCharsToJikan(edges) {
  return (edges || []).map((edge) => {
    const node = edge.node || {};
    const name = node.name || {};
    const img = node.image || {};
    // voiceActors: group by language (Japanese first), jikan-style
    const byLang = {};
    for (const va of edge.voiceActors || []) {
      const lang = va.languageV2 || "Japanese";
      (byLang[lang] || (byLang[lang] = [])).push({
        person: {
          mal_id: null,
          url: va.id ? `https://anilist.co/staff/${va.id}` : null,
          website: va.id ? `https://anilist.co/staff/${va.id}` : null,
          name: (va.name && (va.name.full || va.name.userPreferred)) || null,
          images: {
            jpg: { image_url: (va.image && va.image.large) || null },
            webp: { image_url: (va.image && va.image.large) || null },
          },
        },
        language: lang,
      });
    }
    const voiceActors = [];
    if (byLang["Japanese"]) voiceActors.push(...byLang["Japanese"]);
    for (const lang of Object.keys(byLang)) {
      if (lang !== "Japanese") voiceActors.push(...byLang[lang]);
    }
    return {
      character: {
        mal_id: null,
        url: node.id ? `https://anilist.co/character/${node.id}` : null,
        website: node.id ? `https://anilist.co/character/${node.id}` : null,
        images: {
          jpg: { image_url: img.large || img.medium || null },
          webp: { image_url: img.large || img.medium || null },
        },
        name: name.full || null,
        name_kanji: name.native || null,
        favorites: null,
      },
      role: edge.role === "MAIN" ? "Main" : (edge.role === "SUPPORTING" ? "Supporting" : (edge.role || null)),
      voice_actors: voiceActors,
    };
  });
}

// ── Slim AniList media subset for schedule payloads ──
// The cached blob contains heavy branches (characters/statistics/relations)
// the schedule consumers never read — strip them so /v4/schedule/all stays
// a few hundred KB, not tens of MB.

function slimMediaForSchedule(full) {
  if (!full || typeof full !== "object") return null;
  return {
    id: full.id ?? null,
    idMal: full.idMal ?? null,
    title: full.title || null,
    coverImage: full.coverImage || null,
    bannerImage: full.bannerImage ?? null,
    format: full.format ?? null,
    status: full.status ?? null,
    episodes: full.episodes ?? null,
    duration: full.duration ?? null,
    averageScore: full.averageScore ?? null,
    season: full.season ?? null,
    seasonYear: full.seasonYear ?? null,
    genres: Array.isArray(full.genres) ? full.genres.slice(0, 8) : [],
    studios: full.studios && Array.isArray(full.studios.nodes)
      ? { nodes: full.studios.nodes.map((n) => ({ id: n.id, name: n.name, isAnimationStudio: n.isAnimationStudio !== false })) }
      : { nodes: [] },
    description: typeof full.description === "string" ? String(full.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260) : null,
    siteUrl: full.siteUrl || (full.id ? `https://anilist.co/anime/${full.id}` : null),
  };
}

module.exports = {
  getCurrentSeason, mapSortParam, scoreToRating, mapFormatToType,
  transformToV4Format, supabaseRowToV4, cachedCharsToJikan,
  slimMediaForSchedule, parseMaybeJsonStringArray, parseAiredString,
};
