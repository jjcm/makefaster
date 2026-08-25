/**
 * The agent's own progress channel: `.makefaster/thinking.log`.
 *
 * The AGENT THINKING panel used to render whatever the hidden agent's protocol
 * stream happened to emit — `[EXECUTE] working`, `[OBSERVE] Read File`,
 * `[EXECUTE] bun run build`, `[HYPOTHESIS] thinking`. That is a transcript of a
 * tool loop, not a report: it says the agent is busy without ever saying what it
 * is doing, and the interesting line scrolls past between forty uninteresting
 * ones.
 *
 * So the panel reads a channel the agent writes on purpose instead. One line per
 * step, appended as it happens:
 *
 *   [INITIALIZING] Prepping project and installing dependencies.
 *   [TEST] Running lighthouse tests for initial baseline
 *   [SKIP] Enable Gzip Compression — the CDN already compresses every response.
 *
 * The contract is in packages/skill/SKILL.md ("Reporting progress"). Only the
 * tags below are rendered, and only one line each, so a stray tool dump or a
 * pasted stack trace cannot get into the panel even by accident.
 */

import { readFileSync, statSync } from "node:fs";

const DEFAULT_INTERVAL_MS = 500;

/** The longest a summary can be before it stops being a summary. */
const MAX_TEXT = 200;

/**
 * The tags the panel renders, and the whole vocabulary the skill gives the
 * agent. Deliberately few: a tag per tool is what the old stream did.
 */
export const STEP_TAGS = Object.freeze([
  "INITIALIZING", // getting the site running, installing, building
  "TEST",         // measuring — baseline, re-measure, lighthouse run
  "CHECKLIST",    // starting on the imported improvement leaderboard
  "SKIP",         // a checklist category that does not apply here, and why
  "TRY",          // implementing one hypothesis
  "RESULT",       // what the measurement said
  "EXTRA",        // the five follow-ups chosen after the checklist
  "DONE",         // finished, with the reason
]);

const TAGGED_LINE = /^\s*\[([A-Za-z]+)\]\s*(\S.*?)\s*$/;

/**
 * Parse one line of the step log, or return null when it is not a step: blank
 * lines, prose without a tag, and tags outside the vocabulary are all ignored
 * rather than shown.
 *
 * @param {string} line
 * @returns {{tag: string, text: string}|null}
 */
export function parseStepLine(line) {
  const match = TAGGED_LINE.exec(String(line ?? ""));
  if (!match) return null;
  const tag = match[1].toUpperCase();
  if (!STEP_TAGS.includes(tag)) return null;
  const text = match[2].slice(0, MAX_TEXT);
  return text ? { tag, text } : null;
}

/**
 * Watch the step log and report each new step once.
 *
 * Polling and re-reading beats tailing by byte offset here: the file is a few
 * dozen short lines, the agent may rewrite rather than append it, and a poll
 * behaves the same on every platform. A trailing line without its newline is
 * left alone until the next tick, so a half-written summary is never shown as a
 * truncated one.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {(step: {tag: string, text: string}) => void} args.onStep
 * @param {number} [args.intervalMs]
 * @returns {{stop: () => void, poll: () => boolean}} poll() is exposed for tests
 */
export function watchStepLog({ path, onStep, intervalMs = DEFAULT_INTERVAL_MS }) {
  let signature = null;
  let consumed = 0;

  const poll = () => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false; // the agent has not reported anything yet
    }
    const next = `${stat.mtimeMs}:${stat.size}`;
    if (next === signature) return false;
    signature = next;

    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      return false;
    }

    // Split, then always drop the tail: on a file that ends with a newline it is
    // the empty string after it, and on one that does not it is a line still
    // being written — which must wait rather than be shown half-finished.
    const lines = contents.split(/\r?\n/);
    lines.pop();
    // A file that shrank was replaced rather than appended to; read it as new.
    if (lines.length < consumed) consumed = 0;

    let reported = false;
    for (const line of lines.slice(consumed)) {
      const step = parseStepLine(line);
      if (!step) continue;
      onStep(step);
      reported = true;
    }
    consumed = lines.length;
    return reported;
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
