/**
 * Import the site's top-50 improvement categories — the checklist of likely
 * wins the loop consults. Sources, in order of freshness:
 *
 *   1. an explicit --improvements <path|url> override,
 *   2. the live leaderboard:   <apiBase>/data/improvements.json
 *   3. the repo on GitHub:     https://raw.githubusercontent.com/jjcm/makefaster/main/data/improvements.json
 *   4. the target repo itself: <cwd>/data/improvements.json (when present)
 *   5. the copy packaged with this CLI (offline fallback).
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

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

function topFifty(categories) {
  return [...categories]
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, TOP_N)
    .map(({ name, description, count, avgImprovementMs, avgImprovementPct, rank }) => ({
      rank, name, description, count, avgImprovementMs, avgImprovementPct,
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
    attempts.push({ source: "packaged fallback", load: () => readJsonFile(join(PACKAGE_ROOT, "data", "improvements.json")) });
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
