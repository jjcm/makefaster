/**
 * Makefaster data API — tiny fetch wrappers + client-side submission stubs.
 *
 * Read endpoints (static JSON, live now):
 *   GET data/sites.json         -> MakefasterAPI.getSites()
 *   GET data/improvements.json  -> MakefasterAPI.getImprovements()
 *
 * Write endpoints (client stubs, localStorage-backed for now):
 *   POST /api/submit-site          -> MakefasterAPI.submitSite(payload)
 *   POST /api/submit-improvements  -> MakefasterAPI.submitImprovements(payload)
 *
 * The submit stubs append to localStorage so the autoresearch skill can be
 * developed against the final payload shapes before the real backend exists.
 * A later pass swaps their internals for real fetch() POSTs with the same
 * signatures and return shapes.
 */
(function (global) {
  "use strict";

  var DATA_URLS = {
    sites: "data/sites.json",
    improvements: "data/improvements.json",
  };

  var STORE_KEYS = {
    sites: "makefaster.submissions.sites",
    improvements: "makefaster.submissions.improvements",
  };

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("GET " + url + " responded " + res.status);
      return res.json();
    });
  }

  /**
   * Site leaderboard rows.
   * Row shape: { url, favicon, lcpRaw, lcpDelta, ttiRaw, ttiDelta, mode }
   * (plus optional extras this stub dataset also carries: name, tests, measuredAt)
   * lcpDelta / ttiDelta are percentages vs. baseline (negative = faster).
   * mode is "cold" or "warm".
   */
  function getSites() {
    return getJson(DATA_URLS.sites);
  }

  /**
   * Improvement leaderboard categories (top 50).
   * Shape: { name, count, avgImprovementMs, avgImprovementPct }
   * (plus optional extras: rank, description, icon)
   */
  function getImprovements() {
    return getJson(DATA_URLS.improvements);
  }

  function readStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch (err) {
      return [];
    }
  }

  function appendStore(key, entry) {
    var all = readStore(key);
    all.push(entry);
    localStorage.setItem(key, JSON.stringify(all));
    return all.length;
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
   * Stub for POST /api/submit-site — one measurement run for one site.
   *
   * Payload shape:
   * {
   *   url:      "example.com",        // required — bare domain
   *   mode:     "cold" | "warm",      // required
   *   lcpRaw:   1842,                 // required — ms
   *   lcpDelta: -34,                  // required — % vs. baseline (negative = faster)
   *   ttiRaw:   2945,                 // required — ms
   *   ttiDelta: -29,                  // required — % vs. baseline
   *   name:      "Example",           // optional display name
   *   favicon:   "https://...",       // optional favicon URL
   *   tests:     6,                   // optional test-run count
   *   measuredAt:"2024-05-12T14:15:00Z" // optional ISO timestamp
   * }
   *
   * Resolves { ok: true, endpoint, queued } where queued is the number of
   * submissions currently held in localStorage.
   */
  function submitSite(payload) {
    var invalid = assertFields(payload, ["url", "mode", "lcpRaw", "lcpDelta", "ttiRaw", "ttiDelta"], "submitSite");
    if (invalid) return invalid;
    if (payload.mode !== "cold" && payload.mode !== "warm") {
      return Promise.reject(new Error("submitSite: mode must be 'cold' or 'warm'"));
    }
    var queued = appendStore(STORE_KEYS.sites, {
      payload: payload,
      receivedAt: new Date().toISOString(),
    });
    return Promise.resolve({ ok: true, endpoint: "/api/submit-site", queued: queued });
  }

  /**
   * Stub for POST /api/submit-improvements — improvements applied to one site.
   *
   * Payload shape:
   * {
   *   url: "example.com",                   // required
   *   improvements: [                       // required, at least one entry
   *     {
   *       category:  "Gzip / Brotli Compression", // required — category name
   *       deltaMs:   -412,                  // optional — ms saved (negative = faster)
   *       deltaPct:  -28.6,                 // optional — % vs. baseline
   *       appliedAt: "2024-05-12T14:15:00Z" // optional ISO timestamp
   *     }
   *   ]
   * }
   *
   * Resolves { ok: true, endpoint, queued }.
   */
  function submitImprovements(payload) {
    var invalid = assertFields(payload, ["url", "improvements"], "submitImprovements");
    if (invalid) return invalid;
    if (!Array.isArray(payload.improvements) || payload.improvements.length === 0) {
      return Promise.reject(new Error("submitImprovements: improvements must be a non-empty array"));
    }
    for (var i = 0; i < payload.improvements.length; i++) {
      if (!payload.improvements[i] || !payload.improvements[i].category) {
        return Promise.reject(new Error("submitImprovements: improvements[" + i + "] is missing 'category'"));
      }
    }
    var queued = appendStore(STORE_KEYS.improvements, {
      payload: payload,
      receivedAt: new Date().toISOString(),
    });
    return Promise.resolve({ ok: true, endpoint: "/api/submit-improvements", queued: queued });
  }

  global.MakefasterAPI = {
    getSites: getSites,
    getImprovements: getImprovements,
    submitSite: submitSite,
    submitImprovements: submitImprovements,
  };
})(window);
