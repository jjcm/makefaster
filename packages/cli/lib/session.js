/**
 * Session plumbing: the .makefaster/ working directory the CLI shares with
 * the agent, the kickoff/continue prompts, and the hidden agent spawn.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcpSession } from "./agents/acp.js";
import { runClaudeSession } from "./agents/claudeCode.js";
import { runCodexSession } from "./agents/codexAppServer.js";
import { runOpenRouterSession } from "./agents/openrouter.js";
import { createProgressReporter } from "./progress.js";
import { openThinkingTrace, resetThinkingTrace, withThinkingTrace } from "./thinkingTrace.js";

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
    // The hidden agent's own reasoning, captured from the protocol stream so
    // the end screen can offer to submit it. Nothing reads it during the run
    // and nothing but an explicit yes ever sends it. See thinkingTrace.js.
    trace: join(dir, "thinking-trace.jsonl"),
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

/**
 * The size of the run: every imported checklist category, plus the extras the
 * agent may choose for itself. N is whatever the board had when the checklist
 * was imported — an empty board means the run is only the extras.
 */
export function runPlan(checklist, extras) {
  const checklistCount = Array.isArray(checklist) ? checklist.length : 0;
  const extrasBudget = Number.isInteger(extras) && extras >= 0 ? extras : 0;
  return { checklistCount, extrasBudget, plannedRuns: checklistCount + extrasBudget };
}

export function prepareSession({ cwd, provider, model, checklist, checklistSource, apiBase, extras, siteUrl }) {
  const paths = sessionPaths(cwd);
  mkdirSync(paths.dir, { recursive: true });
  copyFileSync(SKILL_SOURCE, paths.skill);
  writeFileSync(paths.improvements, JSON.stringify({ source: checklistSource, categories: checklist }, null, 2) + "\n");
  // A fresh session starts on an empty panel rather than replaying the last
  // run's steps, and on an empty trace rather than the last run's reasoning.
  writeFileSync(paths.steps, "");
  resetThinkingTrace(paths.trace);

  const plan = runPlan(checklist, extras);
  const state = {
    version: 2,
    provider: provider.key,
    model: model?.id ?? null,
    modelLabel: model?.label ?? null,
    // A name for this session, so a submitted trace can be told apart from
    // another run of the same site without carrying anything identifying.
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    apiBase,
    siteUrl: siteUrl || null,
    ...plan,
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

/**
 * The size of the run, spelled out in the words the agent is given it in. The
 * numbers are in state.json too, but a model that is told "this is a 29-run
 * session" up front does not treat run 5 as a natural place to stop.
 */
function planSentence({ checklistCount, extrasBudget, plannedRuns }) {
  const categories = `${checklistCount} imported checklist ${checklistCount === 1 ? "category" : "categories"}`;
  if (checklistCount === 0) {
    return `The checklist came back empty, so this run is just up to ${extrasBudget} hypotheses of your own.`;
  }
  if (extrasBudget === 0) {
    return `This run is ${categories} and no extras: up to ${plannedRuns} measured iterations.`;
  }
  return `This run is ${categories} plus up to ${extrasBudget} hypotheses of your own — ` +
    `up to ${plannedRuns} measured iterations in total.`;
}

/**
 * The one thing every prompt has to say, because it is the rule a model breaks
 * by default: a handful of reverted experiments is not a reason to stop.
 */
const NO_EARLY_STOP = [
  "There is no early stop and no miss limit: a run of iterations that all revert is",
  "what walking a ranked checklist honestly looks like, so keep going. Stop only when",
  "every category has been tried or skipped and your extras are done.",
].join(" ");

export function kickoffPrompt(plan) {
  return [
    "Read .makefaster/SKILL.md and follow it exactly. It defines the makefaster",
    "performance loop for the site in this repo: baseline a user-felt metric,",
    "then walk EVERY category in .makefaster/improvements.json in rank order, one",
    "per iteration — skip only what plainly does not apply here (a skip is not an",
    "iteration), implement the smallest change for what does, measure, keep it",
    "only if it beats the noise floor, otherwise revert — and only once the whole",
    `checklist is done, add up to ${plan.extrasBudget} hypotheses of your own.`,
    planSentence(plan),
    "The counts are in .makefaster/state.json.",
    NO_EARLY_STOP,
    "Keep .makefaster/results.json valid and up to date after every iteration",
    "(schema is in the skill); the CLI reads it when you exit. Report each step as",
    "one tagged line appended to .makefaster/thinking.log — that file is the only",
    "thing the user's dashboard shows, so write it as you go and keep tool output",
    "out of it.",
  ].join(" ");
}

export function continuePrompt(plan) {
  return [
    "Continue the makefaster performance loop in this repo. The user chose to loop",
    "more. Re-read .makefaster/SKILL.md for the rules and .makefaster/results.json",
    "for what was already tried (do not repeat reverted experiments without a new",
    "reason). Resume where the order left off: every remaining checklist category",
    "first, in rank order, then your own hypotheses.",
    planSentence(plan),
    "Same discipline: one hypothesis per iteration, measure, keep or revert, update",
    "results.json every iteration, keep appending one tagged line per step to",
    ".makefaster/thinking.log.",
    NO_EARLY_STOP,
  ].join(" ");
}

/**
 * Run one round of the loop in the chosen agent CLI, hidden — or, for the hosted
 * provider, in this process against the model proxy on the makefaster server.
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
 * `plannedRuns` is how many measured iterations the session is supposed to
 * contain (see runPlan). Only the hosted provider needs it, and only to size
 * its own runaway guard.
 *
 * Every provider's reasoning is captured to `.makefaster/thinking-trace.jsonl`
 * on the way past — a local file under a directory the session already keeps
 * out of git, which the end screen can offer to submit and which nothing else
 * reads. It is not shown anywhere: the dashboard's panel is the agent's own
 * `thinking.log`, and that has not changed.
 *
 * @returns {Promise<{exitCode: number, stderrTail: string, eventCount: number, lastLabel: string|null, aborted: boolean, authRequired: boolean, detail: string|null}>}
 */
export async function runAgent({ provider, prompt, cwd, model = null, env = process.env, reporter, signal, apiBase, plannedRuns = null }) {
  const progress = reporter ?? createProgressReporter();
  const trace = openThinkingTrace({ path: sessionPaths(cwd).trace });
  const tracing = withThinkingTrace(progress, trace);
  const runners = {
    cursor: runAcpSession,
    claude: runClaudeSession,
    codex: runCodexSession,
    // The hosted provider needs the server it runs on, the step log it reports
    // through, and the size of the run — it has no child process to outlive it,
    // so its own turn budget is the only thing that can cut the walk short.
    makefaster: (args) => runOpenRouterSession({ ...args, apiBase, plannedRuns, stepLogPath: sessionPaths(cwd).steps }),
  };
  const runner = runners[provider.key];
  if (!runner) throw new Error(`no protocol runner is defined for provider "${provider.key}"`);

  try {
    const result = await runner({ provider, prompt, cwd, model, env, reporter: tracing, signal });
    return {
      ...result,
      eventCount: progress.eventCount,
      lastLabel: progress.lastLabel,
      authRequired: Boolean(result.authRequired),
      detail: result.detail ?? null,
    };
  } finally {
    trace.close();
  }
}
