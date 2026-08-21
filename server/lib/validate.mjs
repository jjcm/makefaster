/**
 * Request-body validation for the two write endpoints. These are the public
 * system boundary, so everything is checked and clamped here; the rest of the
 * server trusts validated values.
 */

import { normalizeSiteUrl } from "./sites.mjs";

const MODES = new Set(["cold", "warm"]);
const RAW_MS_MAX = 600_000; // ten minutes — beyond that it's garbage, not slow
const DELTA_MS_LIMIT = 600_000;
const DELTA_PCT_MIN = -100; // can't get more than 100% faster
const DELTA_PCT_MAX = 500;
const IMPROVEMENTS_MAX = 50;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

function finiteInRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isHttpUrl(value) {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * POST /api/submit-site
 * { url, favicon?, name?, lcpRaw, lcpDelta, ttiRaw, ttiDelta, mode: cold|warm }
 * Deltas are percentages vs. the pre-loop baseline; negative = faster.
 */
export function validateSitePayload(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }

  const url = normalizeSiteUrl(body.url);
  if (!url) errors.push("url must be a valid public hostname, e.g. \"example.com\"");
  if (!MODES.has(body.mode)) errors.push("mode must be \"cold\" or \"warm\"");
  if (!finiteInRange(body.lcpRaw, 0, RAW_MS_MAX)) errors.push(`lcpRaw must be a number of ms between 0 and ${RAW_MS_MAX}`);
  if (!finiteInRange(body.ttiRaw, 0, RAW_MS_MAX)) errors.push(`ttiRaw must be a number of ms between 0 and ${RAW_MS_MAX}`);
  if (!finiteInRange(body.lcpDelta, DELTA_PCT_MIN, DELTA_PCT_MAX)) errors.push(`lcpDelta must be a percentage between ${DELTA_PCT_MIN} and ${DELTA_PCT_MAX} (negative = faster)`);
  if (!finiteInRange(body.ttiDelta, DELTA_PCT_MIN, DELTA_PCT_MAX)) errors.push(`ttiDelta must be a percentage between ${DELTA_PCT_MIN} and ${DELTA_PCT_MAX} (negative = faster)`);
  if (body.favicon !== undefined && body.favicon !== null && !isHttpUrl(body.favicon)) errors.push("favicon must be an http(s) URL when provided");
  if (body.name !== undefined && body.name !== null && (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 200)) errors.push("name must be a short string when provided");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      url,
      mode: body.mode,
      lcpRaw: Math.round(body.lcpRaw),
      lcpDelta: Math.round(body.lcpDelta * 10) / 10,
      ttiRaw: Math.round(body.ttiRaw),
      ttiDelta: Math.round(body.ttiDelta * 10) / 10,
      ...(body.favicon ? { favicon: body.favicon } : {}),
      ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}),
    },
  };
}

/**
 * POST /api/submit-improvements — anonymous by design.
 * { improvements: [{ name, description?, deltaMs?, deltaPct? }] }
 * Any url/site field a client sends is discarded, never stored. Each entry
 * needs a name and at least one delta (negative = faster).
 */
export function validateImprovementsPayload(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  if (!Array.isArray(body.improvements) || body.improvements.length === 0) {
    return { ok: false, errors: ["improvements must be a non-empty array"] };
  }
  if (body.improvements.length > IMPROVEMENTS_MAX) {
    return { ok: false, errors: [`improvements is capped at ${IMPROVEMENTS_MAX} entries per submission`] };
  }

  const value = [];
  body.improvements.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`improvements[${i}] must be an object`);
      return;
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > NAME_MAX) {
      errors.push(`improvements[${i}].name must be a 1–${NAME_MAX} character string`);
      return;
    }
    const hasMs = entry.deltaMs !== undefined && entry.deltaMs !== null;
    const hasPct = entry.deltaPct !== undefined && entry.deltaPct !== null;
    if (hasMs && !finiteInRange(entry.deltaMs, -DELTA_MS_LIMIT, DELTA_MS_LIMIT)) {
      errors.push(`improvements[${i}].deltaMs must be a number of ms (negative = faster)`);
      return;
    }
    if (hasPct && !finiteInRange(entry.deltaPct, DELTA_PCT_MIN, DELTA_PCT_MAX)) {
      errors.push(`improvements[${i}].deltaPct must be a percentage (negative = faster)`);
      return;
    }
    if (!hasMs && !hasPct) {
      errors.push(`improvements[${i}] needs at least one of deltaMs or deltaPct`);
      return;
    }
    if (entry.description !== undefined && entry.description !== null && typeof entry.description !== "string") {
      errors.push(`improvements[${i}].description must be a string when provided`);
      return;
    }
    value.push({
      name,
      description: typeof entry.description === "string" ? entry.description.trim().slice(0, DESCRIPTION_MAX) : "",
      ...(hasMs ? { deltaMs: entry.deltaMs } : {}),
      ...(hasPct ? { deltaPct: entry.deltaPct } : {}),
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}
