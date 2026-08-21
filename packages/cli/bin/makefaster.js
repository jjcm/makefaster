#!/usr/bin/env node
/**
 * npx makefaster — run the autoresearch performance loop against the site in
 * the current directory, driving an agent CLI you already have installed
 * (Cursor Agent, Claude Code, or Codex). See packages/skill/SKILL.md for the
 * loop itself and README.md for the full flow.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE, parseArgs } from "../lib/args.js";
import { resolveApiBase } from "../lib/apiClient.js";
import { detectProviders, missingCliGuidance } from "../lib/detect.js";
import { runEndScreen } from "../lib/endscreen.js";
import { importChecklist } from "../lib/improvements.js";
import { confirm, selectFrom } from "../lib/picker.js";
import {
  continuePrompt,
  kickoffPrompt,
  prepareSession,
  readResults,
  runAgent,
  writeState,
} from "../lib/session.js";
import { ARROW, FAIL, OK, banner, bold, cyan, dim, red, yellow } from "../lib/ui.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

function fail(message, code = 1) {
  console.error(`${FAIL} ${red(message)}`);
  process.exit(code);
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

  console.log(`  ${bold("Detected agent CLIs")} ${dim("(makefaster drives your existing install — no bundled model)")}`);
  for (const report of reports) {
    if (report.found) {
      console.log(`    ${OK} ${report.displayName.padEnd(14)} ${dim(report.executablePath)}${report.version ? dim(`  (${report.version})`) : ""}`);
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
      title: `  ${bold("Which agent CLI should run the loop?")}`,
      options: found.map((report) => ({
        label: report.displayName,
        detail: `${report.executablePath}${report.version ? ` — ${report.version}` : ""}`,
      })),
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

  // 1. Detect installed agent CLIs and let the user pick BEFORE anything runs.
  const reports = detectProviders();
  const provider = await pickProvider(reports, args.cli);
  console.log(`  ${OK} using ${bold(provider.displayName)} ${dim(provider.executablePath)}\n`);

  // 2. Import the top-50 improvement checklist (live board -> GitHub -> local fallback).
  const apiBase = resolveApiBase({ flag: args.api });
  let checklist;
  try {
    checklist = await importChecklist({ override: args.improvementsSource, apiBase, cwd });
  } catch (err) {
    fail(err.message);
  }
  console.log(`  ${OK} imported ${bold(checklist.categories.length)} improvement categories ${dim(`from ${checklist.source}`)}\n`);

  if (!existsSync(join(cwd, ".git"))) {
    console.log(yellow("  note: this directory is not a git repo — the loop relies on git for"));
    console.log(yellow("  clean keep/revert; the skill will fall back to file snapshots.\n"));
  }

  // 3. Prepare the session contract in .makefaster/ and hand off to the agent.
  const { paths, state } = prepareSession({
    cwd,
    provider,
    checklist: checklist.categories,
    checklistSource: checklist.source,
    apiBase,
    maxMisses: args.maxMisses,
    siteUrl: args.url,
  });

  let prompt = kickoffPrompt();
  for (;;) {
    console.log(`  ${cyan(ARROW)} handing off to ${bold(provider.displayName)} ${dim(`(round ${state.round})`)} — the loop runs in its session; exit it to come back here.\n`);
    const { exitCode } = runAgent({ provider, prompt, cwd });
    if (exitCode !== 0) {
      console.log(yellow(`\n  ${provider.displayName} exited with code ${exitCode}.`));
    }

    // 4. End screen: summary + the three questions.
    const results = readResults(cwd);
    const { loopMore } = await runEndScreen({ results, state, paths });
    if (!loopMore) break;

    state.missStreak = 0;
    state.round += 1;
    writeState(cwd, state);
    if (results && !results.parseError) {
      results.missStreak = 0;
      results.stoppedReason = null;
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(paths.results, JSON.stringify(results, null, 2) + "\n");
      } catch { /* the agent re-reads state.json either way */ }
    }
    prompt = continuePrompt();
  }
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
