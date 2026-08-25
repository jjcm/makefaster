#!/usr/bin/env node
/**
 * npx makefaster — run the autoresearch performance loop against the site in
 * the current directory, driving an agent CLI you already have installed
 * (Cursor Agent, Claude Code, or Codex). The agent CLI is driven as a hidden
 * worker: see packages/cli/lib/invoke.js for why nothing inherits this
 * terminal, packages/skill/SKILL.md for the loop itself, and README.md for the
 * full flow.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE, parseArgs } from "../lib/args.js";
import { resolveApiBase } from "../lib/apiClient.js";
import { detectProviders, missingCliGuidance } from "../lib/detect.js";
import { runEndScreen } from "../lib/endscreen.js";
import { listModels } from "../lib/agents/modelList.js";
import { importChecklist } from "../lib/improvements.js";
import { signedOutGuidance } from "../lib/invoke.js";
import { createLoopView } from "../lib/loopView.js";
import { modelsForProvider, resolveModel } from "../lib/models.js";
import { confirm, selectFrom } from "../lib/picker.js";
import { createTui, tuiSupported } from "../lib/tui.js";
import {
  continuePrompt,
  kickoffPrompt,
  prepareSession,
  readResults,
  runAgent,
  runPlan,
  writeState,
} from "../lib/session.js";
import { ARROW, FAIL, OK, banner, bold, cyan, dim, red, yellow } from "../lib/ui.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

function fail(message, code = 1) {
  console.error(`${FAIL} ${red(message)}`);
  process.exit(code);
}

function indent(text) {
  return text.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

/**
 * How long the run is, in the two numbers that decide it: the checklist the
 * board handed over, and the extras the agent may add to it.
 */
function planLabel({ checklistCount, extrasBudget, plannedRuns }) {
  if (checklistCount === 0) {
    return `plan: the checklist is empty, so this run is up to ${extrasBudget} hypotheses of the agent's own`;
  }
  const categories = `${checklistCount} checklist ${checklistCount === 1 ? "category" : "categories"}`;
  if (extrasBudget === 0) {
    return `plan: ${categories}, no extras — up to ${plannedRuns} measured runs`;
  }
  return `plan: ${categories} + up to ${extrasBudget} of the agent's own — up to ${plannedRuns} measured runs`;
}

async function pickProvider(reports, cliFlag) {
  const found = reports.filter((r) => r.found);

  if (cliFlag) {
    const wanted = reports.find((r) => r.key === cliFlag);
    if (!wanted.found) {
      fail(`--cli ${cliFlag}: ${wanted.displayName} was not found on this machine.\n` +
        (wanted.error ? `  ${wanted.error}\n` : "") +
        `  install it with: ${wanted.install}`);
    }
    return wanted;
  }

  if (found.length === 0) {
    console.error(missingCliGuidance(reports));
    process.exit(1);
  }

  console.log(`  ${bold("Available agents")} ${dim("(makefaster drives your existing install, or its own hosted model)")}`);
  for (const report of reports) {
    if (report.found) {
      const where = report.hosted ? report.detail : report.executablePath;
      console.log(`    ${OK} ${report.displayName.padEnd(14)} ${dim(where)}${report.version ? dim(`  (${report.version})`) : ""}`);
    } else {
      const note = report.error || report.hint || `not found — install: ${report.install}`;
      console.log(`    ${dim("-")} ${dim(report.displayName.padEnd(14))} ${dim(note)}`);
    }
  }
  console.log("");

  if (found.length === 1) {
    if (process.stdin.isTTY) {
      const useIt = await confirm(`  Use ${bold(found[0].displayName)}?`, { def: true });
      if (!useIt) process.exit(0);
    } else {
      console.log(dim(`  (non-interactive: using the only CLI found, ${found[0].displayName})`));
    }
    return found[0];
  }

  try {
    const index = await selectFrom({
      title: `  ${bold("Which agent should run the loop?")}`,
      options: found.map((report) => ({
        label: report.displayName,
        detail: report.hosted
          ? report.detail
          : `${report.executablePath}${report.version ? ` — ${report.version}` : ""}`,
      })),
      // The hosted model is first and pre-selected: it is the only option that
      // needs nothing installed and nothing signed into.
      defaultIndex: 0,
    });
    if (index === null) process.exit(0);
    return found[index];
  } catch (err) {
    if (err.code === "NO_TTY") {
      fail(`multiple agent CLIs found (${found.map((r) => r.key).join(", ")}) but stdin is not a TTY — pass --cli <${found.map((r) => r.key).join("|")}>`, 2);
    }
    throw err;
  }
}

/**
 * Pick the model, ranked by intelligence. The ranking comes from the CursorBench
 * 3.2 snapshot in jjcm/bb-plugin-autorouter (see lib/models.js); the ids are
 * whatever the chosen CLI itself accepts, reconciled against its live model list
 * when makefaster can ask for one.
 *
 * The list probe is also where a signed-out install surfaces first, because
 * asking a CLI what models an account can run requires that account.
 */
async function pickModel(provider, modelFlag, cwd) {
  // The hosted provider's model is pinned by the server, so there is nothing to
  // pick and nothing --model could change.
  if (provider.hosted) {
    if (modelFlag) {
      console.log(dim(`  note: ${provider.displayName} runs a fixed model (${provider.hostedModel}) — ignoring --model ${modelFlag}.`));
    }
    return { id: provider.hostedModel, label: provider.displayName, pinned: true };
  }

  const live = await listModels({ provider, cwd });
  if (live.authRequired) fail(signedOutGuidance(provider, live.detail), 3);
  const options = { live: live.models };

  if (modelFlag) {
    const model = resolveModel(provider.key, modelFlag, options);
    if (model?.passthrough) {
      console.log(dim(`  note: ${model.id} is not one of makefaster's ranked picks for ${provider.displayName} — passing it to the CLI as given.`));
    }
    return model;
  }

  const models = modelsForProvider(provider.key, options);
  if (models.length === 0) return null;
  if (models.length === 1) return models[0];
  if (!process.stdin.isTTY) {
    fail(`${provider.displayName} offers ${models.length} models but stdin is not a TTY — pass --model <${models[0].id}>`, 2);
  }

  const ranked = models.filter((model) => model.score !== null).length;
  const source = live.models ? `from ${provider.displayName}'s own model list` : "from makefaster's catalog";
  console.log(`  ${bold(`Which model should ${provider.displayName} run?`)} ${dim(`(${ranked} of ${models.length} ranked by CursorBench 3.2, ${source})`)}`);
  console.log(dim("  the score ranks the model family; the id is what this CLI accepts"));
  if (ranked < models.length) {
    console.log(dim(`  ${provider.displayName} has ${ranked} model${ranked === 1 ? "" : "s"} in the snapshot; the rest are its own next-best models, unranked.`));
  }

  try {
    const index = await selectFrom({
      title: dim("  most intelligent first"),
      options: models.map((model) => ({ label: `${model.label}  ${dim(model.id)}`, detail: model.detail })),
      defaultIndex: 0,
    });
    if (index === null) process.exit(0);
    return models[index];
  } catch (err) {
    if (err.code === "NO_TTY") {
      fail(`${provider.displayName} offers ${models.length} models but stdin is not a TTY — pass --model <${models[0].id}>`, 2);
    }
    throw err;
  }
}

/**
 * Ask the makefaster server whether its hosted model is configured. A server
 * that says no is a hard stop with the alternatives spelled out; a server that
 * cannot be reached is only a warning, because the run may still work and the
 * proxy will say so plainly if it does not.
 */
async function checkHostedModel(apiBase) {
  let health;
  try {
    const res = await fetch(`${apiBase}/api/health`, { headers: { accept: "application/json" } });
    health = await res.json();
  } catch {
    console.log(yellow(`  note: could not reach ${apiBase} to check the hosted model — trying anyway.\n`));
    return;
  }
  if (health?.inference && health.inference.available === false) {
    fail(
      `${apiBase} has no hosted model configured (OPENROUTER_API_KEY is unset on that server).\n` +
      "  Run against your own agent CLI instead — --cli cursor|claude|codex — or point --api at a\n" +
      "  deployment that has one.",
      3,
    );
  }
}

/**
 * Run one round under makefaster's own full-screen dashboard. The agent CLI
 * stays hidden behind piped stdio either way; this only decides who draws.
 *
 * The terminal is handed back before returning, so the end screen's questions
 * happen on the normal screen — including when the user quits or the round
 * throws.
 */
async function runRoundInDashboard({ provider, prompt, cwd, model, paths, state, apiBase }) {
  const controller = new AbortController();
  const tui = createTui({ onQuit: () => controller.abort() });
  const view = createLoopView({ tui, paths, state, provider, model });

  tui.start();
  view.append("INITIALIZING", `Round ${state.round}: driving ${provider.displayName} headlessly${model ? ` on ${model.id}` : ""}.`);
  view.render();
  try {
    const result = await runAgent({
      provider, prompt, cwd, model, apiBase,
      plannedRuns: state.plannedRuns,
      reporter: view.reporter,
      signal: controller.signal,
    });
    view.setStatus(result.aborted ? "STOPPED" : "DONE");
    view.flush();
    return result;
  } finally {
    view.stop();
    tui.stop();
  }
}

async function main() {
  const { args, errors } = parseArgs(process.argv.slice(2));
  if (errors.length > 0) {
    console.error(errors.map((e) => `${FAIL} ${e}`).join("\n") + "\n\n" + USAGE);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); return; }
  if (args.version) { console.log(VERSION); return; }

  const cwd = resolve(args.targetDir || process.cwd());
  if (!existsSync(cwd)) fail(`target directory does not exist: ${cwd}`);

  console.log(banner(VERSION));
  const apiBase = resolveApiBase({ flag: args.api });

  // 1. Offer the agents: the hosted model first, then whichever CLIs are
  //    installed. The user picks BEFORE anything runs.
  const reports = detectProviders();
  const provider = await pickProvider(reports, args.cli);
  console.log(`  ${OK} using ${bold(provider.displayName)} ${dim(provider.hosted ? provider.detail : provider.executablePath)}\n`);

  // 2. Pick the model. For an installed CLI, makefaster reuses the credentials
  //    it already stored and never starts a login, opens a browser, or injects
  //    an API key — so a signed-out install is reported here and the run stops.
  //    The hosted provider's model is pinned by the server instead, and its
  //    equivalent of "signed out" is a server with no credential, which is
  //    worth learning now rather than three minutes into a run.
  const model = await pickModel(provider, args.model, cwd);
  if (model) console.log(`  ${OK} model ${bold(model.label)} ${dim(model.id)}\n`);
  if (provider.hosted) await checkHostedModel(apiBase);

  // 3. Import the improvement checklist (live board -> GitHub -> target repo ->
  //    the catalog bundled with this CLI, which is what answers while the
  //    public board is still filling up).
  let checklist;
  try {
    checklist = await importChecklist({ override: args.improvementsSource, apiBase, cwd });
  } catch (err) {
    fail(err.message);
  }
  console.log(`  ${OK} imported ${bold(checklist.categories.length)} improvement categories ${dim(`from ${checklist.source}`)}`);

  // The run's size, said out loud before it starts: the board decides how long
  // the walk is, and the only budget makefaster imposes is the extras.
  const plan = runPlan(checklist.categories, args.extras);
  console.log(`  ${cyan(ARROW)} ${bold(planLabel(plan))} ${dim("— the loop runs the whole checklist; it does not stop on a miss streak")}\n`);

  if (!existsSync(join(cwd, ".git"))) {
    console.log(yellow("  note: this directory is not a git repo — the loop relies on git for"));
    console.log(yellow("  clean keep/revert; the skill will fall back to file snapshots.\n"));
  }

  // 4. Prepare the session contract in .makefaster/ and hand the work to the
  //    agent CLI — as a hidden worker, so its own interface never draws here.
  const { paths, state } = prepareSession({
    cwd,
    provider,
    model,
    checklist: checklist.categories,
    checklistSource: checklist.source,
    apiBase,
    extras: args.extras,
    siteUrl: args.url,
  });

  const useTui = args.tui && tuiSupported();
  let prompt = kickoffPrompt(plan);
  for (;;) {
    console.log(`  ${cyan(ARROW)} running the loop in ${bold(provider.displayName)} ${dim(`(round ${state.round})`)} — hidden, no prompts; this can take a while.`);
    if (useTui) console.log(dim("  makefaster takes the screen while it runs; press q to stop the round.\n"));
    else console.log("");

    const { exitCode, stderrTail, aborted, authRequired, detail } = useTui
      ? await runRoundInDashboard({ provider, prompt, cwd, model, paths, state, apiBase })
      : await runAgent({ provider, prompt, cwd, model, apiBase, plannedRuns: state.plannedRuns });

    // A signed-out install can only be certain once the child has spoken.
    if (authRequired) fail(signedOutGuidance(provider, detail || stderrTail), 3);

    if (aborted) console.log(yellow(`  stopped ${provider.displayName} at your request.`));
    else if (exitCode !== 0) {
      console.log(yellow(`\n  ${provider.displayName} exited with code ${exitCode}.`));
      if (stderrTail) console.log(dim(indent(stderrTail.split(/\r?\n/).slice(-8).join("\n"))));
    }

    // 5. End screen: summary + the three questions, back on the normal screen.
    const results = readResults(cwd);
    const { loopMore } = await runEndScreen({ results, state, paths });
    if (!loopMore) break;

    state.round += 1;
    writeState(cwd, state);
    if (results && !results.parseError) {
      results.stoppedReason = null;
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(paths.results, JSON.stringify(results, null, 2) + "\n");
      } catch { /* the agent re-reads state.json either way */ }
    }
    prompt = continuePrompt(plan);
  }
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
