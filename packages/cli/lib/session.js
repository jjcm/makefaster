/**
 * Session plumbing: the .makefaster/ working directory the CLI shares with
 * the agent, the kickoff/continue prompts, and the interactive agent spawn.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function prepareSession({ cwd, provider, checklist, checklistSource, apiBase, maxMisses, siteUrl }) {
  const paths = sessionPaths(cwd);
  mkdirSync(paths.dir, { recursive: true });
  copyFileSync(SKILL_SOURCE, paths.skill);
  writeFileSync(paths.improvements, JSON.stringify({ source: checklistSource, categories: checklist }, null, 2) + "\n");

  const state = {
    version: 1,
    provider: provider.key,
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

/**
 * Hand the terminal to the chosen agent CLI. All three providers accept an
 * initial prompt as a positional argument and then run interactively, so the
 * user can watch and steer the loop.
 */
export function runAgent({ provider, prompt, cwd }) {
  const result = spawnSync(provider.executablePath, [prompt], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`failed to launch ${provider.displayName} (${provider.executablePath}): ${result.error.message}`);
  }
  return { exitCode: result.status ?? 0 };
}
