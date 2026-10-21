// _lib/http.js — tiny shared response helpers (t129).

function jsonRes(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", status === 200 ? "public, max-age=60, s-maxage=300, stale-while-revalidate=86400" : "no-store");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** Build a stable cache key from the endpoint name + a params object (sorted). */
function cacheKey(endpoint, params) {
  const flat = {};
  for (const k of Object.keys(params).sort()) flat[k] = params[k];
  return `${endpoint}:${JSON.stringify(flat)}`;
}

module.exports = { jsonRes, cacheKey };
