/**
 * Watch `.makefaster/results.json` for changes.
 *
 * The agent rewrites this file after every iteration, and it is the contract
 * makefaster reads (packages/skill/SKILL.md). Polling `stat` rather than
 * `fs.watch` is deliberate: watch semantics differ per platform and miss the
 * write-to-temp-then-rename pattern some tools use, while a stat poll a couple
 * of times a second is cheap and behaves the same everywhere.
 *
 * A half-written file is expected — the agent may be mid-write when we look — so
 * a parse failure is not an error, just "no new data yet".
 */

import { readFileSync, statSync } from "node:fs";

const DEFAULT_INTERVAL_MS = 500;

/**
 * @param {object} args
 * @param {string} args.path
 * @param {(results: object, meta: {changedAt: Date}) => void} args.onChange
 * @param {number} [args.intervalMs]
 * @returns {{stop: () => void, poll: () => boolean}} poll() is exposed for tests
 */
export function watchResults({ path, onChange, intervalMs = DEFAULT_INTERVAL_MS }) {
  let signature = null;

  const poll = () => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false; // not written yet
    }
    const next = `${stat.mtimeMs}:${stat.size}`;
    if (next === signature) return false;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false; // mid-write; the next tick will catch the complete file
    }
    signature = next;
    onChange(parsed, { changedAt: new Date(stat.mtimeMs) });
    return true;
  };

  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return {
    poll,
    stop() {
      clearInterval(timer);
    },
  };
}
