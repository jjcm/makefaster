/**
 * Makefaster data API — fetch wrappers over the real endpoints.
 *
 * Read endpoints:
 *   GET /data/sites.json         -> getSites()
 *   GET /data/improvements.json  -> getImprovements()
 *   Both are served live from the leaderboard tables by the Go server, so the
 *   boards reflect submissions rather than the committed seed files.
 *
 * Write endpoints (the `npx makefaster` skill posts these; the pages only
 * read):
 *   POST /api/submit-site          -> submitSite(payload)
 *   POST /api/submit-improvements  -> submitImprovements(payload)
 *
 * When the SPA is hosted apart from the API (e.g. a static CDN plus a deployed
 * server), set the API origin before the app module loads:
 *   <script>window.MAKEFASTER_API_BASE = "https://api.example.com";</script>
 * Same-origin absolute paths are used otherwise.
 */

const DATA_PATHS = {
  sites: "/data/sites.json",
  improvements: "/data/improvements.json",
};

function apiBase() {
  return (window.MAKEFASTER_API_BASE || "").replace(/\/$/, "");
}

function getJson(path) {
  const url = apiBase() + path;
  return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
    if (!res.ok) throw new Error("GET " + url + " responded " + res.status);
    return res.json();
  });
}

function postJson(path, payload) {
  const url = apiBase() + path;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  }).then(function (res) {
    return res.json().catch(function () {
      return {};
    }).then(function (body) {
      if (!res.ok) {
        var reason = body && body.errors ? body.errors.join("; ") : "HTTP " + res.status;
        throw new Error("POST " + path + " failed: " + reason);
      }
      return body;
    });
  });
}

/**
 * Site leaderboard rows.
 * Row shape: { name, url, favicon, lcpBefore, lcpRaw, lcpDelta, ttiBefore,
 *              ttiRaw, ttiDelta, mode, tests, measuredAt, prUrl?,
 *              genericKeepPct?, siteSpecificKeepPct? }
 * lcpDelta / ttiDelta are percentages vs. baseline (negative = faster).
 * mode is "cold" or "warm".
 * prUrl is the pull request the run was opened as, absent when there is none.
 * genericKeepPct / siteSpecificKeepPct split the run's kept changes into
 * reusable techniques and site-specific findings; both are absent when the run
 * reported no split.
 */
export function getSites() {
  return getJson(DATA_PATHS.sites);
}

/**
 * Improvement leaderboard categories, ranked. Built entirely from community
 * submissions, so the list starts empty and grows as loops report results.
 * Shape: { rank, name, description, count, avgImprovementMs,
 *          avgImprovementPct, icon }
 */
export function getImprovements() {
  return getJson(DATA_PATHS.improvements);
}

function assertFields(payload, fields, label) {
  if (!payload || typeof payload !== "object") {
    return Promise.reject(new Error(label + ": payload must be an object"));
  }
  for (var i = 0; i < fields.length; i++) {
    if (payload[fields[i]] === undefined || payload[fields[i]] === null) {
      return Promise.reject(new Error(label + ": missing required field '" + fields[i] + "'"));
    }
  }
  return null;
}

/**
 * POST /api/submit-site — one measurement run for one site. The URL and
 * favicon are displayed on the public site leaderboard.
 *
 * Payload:
 * {
 *   url:      "example.com",        // required — bare domain (scheme ok)
 *   mode:     "cold" | "warm",      // required
 *   lcpRaw:   1842,                 // required — ms
 *   lcpDelta: -34,                  // required — % vs. baseline (negative = faster)
 *   ttiRaw:   2945,                 // required — ms
 *   ttiDelta: -29,                  // required — % vs. baseline
 *   name:     "Example",            // optional display name — the product's
 *                                   //   own name, not the deployment's
 *   favicon:  "https://...",        // optional favicon URL
 *   prUrl:    "https://github.com/owner/repo/pull/1", // optional; also read
 *                                   //   as `pr`. The site name on the board
 *                                   //   links to it.
 *   genericKeepPct:      80,        // optional — % of the run's kept changes
 *   siteSpecificKeepPct: 20         //   that were reusable techniques vs.
 *                                   //   findings about this site only. Either
 *                                   //   one implies the other; both 0 (or
 *                                   //   omitted) means no split was reported.
 * }
 *
 * Resolves the server response: { ok, created, row }.
 */
export function submitSite(payload) {
  var invalid = assertFields(payload, ["url", "mode", "lcpRaw", "lcpDelta", "ttiRaw", "ttiDelta"], "submitSite");
  if (invalid) return invalid;
  if (payload.mode !== "cold" && payload.mode !== "warm") {
    return Promise.reject(new Error("submitSite: mode must be 'cold' or 'warm'"));
  }
  return postJson("/api/submit-site", payload);
}

/**
 * POST /api/submit-improvements — anonymous by design: no URL, no site
 * identity, just what was improved and by how much. The server embeds each
 * entry and either folds it into the closest existing category (cosine
 * similarity above threshold) or creates a new category on the improvement
 * leaderboard.
 *
 * Payload:
 * {
 *   improvements: [                  // required, 1–50 entries
 *     {
 *       name:        "Inline critical CSS",   // required
 *       description: "Inlined above-the-fold styles", // recommended
 *       deltaMs:     -120,           // ms saved (negative = faster)
 *       deltaPct:    -8.5            // % vs. baseline (negative = faster)
 *     }                              // at least one delta required
 *   ]
 * }
 *
 * Resolves the server response:
 * { ok, results: [{ input, action: "matched"|"created", category, similarity }],
 *   embedder, threshold }.
 */
export function submitImprovements(payload) {
  var invalid = assertFields(payload, ["improvements"], "submitImprovements");
  if (invalid) return invalid;
  if (!Array.isArray(payload.improvements) || payload.improvements.length === 0) {
    return Promise.reject(new Error("submitImprovements: improvements must be a non-empty array"));
  }
  for (var i = 0; i < payload.improvements.length; i++) {
    var entry = payload.improvements[i];
    if (!entry || !entry.name) {
      return Promise.reject(new Error("submitImprovements: improvements[" + i + "] is missing 'name'"));
    }
    if ((entry.deltaMs === undefined || entry.deltaMs === null) &&
        (entry.deltaPct === undefined || entry.deltaPct === null)) {
      return Promise.reject(new Error("submitImprovements: improvements[" + i + "] needs deltaMs or deltaPct"));
    }
  }
  return postJson("/api/submit-improvements", payload);
}

// Also published on window so console pokes and third-party embeds keep the
// entry point they have always had.
window.MakefasterAPI = { getSites, getImprovements, submitSite, submitImprovements };
