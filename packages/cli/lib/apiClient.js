/**
 * Leaderboard submission client + the pure builders that turn a session's
 * results.json into the two endpoint payloads.
 */

export const DEFAULT_API_BASE = "https://makefaster.dev";
const SUBMIT_TIMEOUT_MS = 10_000;
const MAX_IMPROVEMENTS = 50;

export function resolveApiBase({ flag, env = process.env } = {}) {
  return (flag || env.MAKEFASTER_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
}

async function postJson(apiBase, path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = Array.isArray(body.errors) ? body.errors.join("; ") : `HTTP ${res.status}`;
      throw new Error(`POST ${path} failed: ${reason}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function submitSite(apiBase, payload) {
  return postJson(apiBase, "/api/submit-site", payload);
}

export function submitImprovements(apiBase, payload) {
  return postJson(apiBase, "/api/submit-improvements", payload);
}

function pctChange(baseline, final) {
  if (!(baseline > 0)) return null;
  return Math.round(((final - baseline) / baseline) * 1000) / 10;
}

function modePayload(results, mode, siteUrl) {
  const baseline = results?.baseline?.[mode];
  const final = results?.final?.[mode];
  const values = [baseline?.lcpMs, baseline?.ttiMs, final?.lcpMs, final?.ttiMs];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const lcpDelta = pctChange(baseline.lcpMs, final.lcpMs);
  const ttiDelta = pctChange(baseline.ttiMs, final.ttiMs);
  if (lcpDelta === null || ttiDelta === null) return null;
  return {
    url: siteUrl,
    mode,
    lcpBefore: Math.round(baseline.lcpMs),
    lcpRaw: Math.round(final.lcpMs),
    lcpDelta,
    ttiBefore: Math.round(baseline.ttiMs),
    ttiRaw: Math.round(final.ttiMs),
    ttiDelta,
    ...(results?.site?.name ? { name: results.site.name } : {}),
    ...(results?.site?.favicon ? { favicon: results.site.favicon } : {}),
  };
}

/**
 * One submit-site payload per mode that has complete baseline+final numbers.
 * Both ends of the run are sent — `lcpBefore`/`ttiBefore` are the measured
 * baseline, `lcpRaw`/`ttiRaw` the measurement after the last kept change — and
 * the deltas between them are computed here (percent vs. baseline, negative =
 * faster) so the skill only ever reports raw measurements.
 */
export function buildSitePayloads(results, siteUrl) {
  return ["cold", "warm"]
    .map((mode) => modePayload(results, mode, siteUrl))
    .filter(Boolean);
}

/**
 * The anonymous improvements payload: kept iterations only, no URL, no site
 * identity — just names, descriptions, and measured deltas. The fields are
 * listed one by one rather than spread, so an iteration's `notes` (where the
 * skill puts everything specific to this repo) cannot ride along.
 */
export function buildImprovementsPayload(results) {
  const kept = (results?.iterations || [])
    .filter((it) => it && it.kept === true && it.name)
    .filter((it) => typeof it.deltaMs === "number" || typeof it.deltaPct === "number")
    .slice(0, MAX_IMPROVEMENTS)
    .map((it) => ({
      name: String(it.name).slice(0, 120),
      description: String(it.description || "").slice(0, 500),
      ...(typeof it.deltaMs === "number" ? { deltaMs: it.deltaMs } : {}),
      ...(typeof it.deltaPct === "number" ? { deltaPct: it.deltaPct } : {}),
    }));
  return kept.length > 0 ? { improvements: kept } : null;
}
