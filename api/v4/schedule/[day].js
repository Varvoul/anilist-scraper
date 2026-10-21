// GET /api/v4/schedule/{day}    day ∈ monday..sunday | today | all
//
// t129 — "same AniList schedule endpoint, powered by the owner's Supabase DB".
// Serves the EXACT response shape of anilist-my-proxy /api/schedule/{day|all}
// (ok/week/applied/data.Page.days with airingSchedules-style items) but reads
// anikoto_data (profile "ruristream") — the anikoto-automation worker keeps a
// full AniList media snapshot in anilist_full_cached, including
// nextAiringEpisode{airingAt, episode}. The result:
//   • completely independent of AniList's health (no graphql.anilist.co call)
//   • drop-in fallback for the site's schedule widget chain
//
// Grouping window matches the proxy: 8 days from JST midnight today,
// buckets = JST broadcast weekdays (monday..sunday), items sorted by airingAt.
// Coverage note: the DB stores the NEXT episode per airing title (not the full
// per-episode window), so each title appears once — the site re-buckets by the
// visitor's local day from the absolute airingAt, which works unchanged.
//
// Params: refresh=1 (bypass cache), format (csv of AniList formats, OR-filter),
//         sfw=true (drops Hentai/Ecchi-genre titles), limit (rows cap, <=200).
// Cache:  exact-key 10-min memory TTL + s-maxage=600 + SWR 86400;
//         serve-stale-on-error keeps the last good window during DB hiccups.

const cache = require("../../_lib/cache");
const { jsonRes, cacheKey } = require("../../_lib/http");
const { supabaseSelect } = require("../../_lib/backends");

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const JST = 9 * 3600;

function jstMidnightTodaySec(nowMs = Date.now()) {
  return Math.floor((nowMs / 1000 + JST) / 86400) * 86400 - JST;
}
function jstWeekdayIdx(epochSec) {
  return Math.floor((epochSec + JST) / 86400) % 7; // 0=Sunday
}
function jstDateStr(epochSec) {
  return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 16) + " JST";
}
// Full friendly date for the NEXT occurrence of a JST weekday (DAYS is Mon-first)
const DAYS_JS = [1, 2, 3, 4, 5, 6, 0]; // monday..sunday → JS getDay() numbers
function nextOccurrenceStr(dayIdxMonFirst, nowSec) {
  const todayIdx = jstWeekdayIdx(nowSec);
  const offset = (DAYS_JS[dayIdxMonFirst] - todayIdx + 7) % 7;
  const d = new Date(((jstMidnightTodaySec(nowSec * 1000) + offset * 86400) + JST) * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][DAYS_JS[dayIdxMonFirst]];
  return `${wd}, ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

const SELECT_COLS = [
  "anilist_id", "mal_id", "title", "next_air_episode",
  "nae:anilist_full_cached->nextAiringEpisode",
  "ti:anilist_full_cached->title",
  "cv:anilist_full_cached->coverImage",
  "bi:anilist_full_cached->bannerImage",
  "fmt:anilist_full_cached->format",
  "stt:anilist_full_cached->status",
  "eps:anilist_full_cached->episodes",
  "dur:anilist_full_cached->duration",
  "asc:anilist_full_cached->averageScore",
  "sy:anilist_full_cached->seasonYear",
  "gen:anilist_full_cached->genres",
  "stu:anilist_full_cached->studios",
  "des:anilist_full_cached->description",
].join(",");

function buildItem(row) {
  const nae = row.nae || {};
  const airingAt = parseInt(nae.airingAt, 10);
  if (!Number.isFinite(airingAt)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: row.anilist_id ? parseInt(row.anilist_id, 10) || null : null,
    airingAt,
    timeUntilAiring: Math.max(0, airingAt - nowSec),
    episode: Number.isFinite(parseInt(nae.episode, 10)) ? parseInt(nae.episode, 10)
      : (Number.isFinite(row.next_air_episode) ? row.next_air_episode : null),
    media: {
      id: row.anilist_id ? parseInt(row.anilist_id, 10) || null : null,
      idMal: row.mal_id ? parseInt(row.mal_id, 10) || null : null,
      title: row.ti || { romaji: row.title || "Unknown" },
      coverImage: row.cv || null,
      bannerImage: row.bi ?? null,
      format: row.fmt ?? null,
      status: row.stt ?? null,
      episodes: row.eps ?? null,
      duration: row.dur ?? null,
      averageScore: row.asc ?? null,
      seasonYear: row.sy ?? null,
      genres: Array.isArray(row.gen) ? row.gen.slice(0, 8) : [],
      studios: row.stu && Array.isArray(row.stu.nodes) ? { nodes: row.stu.nodes } : { nodes: [] },
      description: typeof row.des === "string" ? String(row.des).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260) : null,
      siteUrl: row.anilist_id ? `https://anilist.co/anime/${row.anilist_id}` : null,
    },
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonRes(res, 405, { ok: false, error: "Method not allowed. Use GET." });
  }

  const q = req.query || {};
  const refresh = q.refresh === "1" || q.refresh === "true";
  const rawDay = String(q.day || "").toLowerCase();
  let day = rawDay;
  if (day === "today") day = DAYS[jstWeekdayIdx(jstMidnightTodaySec())];
  const isAll = day === "all";
  if (!isAll && !DAYS.includes(day)) {
    return jsonRes(res, 400, {
      ok: false,
      endpoint: "/api/v4/schedule",
      error: `Invalid day "${q.day || ""}". Use one of: ${DAYS.join(", ")}, today, all.`,
      usage: "/v4/schedule/all · /v4/schedule/{monday..sunday|today}?refresh=1&format=TV,ONA&sfw=true&limit=150",
    });
  }

  const formatFilter = q.format ? String(q.format).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
  const sfw = q.sfw === "true";
  const rowCap = Math.min(Math.max(1, parseInt(q.limit, 10) || 200), 200);

  const key = cacheKey("schedule-db", { day, formatFilter, sfw, rowCap });
  const hit = cache.lookup(key, 10 * 60 * 1000, { fresh: refresh });
  if (hit) {
    const body = { ...hit.body, cache: { ...hit.body.cache, served: hit.state === "HIT" ? "memory TTL hit" : "stale (upstream error guard)" }, _stale: hit.state === "STALE" || undefined };
    return jsonRes(res, 200, body);
  }

  // ── Fetch the airing window from Supabase (owner's DB — no AniList call) ──
  const winStart = jstMidnightTodaySec();
  const startSec = winStart - 1;                 // inclusive boundary (strict > upstream)
  const endSec = winStart + 8 * 86400;           // 8-day window, same as the proxy

  let rows;
  try {
    rows = await supabaseSelect(
      `select=${SELECT_COLS}` +
      `&currently_airing=eq.true` +
      `&anilist_full_cached->nextAiringEpisode->>airingAt=not.is.null` +
      `&limit=${rowCap}`
    );
  } catch (e) {
    console.error("[v4/schedule-db] Supabase failed:", e.message);
    return jsonRes(res, 502, {
      ok: false,
      endpoint: "/api/v4/schedule",
      error: `Supabase unavailable: ${e.message}`,
      hint: "This endpoint reads the owner's Supabase mirror only — retry shortly.",
    });
  }

  // ── Window filter + apply optional query filters ──
  const items = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const it = buildItem(row);
    if (!it) continue;
    if (it.airingAt < startSec || it.airingAt >= endSec) continue;   // outside rolling window
    if (formatFilter.length && !formatFilter.includes(it.media.format)) continue;
    if (sfw && (it.media.genres || []).some((g) => ["Hentai", "Ecchi"].includes(g))) continue;
    items.push(it);
  }

  // ── Group into JST broadcast weekdays ──
  const days = {}; const dayInfo = {};
  DAYS.forEach((name) => { days[name] = []; });
  for (const it of items) {
    const idx = jstWeekdayIdx(it.airingAt);
    days[DAYS[idx]].push(it);
  }
  DAYS.forEach((name) => days[name].sort((a, b) => a.airingAt - b.airingAt));

  const grandTotal = items.length;
  const nowSec = Math.floor(Date.now() / 1000);

  const body = {
    ok: true,
    endpoint: `/api/v4/schedule/${day}`,
    cache: {
      ttl_seconds: 600,
      fetched_at: new Date().toISOString(),
      source: "supabase_anikoto_data",
      note: "anikoto_data.anilist_full_cached (profile ruristream) — independent of AniList API health",
    },
    week: {
      timezone: "Asia/Tokyo",
      utc_offset: "+09:00",
      window_start_jst: jstDateStr(startSec),
      window_end_jst: jstDateStr(endSec - 1),
      total_airing_entries: grandTotal,
    },
    applied: { format: formatFilter.length ? formatFilter : null, sfw: sfw || null, limit: rowCap, refresh: refresh || null },
    coverage: {
      semantics: "one entry per currently-airing title (its NEXT airing episode) within the 8-day JST window",
      rows_scanned: (Array.isArray(rows) ? rows.length : 0),
    },
    data: {
      Page: {
        pageInfo: { days: 7, total: grandTotal },
        dayInfo: Object.fromEntries(DAYS.map((name, i) => [name, { date_jst: nextOccurrenceStr(i, nowSec), count: days[name].length }])),
        days,
        ...(isAll ? {} : { airingSchedules: days[day] }),
      },
    },
  };
  if (!isAll) body.day = {
    name: day,
    timezone: "Asia/Tokyo",
    utc_offset: "+09:00",
    semantics: "this JST broadcast weekday's entries within the rolling 8-day window",
    count: days[day].length,
  };

  cache.put(key, body);
  const cacheCtl = "public, max-age=60, s-maxage=600, stale-while-revalidate=86400";
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", cacheCtl);
  res.end(JSON.stringify(body));
};
