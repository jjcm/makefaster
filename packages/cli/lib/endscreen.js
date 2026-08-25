/**
 * The end screen: session summary plus the questions —
 *   1. Loop more?                        (another round from where it left off)
 *   2. Submit stats to the Site leaderboard?   (URL + favicon are public)
 *   3. Submit anonymous improvements data?     (categories + deltas only)
 *   4. Submit this session's chain of thought? (private, never published)
 *
 * 2 and 3 are one decision in two parts — "upload the results of this run" —
 * and 4 is a decision of its own, asked only once that one has been answered.
 * They are not bundled: uploading results and declining the chain of thought is
 * a normal answer, and so is the reverse. 4 defaults to no and is never
 * inferred from 2 or 3.
 *
 * Prompts and output go through `io` so the sequence is testable without a TTY.
 */

import { writeFileSync } from "node:fs";
import {
  buildImprovementsPayload,
  buildSitePayloads,
  buildTracePayload,
  submitImprovements,
  submitSite,
  submitTrace,
} from "./apiClient.js";
import { confirm, question } from "./picker.js";
import { readThinkingTrace } from "./thinkingTrace.js";
import { ARROW, FAIL, OK, bold, cyan, dim, formatMs, formatPct, green, hr, red, yellow } from "./ui.js";

/** The real terminal. Tests pass their own. */
const TERMINAL_IO = {
  confirm,
  question,
  log: (line = "") => console.log(line),
};

function pctChangeLabel(baseline, final) {
  if (!(baseline > 0) || typeof final !== "number") return "";
  const pct = ((final - baseline) / baseline) * 100;
  const label = formatPct(pct);
  return pct <= 0 ? green(label) : red(label);
}

function metricLine(name, baseline, final) {
  if (typeof baseline !== "number" || typeof final !== "number") return null;
  const change = pctChangeLabel(baseline, final);
  return `    ${name.padEnd(5)} ${String(Math.round(baseline)).padStart(6)}ms ${ARROW} ${String(Math.round(final)).padStart(6)}ms  ${change}`;
}

/**
 * How much of the planned run actually happened. The counts come from the
 * iterations' own `phase` when the agent recorded it, and from the plan alone
 * when it did not — either way this is the line that shows a session that
 * stopped a third of the way down the board.
 */
function walkLine(iterations, state) {
  const planned = Number.isFinite(state?.plannedRuns) ? state.plannedRuns : null;
  if (planned === null) return `runs: ${iterations.length}`;
  const phase = (name) => iterations.filter((it) => it.phase === name).length;
  const checklist = phase("checklist");
  const extras = phase("extra");
  if (checklist + extras === 0) return `planned: up to ${planned}`;
  return `checklist ${checklist}/${state.checklistCount}  extras ${extras}/${state.extrasBudget}`;
}

export function renderSummary(results, state) {
  const lines = ["", hr(), `  ${bold("makefaster — session summary")} ${dim(`(round ${state.round})`)}`, hr()];

  if (!results || results.parseError) {
    lines.push(
      "",
      yellow("  No readable .makefaster/results.json was produced this round."),
      dim("  (The agent may have been interrupted before profiling finished.)"),
      "",
    );
    return lines.join("\n");
  }

  const site = results.site?.url ? ` — ${cyan(results.site.url)}` : "";
  lines.push(`  north star: ${bold(results.northStar || "lcp")}${site}  ${dim(results.profilingTool ? `via ${results.profilingTool}` : "")}`);

  for (const mode of ["cold", "warm"]) {
    const baseline = results.baseline?.[mode];
    const final = results.final?.[mode];
    if (!baseline || !final) continue;
    lines.push("", `  ${bold(mode)} load`);
    for (const [label, key] of [["LCP", "lcpMs"], ["TTI", "ttiMs"], ["FCP", "fcpMs"], ["TBT", "tbtMs"]]) {
      const line = metricLine(label, baseline[key], final[key]);
      if (line) lines.push(line);
    }
  }

  const iterations = results.iterations || [];
  const kept = iterations.filter((it) => it.kept === true);
  lines.push("", `  iterations: ${iterations.length}  kept: ${kept.length}  ${walkLine(iterations, state)}`);
  if (kept.length > 0) {
    lines.push("", `  ${bold("kept improvements")}`);
    for (const it of kept) {
      const delta = [
        typeof it.deltaMs === "number" ? formatMs(it.deltaMs) : null,
        typeof it.deltaPct === "number" ? formatPct(it.deltaPct) : null,
      ].filter(Boolean).join(" / ");
      lines.push(`    ${OK} ${it.name}  ${green(delta)}`);
      if (it.description) lines.push(`      ${dim(it.description)}`);
    }
  }
  const reverted = iterations.filter((it) => it.kept !== true);
  if (reverted.length > 0) {
    lines.push("", dim(`  reverted: ${reverted.map((it) => it.name).join(", ")}`.slice(0, 200)));
  }
  lines.push(hr(), "");
  return lines.join("\n");
}

function savePending(paths, entry, io) {
  try {
    writeFileSync(paths.pending, JSON.stringify(entry, null, 2) + "\n");
    io.log(dim(`  payload saved to ${paths.pending} — resubmit later with the same POST.`));
  } catch {
    /* the payload was already printed in the error path; nothing else to do */
  }
}

/** @returns {Promise<boolean>} whether anything actually reached the board */
async function askSiteSubmission({ results, state, paths, io }) {
  let siteUrl = state.siteUrl || results?.site?.url || null;
  const payloadsPreview = buildSitePayloads(results || {}, siteUrl || "example.com");
  if (payloadsPreview.length === 0) {
    io.log(dim("  Site leaderboard: skipped — results.json has no complete cold/warm baseline+final numbers."));
    return false;
  }

  io.log(`  ${bold("2. Submit stats to the Site leaderboard?")}`);
  io.log(dim("     Your site's URL and favicon will be displayed publicly, with its"));
  io.log(dim("     measured LCP/TTI and the improvement since baseline."));
  // Everything else the row will carry, so the answer is informed.
  const preview = payloadsPreview[0];
  if (preview.prUrl) {
    io.log(dim(`     The row's name will link to ${preview.prUrl}.`));
  }
  if (typeof preview.genericKeepPct === "number") {
    io.log(dim(`     It will also show that ${preview.genericKeepPct}% of what you kept was reusable technique.`));
  }
  // Tips are disclosed as a count only: they are notes to the makefaster
  // maintainers about the catalog, stored privately and never displayed —
  // here or anywhere else.
  if (Array.isArray(preview.tips) && preview.tips.length > 0) {
    io.log(dim(`     ${preview.tips.length} private catalog note${preview.tips.length === 1 ? "" : "s"} for the makefaster`));
    io.log(dim("     maintainers ride along. They are never published anywhere."));
  }
  const wants = await io.confirm("     Submit site stats?", { def: false });
  if (!wants) return false;

  if (!siteUrl) {
    siteUrl = await io.question("     Site URL (e.g. example.com): ");
  }
  if (!siteUrl) {
    io.log(yellow("     No URL given — skipping the site submission."));
    return false;
  }

  let submitted = false;
  const payloads = buildSitePayloads(results, siteUrl);
  for (const payload of payloads) {
    try {
      const res = await submitSite(state.apiBase, payload);
      submitted = true;
      io.log(`     ${OK} ${payload.mode}: ${res.created ? "added to" : "updated on"} the board (${payload.url}, LCP ${formatPct(payload.lcpDelta)})`);
    } catch (err) {
      io.log(`     ${FAIL} ${payload.mode}: ${red(err.message)}`);
      savePending(paths, { endpoint: "/api/submit-site", apiBase: state.apiBase, payload }, io);
    }
  }
  return submitted;
}

/** @returns {Promise<boolean>} whether anything actually reached the board */
async function askImprovementsSubmission({ results, state, paths, io }) {
  const payload = buildImprovementsPayload(results || {});
  if (!payload) {
    io.log(dim("  Improvements data: skipped — no kept improvements with measured deltas."));
    return false;
  }

  io.log(`  ${bold("3. Submit anonymous improvements data?")}`);
  io.log(dim(`     No URL, no site identity — only what worked (${payload.improvements.length} ` +
    `improvement${payload.improvements.length === 1 ? "" : "s"}: name, description, deltas). This`));
  io.log(dim("     grows the public improvement leaderboard every site learns from."));
  const wants = await io.confirm("     Submit anonymous improvements?", { def: false });
  if (!wants) return false;

  try {
    const res = await submitImprovements(state.apiBase, payload);
    for (const result of res.results || []) {
      const verb = result.action === "created" ? cyan("new category") : `matched ${dim(`(${result.similarity})`)}`;
      io.log(`     ${OK} ${result.input} ${ARROW} ${bold(result.category)} — ${verb}`);
    }
    return true;
  } catch (err) {
    io.log(`     ${FAIL} ${red(err.message)}`);
    savePending(paths, { endpoint: "/api/submit-improvements", apiBase: state.apiBase, payload }, io);
    return false;
  }
}

/**
 * The second decision, asked only after the first has been answered: the
 * session's chain of thought. The trace spans every round the session ran,
 * because a session that looped three times reasoned across all three.
 *
 * This one is not a leaderboard submission and is disclosed as what it is —
 * the hidden agent's own reasoning, kept on the makefaster server to post-train
 * a smaller model on how the loop reasons. It is never published: not on either
 * board, not in `GET /data/*.json`, and not in the checklist another run
 * imports. Which is exactly why it defaults to no and takes an explicit yes:
 * a default of yes would be an upload the user never made.
 *
 * @returns {Promise<boolean>} whether a trace was sent
 */
async function askTraceSubmission({ results, state, paths, io, resultsSubmitted }) {
  const blocks = paths.trace ? readThinkingTrace(paths.trace) : [];
  const payload = buildTracePayload({
    blocks,
    results,
    state,
    resultsSubmitted,
    siteUrl: state.siteUrl || results?.site?.url || null,
  });
  if (!payload || payload.thinking.length === 0) {
    io.log(dim("  Chain of thought: skipped — this session captured no reasoning text"));
    io.log(dim(`  (${state.provider || "the agent"} does not expose one, or the run stopped before it thought).`));
    return false;
  }

  const chars = payload.thinking.reduce((sum, block) => sum + block.text.length, 0);
  const iterations = payload.results?.iterations?.length ?? 0;
  io.log(`  ${bold("4. Submit this session's chain of thought?")} ${dim("(separate question, off by default)")}`);
  io.log(dim(`     ${payload.thinking.length} thinking block${payload.thinking.length === 1 ? "" : "s"} ` +
    `(${Math.round(chars / 100) / 10}k characters) of ${state.modelLabel || state.model || "the agent"}'s own`));
  io.log(dim(`     reasoning, in order${iterations > 0 ? `, plus the ${iterations}-iteration keep/revert list` : ""}. Text only:`));
  io.log(dim("     no tool calls, no command output, no file contents, no diff."));
  io.log(dim("     Kept privately on the makefaster server to post-train a small model on how"));
  io.log(dim("     the loop reasons. Never shown on the boards, never served by any endpoint,"));
  io.log(dim("     and never fed to another run's checklist."));
  io.log(dim(`     ${paths.trace} is the exact file — read it first if you like.`));
  const wants = await io.confirm("     Submit the chain of thought?", { def: false });
  if (!wants) {
    io.log(dim("     Not submitted. The trace stays in .makefaster/, which git ignores."));
    return false;
  }

  try {
    const res = await submitTrace(state.apiBase, payload);
    io.log(`     ${OK} trace stored (${res.thinkingBlocks ?? payload.thinking.length} blocks). Thank you — it is not published anywhere.`);
    return true;
  } catch (err) {
    io.log(`     ${FAIL} ${red(err.message)}`);
    savePending(paths, { endpoint: "/api/submit-trace", apiBase: state.apiBase, payload }, io);
    return false;
  }
}

/**
 * @param {object} args
 * @param {object|null} args.results
 * @param {object} args.state
 * @param {object} args.paths
 * @param {{confirm: Function, question: Function, log: Function}} [args.io] test seam
 * @param {boolean} [args.interactive] test seam for the non-TTY path
 * @returns {Promise<{loopMore: boolean, resultsSubmitted: boolean, traceSubmitted: boolean}>}
 */
export async function runEndScreen({ results, state, paths, io = TERMINAL_IO, interactive = process.stdin.isTTY }) {
  io.log(renderSummary(results, state));

  if (!interactive) {
    io.log(dim("  stdin is not a TTY — skipping the end-screen questions (loop more / submit"));
    io.log(dim("  site stats / submit anonymous improvements / submit the chain of thought)."));
    io.log(dim("  Run makefaster in a terminal to submit, or POST .makefaster/results.json-derived"));
    io.log(dim(`  payloads to ${state.apiBase}/api/submit-site and /api/submit-improvements.`));
    // Deliberately not offered here: a trace is only ever sent on an explicit
    // yes, and a non-interactive run cannot give one.
    return { loopMore: false, resultsSubmitted: false, traceSubmitted: false };
  }

  io.log(`  ${bold("1. Loop more?")}`);
  io.log(dim(`     Runs another round: anything left of the ${state.checklistCount ?? "?"}-category checklist first,`));
  io.log(dim(`     then up to ${state.extrasBudget ?? "?"} more hypotheses of the agent's own.`));
  const loopMore = await io.confirm("     Keep looping?", { def: false });
  io.log("");

  if (loopMore) {
    // Every question below comes around again after the next round's end screen.
    return { loopMore: true, resultsSubmitted: false, traceSubmitted: false };
  }

  // Decision one: upload the results of this run.
  const site = await askSiteSubmission({ results, state, paths, io });
  io.log("");
  const improvements = await askImprovementsSubmission({ results, state, paths, io });
  io.log("");

  // Decision two, asked only now that decision one has an answer — and taken on
  // its own terms: declining the results above does not decline this, and
  // accepting them does not accept it.
  const resultsSubmitted = site || improvements;
  const traceSubmitted = await askTraceSubmission({ results, state, paths, io, resultsSubmitted });
  io.log("");

  io.log(dim(`  Leaderboards: ${state.apiBase}/site-leaderboard - ${state.apiBase}/improvement-leaderboard`));
  io.log("");
  return { loopMore: false, resultsSubmitted, traceSubmitted };
}
