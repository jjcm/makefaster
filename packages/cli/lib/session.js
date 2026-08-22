/**
 * Session plumbing: the .makefaster/ working directory the CLI shares with
 * the agent, the kickoff/continue prompts, and the hidden agent spawn.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentInvocation, buildAuthProbe, interpretAuthProbe } from "./invoke.js";
import { classifyEvent, createProgressReporter } from "./progress.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL_SOURCE = join(PACKAGE_ROOT, "packages", "skill", "SKILL.md");

export const SESSION_DIR_NAME = ".makefaster";

export function sessionPaths(cwd) {
  const dir = join(cwd, SESSION_DIR_NAME);
  return {
    dir,
    skill: join(dir, "SKILL.md"),
    improvements: join(dir, "improvements.json"),
    state: join(dir, "state.json"),
    results: join(dir, "results.json"),
    pending: join(dir, "pending-submissions.json"),
  };
}

/**
 * Keep the session dir out of `git status` without touching the repo's own
 * .gitignore: .git/info/exclude is local-only.
 */
function excludeFromGit(cwd) {
  const excludePath = join(cwd, ".git", "info", "exclude");
  if (!existsSync(join(cwd, ".git"))) return;
  try {
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (!current.split(/\r?\n/).includes(`${SESSION_DIR_NAME}/`)) {
      mkdirSync(dirname(excludePath), { recursive: true });
      appendFileSync(excludePath, `${current.endsWith("\n") || current === "" ? "" : "\n"}${SESSION_DIR_NAME}/\n`);
    }
  } catch {
    // Cosmetic only — the skill also tells the agent never to commit .makefaster/.
  }
}

export function prepareSession({ cwd, provider, model, checklist, checklistSource, apiBase, maxMisses, siteUrl }) {
  const paths = sessionPaths(cwd);
  mkdirSync(paths.dir, { recursive: true });
  copyFileSync(SKILL_SOURCE, paths.skill);
  writeFileSync(paths.improvements, JSON.stringify({ source: checklistSource, categories: checklist }, null, 2) + "\n");

  const state = {
    version: 1,
    provider: provider.key,
    model: model?.id ?? null,
    modelLabel: model?.label ?? null,
    startedAt: new Date().toISOString(),
    apiBase,
    siteUrl: siteUrl || null,
    maxMisses,
    missStreak: 0,
    round: 1,
  };
  writeFileSync(paths.state, JSON.stringify(state, null, 2) + "\n");
  excludeFromGit(cwd);
  return { paths, state };
}

export function readState(cwd) {
  const paths = sessionPaths(cwd);
  try {
    return JSON.parse(readFileSync(paths.state, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(cwd, state) {
  writeFileSync(sessionPaths(cwd).state, JSON.stringify(state, null, 2) + "\n");
}

export function readResults(cwd) {
  const paths = sessionPaths(cwd);
  if (!existsSync(paths.results)) return null;
  try {
    return JSON.parse(readFileSync(paths.results, "utf8"));
  } catch {
    return { parseError: true };
  }
}

export function kickoffPrompt() {
  return [
    "Read .makefaster/SKILL.md and follow it exactly. It defines the makefaster",
    "performance loop for the site in this repo: profile a user-felt metric,",
    "form ONE hypothesis per iteration, measure, keep it only if it beats the",
    "noise floor, otherwise revert. The checklist of likely wins is",
    ".makefaster/improvements.json (a guide, not a script). Loop limits live in",
    ".makefaster/state.json — stop when missStreak reaches maxMisses. Keep",
    ".makefaster/results.json valid and up to date after every iteration",
    "(schema is in the skill); the CLI reads it when you exit.",
  ].join(" ");
}

export function continuePrompt() {
  return [
    "Continue the makefaster performance loop in this repo. The user chose to",
    "loop more, so the miss counter in .makefaster/state.json was reset. Re-read",
    ".makefaster/SKILL.md for the rules and .makefaster/results.json for what",
    "was already tried (do not repeat reverted experiments without a new reason).",
    "Same discipline: one hypothesis per iteration, measure, keep or revert,",
    "update results.json every iteration, stop when missStreak reaches maxMisses.",
  ].join(" ");
}

const AUTH_PROBE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_MAX_CHARS = 4_000;

/**
 * Ask the installed CLI whether it still holds credentials, without ever
 * creating any. Read-only, piped, TTY-free, and time-bounded — an install that
 * cannot answer is reported as "unknown" so the loop still runs.
 *
 * @returns {{state: "signed-in"|"signed-out"|"unknown", detail: string|null}}
 */
export function checkSignedIn({ provider, env = process.env }) {
  if (env.MAKEFASTER_SKIP_AUTH_CHECK) return { state: "unknown", detail: "skipped via MAKEFASTER_SKIP_AUTH_CHECK" };
  const probe = buildAuthProbe({ provider, env });
  if (!probe) return { state: "unknown", detail: null };
  const result = spawnSync(probe.command, probe.args, { ...probe.options, timeout: AUTH_PROBE_TIMEOUT_MS });
  return interpretAuthProbe({
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
    timedOut: result.signal === "SIGTERM" && result.status === null,
    signedOutExitCodes: probe.signedOutExitCodes,
  });
}

/**
 * Run one round of the loop in the chosen agent CLI, hidden.
 *
 * The child gets piped stdio and no stdin, so its native interface never draws
 * and it never decides a human is available to answer a login, trust, or
 * permission prompt. Its structured event stream is collapsed into a single
 * progress line; `.makefaster/results.json` is what we actually read afterward.
 *
 * `signal` lets the caller stop the round — the user pressing q in the
 * dashboard — which terminates the child rather than orphaning it.
 *
 * @returns {Promise<{exitCode: number, stderrTail: string, eventCount: number, lastLabel: string|null, aborted: boolean}>}
 */
export function runAgent({ provider, prompt, cwd, model = null, env = process.env, isRoot, reporter, signal }) {
  const rootProcess = isRoot ?? (typeof process.getuid === "function" ? process.getuid() === 0 : false);
  const invocation = buildAgentInvocation({ provider, prompt, cwd, model: model?.id ?? model ?? null, env, isRoot: rootProcess });
  const progress = reporter ?? createProgressReporter();

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, { ...invocation.options, ...(signal ? { signal } : {}) });
    } catch (err) {
      rejectPromise(launchError(provider, err));
      return;
    }

    let stderrTail = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      progress.done();
      resolvePromise(result);
    };

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, terminal: false });
      lines.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        let event = null;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return; // non-JSON chatter on stdout is not ours to render
        }
        progress.update(classifyEvent(invocation.streamFormat, event));
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS);
      });
    }

    child.on("error", (err) => {
      if (settled) return;
      // An abort kills the child on purpose; that is a stop, not a failure.
      if (err.name === "AbortError" || signal?.aborted) {
        settled = true;
        progress.done();
        resolvePromise({ exitCode: 0, stderrTail: stderrTail.trim(), eventCount: progress.eventCount, lastLabel: progress.lastLabel, aborted: true });
        return;
      }
      settled = true;
      progress.done();
      rejectPromise(launchError(provider, err));
    });

    // `close` rather than `exit`: the event stream must be fully drained before
    // we read results.json, or the last iteration's write can still be in
    // flight (bb's codex bridge finalizes on close for the same reason).
    child.on("close", (code, closeSignal) => {
      finish({
        exitCode: signal?.aborted ? 0 : code ?? (closeSignal ? 1 : 0),
        stderrTail: stderrTail.trim(),
        eventCount: progress.eventCount,
        lastLabel: progress.lastLabel,
        aborted: Boolean(signal?.aborted),
      });
    });
  });
}

function launchError(provider, err) {
  return new Error(`failed to launch ${provider.displayName} (${provider.executablePath}): ${err.message}`);
}
