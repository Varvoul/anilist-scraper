// GET|POST /api/github-webhook
//
// t130 — push→deploy receiver. The Vercel GitHub App does not deliver
// events for this repo (owner's App installation scope / flaky webhook
// delivery — 0 check-runs observed on push), so GitHub fires a push
// webhook at THIS function, which creates a production deployment of the
// project's linked repo (Varvoul/anilist-scraper@main) via the Vercel API
// using a token scoped to THIS PROJECT ONLY (GH_DEPLOY_TOKEN env var).
//
// Setup (done once by the owner session):
//   env GH_DEPLOY_TOKEN  — Vercel token, scope: project-only (anilist-scraper)
//   env GH_DEPLOY_SECRET — shared secret; GitHub webhook url carries ?secret=
//
// Results in: every `git push origin main` auto-deploys production.

module.exports = async (req, res) => {
  const event = req.headers["x-github-event"];

  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end(JSON.stringify({
      ok: true,
      endpoint: "/api/github-webhook",
      purpose: "GitHub push → production deploy trigger for this project",
      configured: !!process.env.GH_DEPLOY_TOKEN && !!process.env.GH_DEPLOY_SECRET,
      usage: "registered as a GitHub push webhook (POST, ?secret=…)",
    }));
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "POST only" }));
  }

  // shared secret check (URL query, as configured in the GitHub webhook)
  const secret = (req.query && (req.query.secret || req.query.SECRET)) || "";
  if (!process.env.GH_DEPLOY_SECRET || secret !== process.env.GH_DEPLOY_SECRET) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ ok: false, error: "bad or missing secret" }));
  }

  // GitHub webhook handshake / delivery acks
  if (event === "ping") {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, pong: true, configured: !!process.env.GH_DEPLOY_TOKEN }));
  }
  if (event && event !== "push") {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ignored: event }));
  }

  // push event (or event-less direct call) → create a production deployment
  const ref = "main";
  const commit = ((req.body && typeof req.body === "object" && req.body.after) || "").slice(0, 7) || "HEAD";
  try {
    const r = await fetch("https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1&skipProductionDomainSelection=1", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GH_DEPLOY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "anilist-scraper",
        target: "production",
        gitSource: { type: "github", org: "Varvoul", repo: "anilist-scraper", ref },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: `vercel deploy HTTP ${r.status}`, details: (j.error && j.error.message) || j }));
    }
    console.log(`[github-webhook] deployment created for ${commit}:`, j.id || j.uid);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({
      ok: true,
      triggered: true,
      ref,
      commit,
      deployment: j.id || j.uid,
      url: j.url || null,
      readyState: j.readyState || null,
    }));
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
