"use strict";

// api/_lib/auth.js
// Auth gate wrapping every route handler. Same pattern as the CF workers:
//   1. X-Proxy-Key header must match process.env.HEADER_SECRET
//   2. URL path must include the /p/<process.env.URL_PATH_SECRET>/ prefix
//   3. Bare homepage (/, /api, /api/v4/anime) serves an HTML doc page
//      (no auth, no secrets exposed)
//   4. OPTIONS preflight -> 204 with CORS headers
//   5. 180 req/min per-IP rate limit (in-memory counter)
//   6. Bot UA heuristic blocks curl/python-requests/wget/etc when auth is
//      missing (defense in depth; does NOT affect requests that carry a
//      valid X-Proxy-Key)
//
// Usage:
//   const { withAuth } = require("./_lib/auth");
//   const handler = async (req, res) => { /* ... */ };
//   module.exports = withAuth(handler);

const crypto = require("crypto");

// Minimal HTML doc — no secrets, no endpoint enumeration. Just confirms the
// proxy is alive and authed consumers should consult their docs.
const DOC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AniList Proxy</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0e1117;color:#c9d1d9;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{max-width:560px;padding:36px 40px;border:1px solid #30363d;border-radius:10px;background:#161b22;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.4)}
  h1{margin:0 0 8px;font-size:22px;color:#58a6ff;font-weight:600}
  p{margin:0;color:#8b949e;line-height:1.5;font-size:14px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#7ee787;margin-right:6px;vertical-align:middle}
</style>
</head>
<body>
<div class="card">
<h1>AniList Proxy</h1>
<p><span class="dot"></span>Authenticated. See documentation.</p>
</div>
</body>
</html>`;

// "Doc paths" — bare homepage AND the API root paths that the vercel.json
// root rewrite routes "/" to. Visiting any of these without auth serves the
// HTML doc page (no secrets exposed). Vercel sets req.url to either the
// source or the destination of a rewrite depending on runtime version, so
// we accept both shapes.
const DOC_PATHS = new Set(["/", "/api", "/api/v4/anime"]);

// UA substrings of CLI scrapers / library HTTP clients. Browser UAs pass
// through to the normal auth check; only "obviously automated" clients are
// pre-emptively rejected when auth is missing.
const BOT_UA_PATTERNS = [
  "curl", "wget", "python-requests", "python-httpx", "python-urllib",
  "httpie", "scrapy", "axios/", "got/", "node-fetch", "postmanruntime",
  "insomnia", "httpclient", "go-http-client", "java/", "okhttp/",
  "libwww-perl", "lwp-", "mechanize", "aiohttp", "go-resty", "httpx/",
  "requests/", "fasthttp",
];

function looksLikeBot(ua) {
  if (!ua) return true;
  const lower = String(ua).toLowerCase();
  return BOT_UA_PATTERNS.some((p) => lower.includes(p));
}

// In-memory per-IP rate limiter: 180 req/min. Serverless-instance scoped —
// cold starts reset the counter, which is fine for abuse protection (the
// edge CDN cache + per-instance limit compound into a strong effective
// ceiling; a distributed flood is the edge layer's job).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 180;
const rateBuckets = new Map(); // ip -> { count, resetAt }

function rateLimitHit(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count++;
  return b.count > RATE_MAX;
}

// Periodic sweep so the Map doesn't grow unbounded on long-lived instances.
if (typeof setInterval === "function") {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of rateBuckets) {
      if (now >= b.resetAt) rateBuckets.delete(ip);
    }
  }, 5 * 60 * 1000);
  if (t && typeof t.unref === "function") t.unref();
}

function safeEqual(a, b) {
  if (typeof a !== "string") a = String(a);
  if (typeof b !== "string") b = String(b);
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch (_) {
    return false;
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Proxy-Key");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const h = req.headers || {};
  const xff = h["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  if (h["x-real-ip"]) return String(h["x-real-ip"]);
  return "unknown";
}

function serveDoc(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(DOC_HTML);
}

function withAuth(handler) {
  return async (req, res) => {
    // CORS on every response (authed, preflight, 401, 429, doc, error).
    setCors(res);

    // 1) OPTIONS preflight — no auth, just 204 + CORS.
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Normalize URL path (strip querystring, collapse trailing slashes).
    // req.url in Vercel serverless functions is the path the client hit,
    // including any /p/<secret>/ prefix. We parse it manually because the
    // native URL constructor is heavier than needed here.
    const rawUrl = req.url || "/";
    const qIdx = rawUrl.indexOf("?");
    const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const path = rawPath.replace(/\/+$/, "") || "/";

    // 2) Doc endpoint — no auth, no secrets. Apply the bot UA guard even
    //    here so obvious scrapers can't enumerate the proxy root.
    if (DOC_PATHS.has(path)) {
      const ua = String(req.headers["user-agent"] || "");
      if (looksLikeBot(ua)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      }
      return serveDoc(res);
    }

    // 3) Env-var sanity. Fail CLOSED if either secret is missing — better
    //    to 500 than to let every request through unauthenticated.
    const headerSecret = process.env.HEADER_SECRET;
    const urlSecret = process.env.URL_PATH_SECRET;
    if (!headerSecret || !urlSecret) {
      console.error("[auth] HEADER_SECRET or URL_PATH_SECRET not set in env");
      return sendJson(res, 500, {
        ok: false,
        error: "Authentication not configured — required environment variables are missing.",
      });
    }

    // 4) Rate limit per client IP — 180 req/min.
    const ip = clientIp(req);
    if (rateLimitHit(ip)) {
      res.setHeader("Retry-After", "60");
      return sendJson(res, 429, {
        ok: false,
        error: "Rate limit exceeded (180 req/min per IP).",
      });
    }

    const providedKey = req.headers["x-proxy-key"];
    const keyOk = !!providedKey && safeEqual(providedKey, headerSecret);

    // 5) Bot UA heuristic — block obvious scrapers/crawlers when auth is
    //    missing. (If the X-Proxy-Key is valid we let the request through
    //    regardless of UA — the URL path check below is the second gate.)
    const ua = String(req.headers["user-agent"] || "");
    if (!keyOk && looksLikeBot(ua)) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized." });
    }

    // 6) X-Proxy-Key header must match process.env.HEADER_SECRET.
    if (!keyOk) {
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized — missing or invalid X-Proxy-Key header.",
      });
    }

    // 7) URL path must include the /p/<secret>/ prefix.
    const barePrefix = `/p/${urlSecret}`;
    const prefix = `${barePrefix}/`;
    const prefixOk = path === barePrefix || path.startsWith(prefix);
    if (!prefixOk) {
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized — missing or invalid URL path secret.",
      });
    }

    // 8) Strip the /p/<secret>/ prefix from req.url so the wrapped handler
    //    sees the real route (e.g. /api/currently-airing instead of
    //    /p/<secret>/api/currently-airing). Cache-key builders and URL
    //    parsers in the wrapped handler all read req.url, so this rewrite
    //    is mandatory. Vercel's Express-like req lets us mutate req.url
    //    directly — no need to synthesize a new request object.
    let restPath;
    if (path === barePrefix) {
      restPath = "/";
    } else {
      // path starts with prefix "/p/<secret>/"; slice off everything up to
      // (but not including) the leading slash of the real route.
      // prefix.length - 1 is the index of the final "/" in the prefix.
      restPath = path.slice(prefix.length - 1);
    }
    req.url = qIdx >= 0 ? restPath + rawUrl.slice(qIdx) : restPath;

    try {
      await handler(req, res);
    } catch (err) {
      console.error("[auth] wrapped handler threw:", err && err.message, err && err.stack);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "Internal error.", detail: err && err.message });
      } else {
        try { res.end(); } catch (_) { /* noop */ }
      }
    }
  };
}

module.exports = { withAuth, setCors };
