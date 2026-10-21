// GET /api/v4/anime/{id}/characters   (alias: /v4/anime/{id}/voice-actors via rewrite)
//
// Jikan-v4-shaped cast & voice-actor listing with a 3-leg fallback chain (t129):
//   1. AniList GraphQL  — Media.characters.edges (+voiceActors) → jikan transform
//   2. Supabase         — anikoto_data.anilist_full_cached->characters (owner's DB,
//                         full AniList CharacterConnection cached by the automation
//                         worker — works while AniList is down)
//   3. Jikan            — /anime/{mal_id}/characters verbatim
//
// {id} accepts an AniList id OR a MAL id — identity is resolved through Supabase
// (anilist_id / mal_id columns) with `?source=anilist|mal` forcing an override.
//
// Params: perPage (<=50, AniList leg), source, lang (filter voice_actors by
//         language, e.g. ?lang=Japanese), refresh=1.
// Cache:  exact-key 5-min TTL + s-maxage=300 + serve-stale-on-error.

const cache = require("../../../_lib/cache");
const { jsonRes, cacheKey } = require("../../../_lib/http");
const { anilistQuery, supabaseSelect, jikanFetch } = require("../../../_lib/backends");
const { cachedCharsToJikan } = require("../../../_lib/transform");

const CAST_QUERY = `
query ($id: Int, $perPage: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title { romaji english }
    characters(perPage: $perPage, sort: [ROLE, RELEVANCE]) {
      edges {
        role
        node { id name { full native } image { large medium } }
        voiceActors { id name { full } image { large } languageV2 }
      }
    }
  }
}`;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.statusCode = 204; res.setHeader("Access-Control-Allow-Origin", "*"); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { return jsonRes(res, 405, { status: 405, error: "GET only" }); }

  const p = req.query;
  const idNum = parseInt(p.id, 10);
  if (!Number.isFinite(idNum)) {
    return jsonRes(res, 400, { status: 400, error: "Invalid id — usage: /v4/anime/{anilist_id|mal_id}/characters?source=anilist|mal&perPage=50" });
  }
  const fresh = p.refresh === "1" || p.refresh === "true";
  const perPage = Math.min(Math.max(1, parseInt(p.perPage, 10) || 50), 50);
  const langFilter = p.lang ? String(p.lang).toLowerCase() : null;
  const sourceHint = p.source ? String(p.source).toLowerCase() : null;

  const key = cacheKey("cast", { id: idNum, perPage, langFilter, source: sourceHint });
  const hit = cache.lookup(key, cache.TTL_MS_DEFAULT, { fresh });
  if (hit) {
    const body = { ...hit.body, request_cached: true, ...(hit.state === "STALE" ? { _stale: true } : {}) };
    return jsonRes(res, 200, body);
  }

  const filterLang = (data) => langFilter
    ? data.map((c) => ({ ...c, voice_actors: (c.voice_actors || []).filter((v) => String(v.language || "").toLowerCase() === langFilter) }))
    : data;

  const meta = (source, fallback, extra) => ({
    request_hash: `request:v4:cast:${idNum}:${Date.now()}`,
    request_cached: false,
    request_cache_expiry: 300,
    _source: source,
    _fallback: fallback,
    ...extra,
  });

  // ── Identity resolution through the owner's DB (works even mid-outage) ──
  let anilistId = sourceHint === "anilist" ? idNum : null;
  let malId = sourceHint === "mal" ? idNum : null;
  let resolvedRow = null;
  try {
    const rows = await supabaseSelect(
      `select=anilist_id,mal_id,title,chars:anilist_full_cached->characters&or=(anilist_id.eq.${idNum},mal_id.eq.${encodeURIComponent(`"${idNum}"`)})&limit=1`
    );
    if (Array.isArray(rows) && rows.length) {
      resolvedRow = rows[0];
      if (!anilistId && rows[0].anilist_id) anilistId = parseInt(rows[0].anilist_id, 10) || null;
      if (!malId && rows[0].mal_id) malId = parseInt(rows[0].mal_id, 10) || null;
    }
  } catch (e) {
    console.warn("[v4/cast] Supabase id resolution failed:", e.message);
  }
  if (!anilistId && !malId) anilistId = idNum; // last resort: assume AniList id

  // ── Leg 1: AniList ──
  if (anilistId) {
    try {
      const d = await anilistQuery(CAST_QUERY, { id: anilistId, perPage });
      const media = d.Media;
      if (!media) throw new Error(`anilist media ${anilistId} not found`);
      const data = filterLang(cachedCharsToJikan(media.characters?.edges || []));
      const body = {
        ...meta("anilist_api", null, { media: { id: media.id, idMal: media.idMal, title: media.title?.romaji || media.title?.english || null } }),
        data,
      };
      cache.put(key, body);
      return jsonRes(res, 200, body);
    } catch (e1) {
      console.error("[v4/cast] AniList failed:", e1.message, "→ Supabase");
      // fall through to leg 2
    }
  }

  // ── Leg 2: Supabase cached AniList blob ──
  try {
    const selectCols = "select=anilist_id,mal_id,title,chars:anilist_full_cached->characters";
    const rows = resolvedRow
      ? [resolvedRow]
      : await supabaseSelect(`${selectCols}&or=(anilist_id.eq.${idNum},mal_id.eq.${encodeURIComponent(`"${idNum}"`)})&limit=1`);
    if (!Array.isArray(rows) || !rows.length || !rows[0].chars) throw new Error("no cached characters in supabase mirror");
    const row = rows[0];
    const data = filterLang(cachedCharsToJikan(row.chars?.edges || []));
    if (!data.length) throw new Error("cached characters edges empty");
    const body = {
      ...meta("supabase_anikoto_data", "anilist_failed or id-unresolvable", {
        _note: "Served from the owner's Supabase mirror (anilist_full_cached.characters).",
        media: { id: row.anilist_id ? parseInt(row.anilist_id, 10) : null, idMal: row.mal_id ? parseInt(row.mal_id, 10) : null, title: row.title || null },
      }),
      data,
    };
    cache.put(key, body);
    return jsonRes(res, 200, body);
  } catch (e2) {
    console.error("[v4/cast] Supabase failed:", e2.message, "→ Jikan");
    // ── Leg 3: Jikan by MAL id ──
    if (!malId) {
      return jsonRes(res, 200, {
        ...meta("error", `anilist failed; supabase failed: ${e2.message}; no mal_id to try jikan`),
        data: [],
      });
    }
    try {
      const j = await jikanFetch(`/anime/${malId}/characters`);
      const data = Array.isArray(j.data) ? j.data : [];
      const body = {
        ...meta("jikan", `anilist_failed; supabase_failed: ${e2.message}`, {
          media: { id: anilistId, idMal: malId, title: null },
        }),
        data,
      };
      cache.put(key, body);
      return jsonRes(res, 200, body);
    } catch (e3) {
      console.error("[v4/cast] Jikan failed too:", e3.message);
      return jsonRes(res, 200, {
        ...meta("error", `anilist: ${anilistId ? "failed" : "unresolvable"}; supabase: ${e2.message}; jikan: ${e3.message}`),
        data: [],
      });
    }
  }
};
