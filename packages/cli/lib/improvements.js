/**
 * Import the top improvement categories — the checklist of likely wins the loop
 * consults. Sources, in order of freshness:
 *
 *   1. an explicit --improvements <path|url> override,
 *   2. the live leaderboard:   <apiBase>/data/improvements.json
 *   3. the repo on GitHub:     https://raw.githubusercontent.com/jjcm/makefaster/main/data/improvements.json
 *   4. the target repo itself: <cwd>/data/improvements.json (when present)
 *   5. the checklist bundled with this CLI (packages/cli/data/improvements.json).
 *
 * The public boards only carry real submissions, so every remote source is
 * empty until enough runs land — and an empty board is not a usable checklist.
 * That is why the bundled copy exists and is a plain catalog of techniques with
 * no measurements attached: it always gives the agent somewhere to start.
 *
 * The checklist is a guide of what has worked across sites — the skill is
 * told explicitly that it is NOT a script to apply blindly.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAW_GITHUB_URL = "https://raw.githubusercontent.com/jjcm/makefaster/main/data/improvements.json";
const FETCH_TIMEOUT_MS = 6_000;
const TOP_N = 50;

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLED_CHECKLIST_PATH = join(CLI_ROOT, "data", "improvements.json");

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${url} responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isValidChecklist(data) {
  return Array.isArray(data) && data.length > 0 && data.every((row) => row && typeof row.name === "string");
}

/**
 * The checklist rows, reduced to the fields the walk needs. This is a
 * whitelist on purpose: whatever else a source carries — server bookkeeping,
 * private tips, anything a future API adds — never reaches the agent's
 * imported checklist. `subsumes` is the one optional extra: the names of rows
 * a keep on this row makes redundant, so the agent can skip them instead of
 * re-proving the same technique.
 */
function topFifty(categories) {
  return [...categories]
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, TOP_N)
    .map(({ name, description, count, avgImprovementMs, avgImprovementPct, rank, subsumes }) => ({
      rank, name, description, count, avgImprovementMs, avgImprovementPct,
      ...(Array.isArray(subsumes) && subsumes.every((s) => typeof s === "string") && subsumes.length > 0
        ? { subsumes }
        : {}),
    }));
}

/**
 * @param {object} args
 * @param {string|null} args.override --improvements value (path or URL)
 * @param {string} args.apiBase
 * @param {string} args.cwd target repo
 * @param {string} [args.rawUrl] GitHub-raw fallback (injectable for tests)
 * @returns {Promise<{categories: Array<object>, source: string}>}
 */
export async function importChecklist({ override, apiBase, cwd, rawUrl = RAW_GITHUB_URL }) {
  const attempts = [];

  if (override) {
    if (/^https?:\/\//i.test(override)) {
      attempts.push({ source: override, load: () => fetchJson(override) });
    } else {
      const path = isAbsolute(override) ? override : resolve(cwd, override);
      attempts.push({ source: path, load: () => readJsonFile(path) });
    }
  } else {
    if (apiBase) {
      attempts.push({ source: `${apiBase}/data/improvements.json`, load: () => fetchJson(`${apiBase}/data/improvements.json`) });
    }
    attempts.push({ source: rawUrl, load: () => fetchJson(rawUrl) });
    attempts.push({ source: join(cwd, "data", "improvements.json"), load: () => readJsonFile(join(cwd, "data", "improvements.json")) });
    attempts.push({ source: "bundled fallback", load: () => readJsonFile(BUNDLED_CHECKLIST_PATH) });
  }

  const failures = [];
  for (const attempt of attempts) {
    try {
      const data = await attempt.load();
      if (!isValidChecklist(data)) throw new Error("not a category list");
      return { categories: topFifty(data), source: attempt.source };
    } catch (err) {
      failures.push(`${attempt.source}: ${err.message}`);
    }
  }
  throw new Error(`could not import the improvement checklist from any source:\n  ${failures.join("\n  ")}`);
}
