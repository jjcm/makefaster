/**
 * Leaderboard submission client + the pure builders that turn a session's
 * results.json into the two endpoint payloads.
 */

export const DEFAULT_API_BASE = "https://makefaster.dev";
const SUBMIT_TIMEOUT_MS = 10_000;
const MAX_IMPROVEMENTS = 50;
const MAX_TIPS = 10;
const TIP_TEXT_MAX = 280;
const TIP_ABOUT_MAX = 80;

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
    ...(sitePrUrl(results) ? { prUrl: sitePrUrl(results) } : {}),
    ...keepSplit(results),
  };
}

/**
 * The split between kept changes that were reusable techniques and kept changes
 * that were findings about this site only, as whole percents that add to 100.
 *
 * Counted from the iterations rather than from whatever `genericKeepPct` the
 * session wrote, because these percentages have to describe the same set of
 * keeps that `buildImprovementsPayload` files on the improvement board — a site
 * row claiming "80% generic" while five categories were submitted would be
 * worse than no number. A keep that does not say which it is counts as generic,
 * for the same reason: that is what the improvement board receives.
 *
 * A run that kept nothing has no split to report, and sends neither field.
 */
function keepSplit(results) {
  const keeps = (results?.iterations || []).filter((it) => it && it.kept === true);
  if (keeps.length === 0) return {};
  const generic = keeps.filter((it) => it.generic !== false).length;
  const genericKeepPct = Math.round((generic / keeps.length) * 100);
  return { genericKeepPct, siteSpecificKeepPct: 100 - genericKeepPct };
}

/**
 * The pull request the loop's changes were opened as, which the site board
 * links the site name to. `pr` is read as well as `prUrl` because the server
 * accepts both spellings and a skill that wrote the short one should not lose
 * the link.
 */
function sitePrUrl(results) {
  var value = results?.site?.prUrl || results?.site?.pr;
  return typeof value === "string" && /^https?:\/\//i.test(value.trim()) ? value.trim() : "";
}

/**
 * The session's tips: short notes to the makefaster catalog maintainers about
 * the catalog itself ("these two rows are one technique", "skip the SPA rows
 * when the bundle is prebuilt"). They are private by design — the server
 * stores them and serves them to nobody: not on either public board, not in
 * the checklist another run imports, and never in this CLI's own output. The
 * caps mirror the server's, which clamps rather than rejects.
 */
function buildTips(results) {
  const tips = Array.isArray(results?.tips) ? results.tips : [];
  return tips
    .filter((tip) => tip && typeof tip.text === "string" && tip.text.trim() !== "")
    .slice(0, MAX_TIPS)
    .map((tip) => ({
      text: tip.text.trim().slice(0, TIP_TEXT_MAX),
      ...(typeof tip.about === "string" && tip.about.trim() !== ""
        ? { about: tip.about.trim().slice(0, TIP_ABOUT_MAX) }
        : {}),
    }));
}

/**
 * One submit-site payload per mode that has complete baseline+final numbers.
 * Both ends of the run are sent — `lcpBefore`/`ttiBefore` are the measured
 * baseline, `lcpRaw`/`ttiRaw` the measurement after the last kept change — and
 * the deltas between them are computed here (percent vs. baseline, negative =
 * faster) so the skill only ever reports raw measurements. `prUrl` rides along
 * when the session recorded one; every field but the metrics is optional, so an
 * older results.json still submits.
 *
 * The session's private tips ride along on the first payload only, so a run
 * that submits both a cold and a warm row does not store every note twice.
 */
export function buildSitePayloads(results, siteUrl) {
  const payloads = ["cold", "warm"]
    .map((mode) => modePayload(results, mode, siteUrl))
    .filter(Boolean);
  const tips = buildTips(results);
  if (payloads.length > 0 && tips.length > 0) {
    payloads[0] = { ...payloads[0], tips };
  }
  return payloads;
}

/**
 * The anonymous improvements payload: kept iterations only, no URL, no site
 * identity — just names, descriptions, and measured deltas. The fields are
 * listed one by one rather than spread, so an iteration's `notes` (where the
 * skill puts everything specific to this repo) cannot ride along.
 *
 * A keep marked `generic: false` is a finding about one product rather than a
 * technique anyone else can apply, so it stays in results.json and on the site
 * row's split instead of becoming a row on the shared improvement board. A keep
 * that says nothing is submitted, which is what every session written before
 * the field existed does.
 */
export function buildImprovementsPayload(results) {
  const kept = (results?.iterations || [])
    .filter((it) => it && it.kept === true && it.name && it.generic !== false)
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
