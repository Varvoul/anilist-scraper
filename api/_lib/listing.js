// _lib/listing.js — shared pieces for the AniList-shaped listing endpoints
// (/v4/anime/airing + /v4/anime/popular, t130).
//
// Both endpoints emit `data.Page.media[]` in ANILIST FORMAT (not the
// jikan-v4 envelope the older /v4 endpoints use) because their consumer —
// the ruristream site's hero slider + popular sections — normalizes and
// renders AniList media objects directly (anilistToInternal()).
//
// Fallback legs (per endpoint): AniList GraphQL → Supabase anikoto_data
// (anilist_full_cached snapshot — independent of AniList health) → Jikan.

const { parseMaybeJsonStringArray } = require("./transform");

const LIST_COLS = [
  "anilist_id", "mal_id", "title", "currently_airing", "year", "season", "anime_type",
  "ti:anilist_full_cached->title",
  "cv:anilist_full_cached->coverImage",
  "bi:anilist_full_cached->bannerImage",
  "fmt:anilist_full_cached->format",
  "stt:anilist_full_cached->status",
  "eps:anilist_full_cached->episodes",
  "dur:anilist_full_cached->duration",
  "asc:anilist_full_cached->averageScore",
  "msc:anilist_full_cached->meanScore",
  "pop:anilist_full_cached->popularity",
  "fav:anilist_full_cached->favourites",
  "gen:anilist_full_cached->genres",
  "stu:anilist_full_cached->studios",
  "nae:anilist_full_cached->nextAiringEpisode",
  "des:anilist_full_cached->description",
  "sy:anilist_full_cached->seasonYear",
].join(",");

// Slim variant for the popular endpoint's full-table scan: drops the three
// heaviest branches (description / studios / nextAiringEpisode) so each page
// is ~4x lighter. The final top-N rows get a one-request top-up with the
// full LIST_COLS so the served items stay feature-complete.
const _SCAN_DROP = ["des:", "stu:", "nae:"];
const LIST_SCAN_COLS = LIST_COLS.split(",").filter((c) => !_SCAN_DROP.some((d) => c.startsWith(d))).join(",");

const FORMAT_ALIASES = {
  TV: "TV", TV_SHORT: "TV_SHORT", MOVIE: "MOVIE", MOVIES: "MOVIE",
  OVA: "OVA", ONA: "ONA", SPECIAL: "SPECIAL", MUSIC: "MUSIC",
};
const SORT_MAP = {
  popularity: "POPULARITY_DESC",
  score: "SCORE_DESC",
  trending: "TRENDING_DESC",
  favourite: "FAVOURITES_DESC",
  favorites: "FAVOURITES_DESC",
  newest: "START_DATE_DESC",
};

/** Supabase anikoto_data row (aliased anilist_full_cached cols) → AniList media object. */
function buildMediaFromRow(row) {
  const id = row.anilist_id ? parseInt(row.anilist_id, 10) || null : null;
  const idMal = row.mal_id ? parseInt(row.mal_id, 10) || null : null;
  const title = row.ti && typeof row.ti === "object"
    ? row.ti
    : { romaji: row.title || "Unknown", english: row.title || null, native: null, userPreferred: row.title || null };
  const fmt = row.fmt || (row.anime_type ? String(row.anime_type).toUpperCase() : null);
  let season = row.sea || null;
  if (!season && row.season) season = String(row.season).toUpperCase();
  // blob stores airingAt as a string — normalize to numbers so consumers
  // (hero sort by timeUntilAiring, schedule bucketing) can rely on them
  let nae = null;
  if (row.nae && Number.isFinite(parseInt(row.nae.airingAt, 10))) {
    const airingAt = parseInt(row.nae.airingAt, 10);
    nae = {
      airingAt,
      timeUntilAiring: Math.max(0, airingAt - Math.floor(Date.now() / 1000)),
      episode: Number.isFinite(parseInt(row.nae.episode, 10)) ? parseInt(row.nae.episode, 10) : null,
    };
  }
  return {
    id,
    idMal,
    title,
    coverImage: row.cv || null,
    bannerImage: row.bi ?? null,
    format: fmt,
    status: row.stt ?? (row.currently_airing ? "RELEASING" : null),
    episodes: row.eps ?? (row.episodes != null ? parseInt(row.episodes, 10) || null : null),
    duration: row.dur ?? null,
    season,
    seasonYear: row.sy ?? (row.year ? parseInt(row.year, 10) || null : null),
    startDate: row.year ? { year: parseInt(row.year, 10) || null, month: null, day: null } : null,
    endDate: null,
    averageScore: row.asc ?? null,
    meanScore: row.msc ?? null,
    popularity: row.pop != null ? parseInt(row.pop, 10) || null : null,
    trending: null,
    favourites: row.fav != null ? parseInt(row.fav, 10) || null : null,
    genres: Array.isArray(row.gen) ? row.gen : parseMaybeJsonStringArray(row.gen),
    studios: row.stu && Array.isArray(row.stu.nodes) ? { nodes: row.stu.nodes } : { nodes: [] },
    nextAiringEpisode: nae,
    description: typeof row.des === "string"
      ? String(row.des).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
      : null,
    siteUrl: id ? `https://anilist.co/anime/${id}` : null,
    isAdult: false, // genre-based SFW filter applied post-hoc (blob has no isAdult)
    source: null,
    countryOfOrigin: null,
  };
}

/** Jikan v4 anime object → AniList media object (last-resort leg). */
function jikanToAniList(a) {
  if (!a || typeof a !== "object") return null;
  const imgs = a.images || {};
  const img = imgs.webp?.large_image_url || imgs.jpg?.large_image_url ||
              imgs.webp?.image_url || imgs.jpg?.image_url || null;
  const statusMap = {
    "Currently Airing": "RELEASING", "Finished Airing": "FINISHED", "Not yet aired": "NOT_YET_RELEASED",
  };
  const typeMap = { TV: "TV", TV_SHORT: "TV_SHORT", Movie: "MOVIE", OVA: "OVA", ONA: "ONA", Special: "SPECIAL", Music: "MUSIC" };
  const from = a.aired?.prop?.from || {};
  const to = a.aired?.prop?.to || {};
  const nae = a.next_episode || null;
  const genres = [...(a.genres || []), ...(a.explicit_genres || [])]
    .map((g) => g?.name).filter(Boolean);
  const durMatch = String(a.duration || "").match(/(\d+)\s*min/);
  return {
    id: a.anilist_id ? parseInt(a.anilist_id, 10) || null : null,
    idMal: a.mal_id != null ? parseInt(a.mal_id, 10) || null : null,
    title: {
      romaji: a.title || null,
      english: a.title_english || null,
      native: a.title_japanese || null,
      userPreferred: a.title || null,
    },
    coverImage: { extraLarge: img, large: img, medium: imgs.jpg?.small_image_url || img, color: null },
    bannerImage: a.trailer?.images?.maximum_image_url || null,
    format: typeMap[a.type] || a.type || null,
    status: statusMap[a.status] || null,
    episodes: a.episodes ?? null,
    duration: durMatch ? parseInt(durMatch[1], 10) : null,
    season: a.season ? String(a.season).toUpperCase() : null,
    seasonYear: a.year ?? from.year ?? null,
    startDate: { year: from.year ?? null, month: from.month ?? null, day: from.day ?? null },
    endDate: { year: to.year ?? null, month: to.month ?? null, day: to.day ?? null },
    averageScore: a.score != null ? Math.round(parseFloat(a.score) * 10 * 10) / 10 : null,
    meanScore: null,
    popularity: a.members ?? a.popularity ?? null,
    trending: null,
    favourites: a.favorites ?? null,
    genres,
    studios: { nodes: (a.studios || []).map((s) => ({ id: s.mal_id ?? null, name: s.name, isAnimationStudio: true })) },
    nextAiringEpisode: nae && nae.airing_at
      ? {
          airingAt: Math.round(new Date(nae.airing_at).getTime() / 1000),
          timeUntilAiring: nae.time_until ?? Math.max(0, Math.round(new Date(nae.airing_at).getTime() / 1000 - Date.now() / 1000)),
          episode: nae.episode ?? null,
        }
      : null,
    description: a.synopsis || null,
    siteUrl: a.url || (a.mal_id ? `https://myanimelist.net/anime/${a.mal_id}` : null),
    isAdult: String(a.rating || "").startsWith("Rx") || a.r18 === true ||
             genres.some((g) => g.toLowerCase().includes("hentai")),
    source: null,
    countryOfOrigin: null,
  };
}

/** Bad-data guard: an empty/corrupt pool must NEVER enter the cache. */
function isValidMediaList(items, min = 5) {
  if (!Array.isArray(items) || items.length < min) return false;
  return items.every((m) =>
    m && typeof m === "object" &&
    (m.id != null || m.idMal != null) &&
    (m.title?.romaji || m.title?.english || m.title?.native || m.title?.userPreferred));
}

/** Post-hoc filters shared by all legs (applied to AniList-format media). */
function applyListingFilters(items, { sfw, formatFilter }) {
  let out = items;
  if (sfw) {
    out = out.filter((m) => !m.isAdult &&
      !(m.genres || []).some((g) => ["Hentai", "Ecchi"].includes(g)));
  }
  if (formatFilter.length) {
    out = out.filter((m) => formatFilter.includes(m.format));
  }
  return out;
}

/** Parse ?format=TV,ONA → ["TV","ONA"]; returns [] when absent. */
function parseFormatFilter(raw) {
  return raw ? String(raw).split(",").map((s) => FORMAT_ALIASES[s.trim().toUpperCase()] || s.trim().toUpperCase()).filter(Boolean) : [];
}

module.exports = {
  LIST_COLS, LIST_SCAN_COLS, FORMAT_ALIASES, SORT_MAP,
  buildMediaFromRow, jikanToAniList, isValidMediaList,
  applyListingFilters, parseFormatFilter,
};
