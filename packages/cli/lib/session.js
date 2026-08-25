/**
 * Session plumbing: the .makefaster/ working directory the CLI shares with
 * the agent, the kickoff/continue prompts, and the hidden agent spawn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcpSession } from "./agents/acp.js";
import { runClaudeSession } from "./agents/claudeCode.js";
import { runCodexSession } from "./agents/codexAppServer.js";
import { createProgressReporter } from "./progress.js";

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
    steps: join(dir, "thinking.log"),
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
  // A fresh session starts on an empty panel rather than replaying the last
  // run's steps.
  writeFileSync(paths.steps, "");

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
    "performance loop for the site in this repo: baseline a user-felt metric,",
    "then walk .makefaster/improvements.json in rank order, one category per",
    "iteration — skip what plainly does not apply, implement the smallest change",
    "for what does, measure, keep it only if it beats the noise floor, otherwise",
    "revert — and finish with exactly 5 hypotheses of your own. Loop limits live",
    "in .makefaster/state.json — stop when missStreak reaches maxMisses. Keep",
    ".makefaster/results.json valid and up to date after every iteration (schema",
    "is in the skill); the CLI reads it when you exit. Report each step as one",
    "tagged line appended to .makefaster/thinking.log — that file is the only",
    "thing the user's dashboard shows, so write it as you go and keep tool",
    "output out of it.",
  ].join(" ");
}

export function continuePrompt() {
  return [
    "Continue the makefaster performance loop in this repo. The user chose to",
    "loop more, so the miss counter in .makefaster/state.json was reset. Re-read",
    ".makefaster/SKILL.md for the rules and .makefaster/results.json for what",
    "was already tried (do not repeat reverted experiments without a new reason).",
    "Resume where the order left off: any remaining checklist categories first,",
    "then your own hypotheses. Same discipline: one hypothesis per iteration,",
    "measure, keep or revert, update results.json every iteration, keep appending",
    "one tagged line per step to .makefaster/thinking.log, and stop when",
    "missStreak reaches maxMisses.",
  ].join(" ");
}

/**
 * Run one round of the loop in the chosen agent CLI, hidden.
 *
 * Each provider is a non-TTY protocol child (see lib/invoke.js): ACP for Cursor,
 * the Agent SDK for Claude Code, `codex app-server` for Codex. None of them
 * inherits this terminal and none is the product's interactive CLI, so nothing
 * the child does can draw over makefaster or ask the user a question — which is
 * also why each agent module answers the child's permission and approval
 * requests itself.
 *
 * `signal` lets the caller stop the round — the user pressing q in the dashboard
 * — which terminates the child rather than orphaning it.
 *
 * `authRequired` means the install is signed out. makefaster never fixes that
 * itself: no login, no browser, no injected API key.
 *
 * @returns {Promise<{exitCode: number, stderrTail: string, eventCount: number, lastLabel: string|null, aborted: boolean, authRequired: boolean, detail: string|null}>}
 */
export async function runAgent({ provider, prompt, cwd, model = null, env = process.env, reporter, signal }) {
  const progress = reporter ?? createProgressReporter();
  const runners = {
    cursor: runAcpSession,
    claude: runClaudeSession,
    codex: runCodexSession,
  };
  const runner = runners[provider.key];
  if (!runner) throw new Error(`no protocol runner is defined for provider "${provider.key}"`);

  const result = await runner({ provider, prompt, cwd, model, env, reporter: progress, signal });
  return {
    ...result,
    eventCount: progress.eventCount,
    lastLabel: progress.lastLabel,
    authRequired: Boolean(result.authRequired),
    detail: result.detail ?? null,
  };
}
