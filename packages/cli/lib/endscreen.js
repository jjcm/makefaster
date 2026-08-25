/**
 * The end screen: session summary plus the three questions —
 *   1. Loop more?                        (another round from where it left off)
 *   2. Submit stats to the Site leaderboard?   (URL + favicon are public)
 *   3. Submit anonymous improvements data?     (categories + deltas only)
 */

import { writeFileSync } from "node:fs";
import {
  buildImprovementsPayload,
  buildSitePayloads,
  submitImprovements,
  submitSite,
} from "./apiClient.js";
import { confirm, question } from "./picker.js";
import { ARROW, FAIL, OK, bold, cyan, dim, formatMs, formatPct, green, hr, red, yellow } from "./ui.js";

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

function savePending(paths, entry) {
  try {
    writeFileSync(paths.pending, JSON.stringify(entry, null, 2) + "\n");
    console.log(dim(`  payload saved to ${paths.pending} — resubmit later with the same POST.`));
  } catch {
    /* the payload was already printed in the error path; nothing else to do */
  }
}

async function askSiteSubmission({ results, state, paths }) {
  let siteUrl = state.siteUrl || results?.site?.url || null;
  const payloadsPreview = buildSitePayloads(results || {}, siteUrl || "example.com");
  if (payloadsPreview.length === 0) {
    console.log(dim("  Site leaderboard: skipped — results.json has no complete cold/warm baseline+final numbers."));
    return;
  }

  console.log(`  ${bold("2. Submit stats to the Site leaderboard?")}`);
  console.log(dim("     Your site's URL and favicon will be displayed publicly, with its"));
  console.log(dim("     measured LCP/TTI and the improvement since baseline."));
  // Everything else the row will carry, so the answer is informed.
  const preview = payloadsPreview[0];
  if (preview.prUrl) {
    console.log(dim(`     The row's name will link to ${preview.prUrl}.`));
  }
  if (typeof preview.genericKeepPct === "number") {
    console.log(dim(`     It will also show that ${preview.genericKeepPct}% of what you kept was reusable technique.`));
  }
  const wants = await confirm("     Submit site stats?", { def: false });
  if (!wants) return;

  if (!siteUrl) {
    siteUrl = await question("     Site URL (e.g. example.com): ");
  }
  if (!siteUrl) {
    console.log(yellow("     No URL given — skipping the site submission."));
    return;
  }

  const payloads = buildSitePayloads(results, siteUrl);
  for (const payload of payloads) {
    try {
      const res = await submitSite(state.apiBase, payload);
      console.log(`     ${OK} ${payload.mode}: ${res.created ? "added to" : "updated on"} the board (${payload.url}, LCP ${formatPct(payload.lcpDelta)})`);
    } catch (err) {
      console.log(`     ${FAIL} ${payload.mode}: ${red(err.message)}`);
      savePending(paths, { endpoint: "/api/submit-site", apiBase: state.apiBase, payload });
    }
  }
}

async function askImprovementsSubmission({ results, state, paths }) {
  const payload = buildImprovementsPayload(results || {});
  if (!payload) {
    console.log(dim("  Improvements data: skipped — no kept improvements with measured deltas."));
    return;
  }

  console.log(`  ${bold("3. Submit anonymous improvements data?")}`);
  console.log(dim(`     No URL, no site identity — only what worked (${payload.improvements.length} ` +
    `improvement${payload.improvements.length === 1 ? "" : "s"}: name, description, deltas). This`));
  console.log(dim("     grows the public improvement leaderboard every site learns from."));
  const wants = await confirm("     Submit anonymous improvements?", { def: false });
  if (!wants) return;

  try {
    const res = await submitImprovements(state.apiBase, payload);
    for (const result of res.results || []) {
      const verb = result.action === "created" ? cyan("new category") : `matched ${dim(`(${result.similarity})`)}`;
      console.log(`     ${OK} ${result.input} ${ARROW} ${bold(result.category)} — ${verb}`);
    }
  } catch (err) {
    console.log(`     ${FAIL} ${red(err.message)}`);
    savePending(paths, { endpoint: "/api/submit-improvements", apiBase: state.apiBase, payload });
  }
}

/**
 * @returns {Promise<{loopMore: boolean}>}
 */
export async function runEndScreen({ results, state, paths }) {
  console.log(renderSummary(results, state));

  if (!process.stdin.isTTY) {
    console.log(dim("  stdin is not a TTY — skipping the end-screen questions (loop more /"));
    console.log(dim("  submit site stats / submit anonymous improvements). Run makefaster in"));
    console.log(dim("  a terminal to submit, or POST .makefaster/results.json-derived payloads"));
    console.log(dim(`  to ${state.apiBase}/api/submit-site and /api/submit-improvements.`));
    return { loopMore: false };
  }

  console.log(`  ${bold("1. Loop more?")}`);
  console.log(dim(`     Runs another round: anything left of the ${state.checklistCount ?? "?"}-category checklist first,`));
  console.log(dim(`     then up to ${state.extrasBudget ?? "?"} more hypotheses of the agent's own.`));
  const loopMore = await confirm("     Keep looping?", { def: false });
  console.log("");

  if (loopMore) {
    // Questions 2 & 3 come around again after the next round's end screen.
    return { loopMore: true };
  }

  await askSiteSubmission({ results, state, paths });
  console.log("");
  await askImprovementsSubmission({ results, state, paths });
  console.log("");
  console.log(dim(`  Leaderboards: ${state.apiBase}/site-leaderboard - ${state.apiBase}/improvement-leaderboard`));
  console.log("");
  return { loopMore: false };
}
