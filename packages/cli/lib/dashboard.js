/**
 * The makefaster dashboard: three stacked panels, composed as rows of styled
 * segments. Pure — it takes a size plus the session data and returns rows, so
 * it renders identically into a terminal or into a test assertion.
 *
 *   ┌ AGENT THINKING ────────────────────────────┐  tagged, timestamped log
 *   ┌ AUTORESEARCH / WEBSITE SPEED ──────────────┐  live metrics + candidate
 *   ┌ RUN TIMINGS ───────────────────────────────┐  a bar per iteration
 *
 * Everything is derived from `.makefaster/results.json` (the contract in
 * packages/skill/SKILL.md) plus the log the hidden agent's event stream feeds.
 * The schema carries per-iteration deltas rather than per-iteration absolutes,
 * so run values are reconstructed by walking the deltas from the baseline —
 * which is exactly what `deltaMs` means: the change against the previous kept
 * state.
 */

import { BLOCKS, BLOCK_FULL, BOX, COLORS, STAR, fit, formatDuration, seg } from "./theme.js";

const LOG_MIN_HEIGHT = 5;
const METRICS_MIN_HEIGHT = 9;
const CHART_MIN_HEIGHT = 8;
const METRICS_IDEAL_HEIGHT = 15;
const CHART_IDEAL_HEIGHT = 13;

/**
 * Metric rows, in display order. A row is skipped entirely when the data has no
 * value for it, so a session that only measured LCP and TTI shows two rows
 * rather than four empty ones.
 */
const METRICS = [
  { key: "lcpMs", long: "PAGE LOAD TIME (LCP)", short: "LCP", kind: "duration", lowerIsBetter: true },
  { key: "tbtMs", long: "TOTAL BLOCKING TIME (TBT)", short: "TBT", kind: "duration", lowerIsBetter: true },
  { key: "fcpMs", long: "FIRST CONTENTFUL PAINT (FCP)", short: "FCP", kind: "duration", lowerIsBetter: true },
  { key: "ttiMs", long: "TIME TO INTERACTIVE (TTI)", short: "TTI", kind: "duration", lowerIsBetter: true },
  { key: "cls", long: "CUMULATIVE LAYOUT SHIFT (CLS)", short: "CLS", kind: "ratio", lowerIsBetter: true },
  { key: "score", long: "PERFORMANCE SCORE", short: "PERF SCORE", kind: "points", lowerIsBetter: false },
];

/** Prefer the mode the session actually measured; cold is the honest default. */
export function pickMode(results) {
  if (results?.baseline?.cold) return "cold";
  if (results?.baseline?.warm) return "warm";
  return "cold";
}

function northStarKey(results) {
  const star = String(results?.northStar || "lcp").toLowerCase();
  const known = METRICS.find((metric) => metric.key.toLowerCase().startsWith(star));
  return known ? known.key : "lcpMs";
}

function formatMetric(metric, value) {
  if (!Number.isFinite(value)) return "—";
  if (metric.kind === "duration") return formatDuration(value);
  if (metric.kind === "ratio") return value.toFixed(2);
  return String(Math.round(value));
}

/**
 * Candidate vs baseline per metric, with the signed change. `better` is the
 * direction that matters for that metric, not the sign of the number.
 */
export function deriveMetrics(results) {
  const mode = pickMode(results);
  const baseline = results?.baseline?.[mode] ?? null;
  const candidate = results?.final?.[mode] ?? baseline;
  return METRICS.flatMap((metric) => {
    const base = baseline?.[metric.key];
    const now = candidate?.[metric.key];
    if (!Number.isFinite(base) && !Number.isFinite(now)) return [];
    const change = Number.isFinite(base) && Number.isFinite(now) && base !== 0 ? ((now - base) / base) * 100 : null;
    const raw = Number.isFinite(base) && Number.isFinite(now) ? now - base : null;
    const better = change === null || change === 0 ? null : metric.lowerIsBetter ? change < 0 : change > 0;
    return [{
      key: metric.key,
      long: metric.long,
      short: metric.short,
      candidate: formatMetric(metric, now),
      baseline: formatMetric(metric, base),
      change,
      raw,
      better,
      changeLabel: changeLabel(metric, change, raw),
    }];
  });
}

function changeLabel(metric, change, raw) {
  if (metric.kind === "points") return raw === null ? "—" : `${raw > 0 ? "+" : ""}${Math.round(raw)}`;
  if (change === null) return "—";
  const rounded = Math.round(change * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/**
 * One bar per run: the baseline, then every measured iteration. Iteration
 * values are the baseline walked forward through the deltas — kept iterations
 * move the running value, reverted ones do not.
 */
export function deriveRuns(results) {
  const mode = pickMode(results);
  const key = northStarKey(results);
  const baselineValue = results?.baseline?.[mode]?.[key];
  if (!Number.isFinite(baselineValue)) return { baseline: null, runs: [], best: null, key };

  const runs = [{ index: 0, label: "000", value: baselineValue, kept: true, name: "baseline", isBaseline: true }];
  let running = baselineValue;
  for (const [i, iteration] of (results?.iterations ?? []).entries()) {
    if (!Number.isFinite(iteration?.deltaMs)) continue; // unmeasured: nothing honest to plot
    const value = running + iteration.deltaMs;
    const index = Number.isFinite(iteration.n) ? iteration.n : i + 1;
    runs.push({
      index,
      label: String(index).padStart(3, "0"),
      value,
      kept: iteration.kept === true,
      name: iteration.name || `iteration ${index}`,
      isBaseline: false,
    });
    if (iteration.kept === true) running = value;
  }

  const best = runs.reduce((low, run) => (low === null || run.value < low.value ? run : low), null);
  return { baseline: baselineValue, runs, best, key };
}

/** IMPROVED / REGRESSED / UNCHANGED for the most recent measured iteration. */
export function deriveVerdict(results) {
  const iterations = (results?.iterations ?? []).filter((it) => Number.isFinite(it?.deltaMs));
  const latest = iterations.at(-1);
  if (!latest) return { label: "PENDING", better: null, iteration: null };
  const noiseFloor = results?.noiseFloor?.lcpMs ?? 0;
  if (Math.abs(latest.deltaMs) <= noiseFloor) return { label: "UNCHANGED", better: null, iteration: latest };
  if (latest.deltaMs < 0) return { label: "IMPROVED", better: true, iteration: latest };
  return { label: "REGRESSED", better: false, iteration: latest };
}

function experimentId(index) {
  return `exp_${String(index).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function panel({ width, height, title, titleRight = null, body }) {
  const rows = [];
  const inner = Math.max(0, width - 2);
  const titleText = ` ${title} `;
  const rightText = titleRight ? ` ${fit(titleRight, Math.max(0, inner - titleText.length - 4))} ` : "";
  const fillWidth = Math.max(0, inner - titleText.length - rightText.length);

  rows.push([
    seg(BOX.tl, "border"),
    seg(titleText, "title"),
    seg(BOX.h.repeat(fillWidth), "border"),
    seg(rightText, "muted"),
    seg(BOX.tr, "border"),
  ]);

  // The border is the panel's promise: body lines are clamped to the interior
  // so no content can ever push the right edge off screen.
  const interior = Math.max(0, inner - 2);
  const bodyRows = body.slice(0, Math.max(0, height - 2));
  for (let i = 0; i < height - 2; i++) {
    const line = clampSegments(bodyRows[i] ?? [], interior);
    rows.push([seg(BOX.v, "border"), seg(" "), ...line, seg(" ".repeat(interior - lengthOf(line))), seg(" "), seg(BOX.v, "border")]);
  }
  rows.push([seg(BOX.bl, "border"), seg(BOX.h.repeat(inner), "border"), seg(BOX.br, "border")]);
  return rows;
}

function lengthOf(segments) {
  return segments.reduce((total, s) => total + s.text.length, 0);
}

function clampSegments(segments, width) {
  const out = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    const text = segment.text.length > width - used ? segment.text.slice(0, width - used) : segment.text;
    if (text.length === 0) continue;
    out.push({ ...segment, text });
    used += text.length;
  }
  return out;
}

function pad(text, width, align = "left") {
  const flat = fit(text, width);
  const gap = Math.max(0, width - flat.length);
  return align === "right" ? " ".repeat(gap) + flat : flat + " ".repeat(gap);
}

/** TOP — the tagged, timestamped log of what the hidden agent is doing. */
function thinkingPanel({ width, height, log, model, provider }) {
  const inner = width - 4;
  const visible = log.slice(-Math.max(0, height - 2));
  const body = visible.map((entry) => {
    const tag = `[${entry.tag}]`;
    return [
      seg(`${entry.time}  `, "time"),
      seg(pad(tag, 13), "tag"),
      seg(fit(entry.text, Math.max(0, inner - 10 - 13)), "text"),
    ];
  });
  const right = [
    model ? `model: ${model.id}` : null,
    provider ? `cli: ${provider.displayName} (hidden)` : null,
  ].filter(Boolean).join("  |  ");
  return panel({ width, height, title: ">_ AGENT THINKING", titleRight: right, body });
}

/** MIDDLE — status, live metrics, and the candidate-versus-baseline table. */
function autoresearchPanel({ width, height, results, state, status, updatedAt }) {
  const inner = width - 4;
  const runs = deriveRuns(results);
  const verdict = deriveVerdict(results);
  const metrics = deriveMetrics(results);
  const loop = Math.max(0, runs.runs.length - 1);
  const currentExperiment = verdict.iteration?.name || (results ? "measuring baseline" : "starting up");

  // Below roughly 100 columns the side-by-side table cannot hold its own
  // columns, and the left metrics already carry candidate, baseline and Δ — so
  // narrow terminals get one honest column instead of two cramped ones.
  const showTable = inner >= 94;
  const tableWidth = showTable ? Math.min(46, Math.max(38, Math.floor(inner * 0.44))) : 0;
  const leftWidth = showTable ? inner - tableWidth - 5 : inner - 2;

  const body = [];
  body.push([
    seg(`LOOP ${String(loop).padStart(3, "0")}`, "heading"),
    seg("   CURRENT EXPERIMENT: ", "label"),
    seg(fit(currentExperiment, Math.max(0, inner - 30)), "accent"),
  ]);
  body.push([
    seg("STATUS: ", "label"), seg(pad(status, 9), "value"),
    seg("| RESULT: ", "label"), seg(pad(verdict.label, 11), verdict.better === null ? "muted" : verdict.better ? "good" : "bad"),
    seg("| UPDATED: ", "label"), seg(updatedAt || "—", "value"),
  ]);
  body.push([]);

  const left = metricRows(metrics, leftWidth);
  if (!showTable) {
    body.push(...(left.length > 0 ? left : [[seg("waiting for the first measurement", "muted")]]));
  } else {
    const right = comparisonRows({ metrics, width: tableWidth, candidateIndex: verdict.iteration ? loop : 0 });
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const row = left[i] ?? [];
      body.push([
        ...row,
        seg(" ".repeat(Math.max(0, leftWidth - lengthOf(row)))),
        seg(` ${BOX.v} `, "border"),
        ...(right[i] ?? []),
      ]);
    }
  }

  const footer = [results?.profilingTool ? `profiler: ${results.profilingTool}` : null, results?.site?.url || null]
    .filter(Boolean).join("   |   ");

  return panel({
    width,
    height,
    title: "AUTORESEARCH / WEBSITE SPEED",
    titleRight: state?.round ? `round ${state.round}` : null,
    // The measurement conditions are part of reading the numbers honestly, so
    // the footer keeps its row and the metric list is what gives way.
    body: footer ? withReservedFooter(body, [seg(fit(footer, inner), "muted")], height - 2) : body,
  });
}

function withReservedFooter(body, footer, capacity) {
  if (capacity <= 1) return [footer];
  const rows = body.slice(0, capacity - 1);
  while (rows.length < capacity - 1) rows.push([]); // the footer sits on the last row
  return [...rows, footer];
}

function metricRows(metrics, width) {
  const nameWidth = Math.max(10, width - 26);
  // Truncating "TOTAL BLOCKING TIME (TBT)" to "TOTAL BLOCKING TIME (T…" reads
  // worse than just saying "TBT", so a tight column uses the short name.
  const longest = Math.max(...metrics.map((metric) => metric.long.length), 0);
  const useLong = longest <= nameWidth;
  return metrics.map((metric) => [
    seg(pad(useLong ? metric.long : metric.short, nameWidth), "label"),
    seg(pad(metric.candidate, 9, "right"), "value"),
    seg(pad(metric.baseline, 9, "right"), "muted"),
    seg(pad(metric.changeLabel, 8, "right"), metric.better === null ? "muted" : metric.better ? "good" : "bad"),
  ]);
}

function comparisonRows({ metrics, width, candidateIndex }) {
  const metricWidth = Math.max(6, width - 30);
  const rows = [];
  rows.push([
    seg(pad("", metricWidth)),
    seg(pad("CANDIDATE", 10, "right"), "heading"),
    seg(pad("BASELINE", 10, "right"), "accent"),
    seg(pad("Δ", 8, "right"), "heading"),
  ]);
  rows.push([
    seg(pad("METRIC", metricWidth), "label"),
    seg(pad(experimentId(candidateIndex), 10, "right"), "muted"),
    seg(pad(experimentId(0), 10, "right"), "muted"),
    seg(pad("CHANGE", 8, "right"), "label"),
  ]);
  rows.push([seg(BOX.h.repeat(Math.min(width, metricWidth + 36)), "border")]);
  for (const metric of metrics) {
    rows.push([
      seg(pad(metric.short, metricWidth), "label"),
      seg(pad(metric.candidate, 10, "right"), "value"),
      seg(pad(metric.baseline, 10, "right"), "muted"),
      seg(pad(metric.changeLabel, 8, "right"), metric.better === null ? "muted" : metric.better ? "good" : "bad"),
    ]);
  }
  return rows;
}

/** Round an axis maximum up to a 1/1.5/2/2.5/3/4/5/7.5 x 10^n step. */
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

const AXIS_WIDTH = 6;
const LEGEND_WIDTH = 30;

/**
 * Gridline labels for the y axis: round multiples of a nice step, placed on the
 * row whose top boundary they fall on, plus the axis maximum and zero. Labelling
 * round values rather than every row's exact boundary is what makes the axis
 * readable at a glance.
 */
function axisGridLabels({ max, cellValue, plotHeight }) {
  const labels = new Map([[plotHeight - 1, String(Math.round(max))], [0, "0"]]);
  const step = niceMax(max / 3);
  for (let value = step; value < max * 0.92; value += step) {
    const row = Math.round(value / cellValue) - 1;
    if (row > 0 && row < plotHeight - 1 && !labels.has(row)) labels.set(row, String(Math.round(value)));
  }
  return labels;
}

/** BOTTOM — a bar per run, a dashed baseline, and a star on the best one. */
function timingsPanel({ width, height, results }) {
  const inner = width - 4;
  const { runs, baseline, best, key } = deriveRuns(results);
  const metric = key === "lcpMs" ? "LCP in ms" : `${key.replace(/Ms$/, "").toUpperCase()} in ms`;
  const title = `RUN TIMINGS (${metric})`;

  if (runs.length === 0) {
    return panel({
      width, height, title, titleRight: "Lower is better",
      body: [[seg("waiting for the first baseline measurement in .makefaster/results.json", "muted")]],
    });
  }

  const showLegend = inner >= AXIS_WIDTH + 34 + LEGEND_WIDTH;
  const plotWidth = Math.max(8, inner - AXIS_WIDTH - (showLegend ? LEGEND_WIDTH : 0) - 2);
  // Panel rows: value labels, the plot, run labels, an optional spacer, the
  // stats line. The plot gives up rows before the stats line does, because the
  // numbers matter more than the bar resolution.
  const capacity = height - 2;
  const spacer = capacity - 4 >= 3;
  const plotHeight = Math.max(2, capacity - (spacer ? 4 : 3));

  // Each run gets a slot wider than its bar, so bars read as separate columns
  // rather than as one filled block.
  const slot = Math.min(7, Math.max(3, Math.floor(plotWidth / runs.length)));
  const barWidth = Math.max(1, slot - (slot >= 5 ? 2 : 1));
  const columns = Math.max(1, Math.floor(plotWidth / slot));
  // More runs than columns: keep the baseline and the most recent runs, which
  // are the two things this chart exists to compare.
  const shown = runs.length <= columns ? runs : [runs[0], ...runs.slice(-(columns - 1))];

  const max = niceMax(Math.max(...shown.map((run) => run.value)));
  const cellValue = max / plotHeight;
  const baselineRow = baseline === null ? -1 : Math.min(plotHeight - 1, Math.max(0, Math.round(baseline / cellValue) - 1));
  const axisLabels = axisGridLabels({ max, cellValue, plotHeight });
  const plotTail = Math.max(0, plotWidth - shown.length * slot);

  const body = [];
  body.push([
    seg(" ".repeat(AXIS_WIDTH)),
    ...shown.map((run) => seg(
      pad(run === best ? `${STAR}${Math.round(run.value)}` : String(Math.round(run.value)), slot),
      run === best ? "barBest" : "muted",
    )),
  ]);

  for (let row = plotHeight - 1; row >= 0; row--) {
    const cells = [];
    cells.push(seg(pad(axisLabels.get(row) ?? "", AXIS_WIDTH - 1, "right"), "axis"), seg(" "));
    for (const run of shown) {
      const filled = run.value / cellValue;
      const whole = Math.floor(filled);
      let glyph = "";
      if (whole > row) glyph = BLOCK_FULL;
      else if (whole === row) glyph = BLOCKS[Math.round((filled - whole) * 8)] ?? "";
      if (glyph === "") {
        // No part of this bar reaches this row, so the baseline shows through.
        cells.push(row === baselineRow ? seg(BOX.dash.repeat(slot), "accent") : seg(" ".repeat(slot)));
      } else {
        cells.push(seg(pad(glyph.repeat(barWidth), slot), run === best ? "barBest" : "bar"));
      }
    }
    // Carry the dashed baseline across the empty part of the plot, so it reads
    // as one reference line rather than a dash under each short bar.
    cells.push(row === baselineRow ? seg(BOX.dash.repeat(plotTail), "accent") : seg(" ".repeat(plotTail)));
    if (showLegend) {
      cells.push(seg("  "));
      cells.push(...legendRow(row, plotHeight, { best, baseline }));
    }
    body.push(cells);
  }

  body.push([
    seg(" ".repeat(AXIS_WIDTH)),
    ...shown.map((run) => seg(pad(run.label, slot), run === best ? "value" : "muted")),
  ]);

  const recent = runs.slice(-5);
  const rolling = recent.reduce((sum, run) => sum + run.value, 0) / recent.length;
  const improvement = baseline && best ? ((best.value - baseline) / baseline) * 100 : null;
  if (spacer) body.push([]);
  body.push([
    seg("ROLLING AVERAGE (last 5 runs): ", "label"), seg(`${Math.round(rolling)} ms`, "value"),
    seg("   |   IMPROVEMENT vs BASELINE: ", "label"),
    seg(improvement === null ? "—" : `${improvement > 0 ? "+" : ""}${Math.round(improvement * 10) / 10}%`, improvement !== null && improvement < 0 ? "good" : "muted"),
    seg("   |   TOTAL RUNS: ", "label"), seg(String(runs.length), "value"),
  ]);

  return panel({ width, height, title, titleRight: "Lower is better", body });
}

function legendRow(row, plotHeight, { best, baseline }) {
  const fromTop = plotHeight - 1 - row;
  if (fromTop === 0 && best) {
    return [seg(`${STAR} BEST ${experimentId(best.index)}  `, "barBest"), seg(`${Math.round(best.value)} ms`, "value")];
  }
  if (fromTop === 1 && baseline !== null) {
    return [seg(`${BOX.dash.repeat(2)} BASELINE ${experimentId(0)}  `, "accent"), seg(`${Math.round(baseline)} ms`, "muted")];
  }
  if (fromTop === 2) return [seg(`${BLOCK_FULL} OTHER RUNS`, "bar")];
  return [];
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * Split the available rows between the three panels. Each has a floor; when the
 * terminal is too short to honour all three, the chart goes first and the log
 * second, so the numbers are the last thing to disappear.
 */
export function allocateHeights(rows) {
  const gap = rows >= 34 ? 1 : 0;
  const budget = rows - gap * 2;
  if (budget < LOG_MIN_HEIGHT + METRICS_MIN_HEIGHT + CHART_MIN_HEIGHT) {
    if (budget >= LOG_MIN_HEIGHT + METRICS_MIN_HEIGHT) {
      return { gap: 0, log: rows - METRICS_MIN_HEIGHT, metrics: METRICS_MIN_HEIGHT, chart: 0 };
    }
    return { gap: 0, log: 0, metrics: rows, chart: 0 };
  }
  // Roughly two fifths to the numbers, then the chart, then whatever is left to
  // the log — so a tall terminal grows the log rather than stretching the bars.
  const metrics = Math.min(METRICS_IDEAL_HEIGHT, Math.max(METRICS_MIN_HEIGHT, Math.floor(budget * 0.42)));
  const chart = Math.min(CHART_IDEAL_HEIGHT, Math.max(CHART_MIN_HEIGHT, budget - metrics - LOG_MIN_HEIGHT - 1));
  return { gap, log: budget - metrics - chart, metrics, chart };
}

/**
 * Build the whole frame.
 *
 * @param {object} args
 * @param {{columns: number, rows: number}} args.size
 * @param {object|null} args.results parsed .makefaster/results.json
 * @param {Array<{time: string, tag: string, text: string}>} args.log
 * @returns {Array<Array<{text: string, style: string}>>} exactly size.rows rows
 */
export function buildDashboard({ size, results, log = [], state = null, provider = null, model = null, status = "RUNNING", updatedAt = null }) {
  const width = Math.max(40, size.columns);
  const heights = allocateHeights(Math.max(12, size.rows));
  const rows = [];
  const blank = () => [seg(" ".repeat(width))];

  if (heights.log > 0) rows.push(...thinkingPanel({ width, height: heights.log, log, model, provider }));
  if (heights.gap) rows.push(blank());
  if (heights.metrics > 0) rows.push(...autoresearchPanel({ width, height: heights.metrics, results, state, status, updatedAt }));
  if (heights.gap) rows.push(blank());
  if (heights.chart > 0) rows.push(...timingsPanel({ width, height: heights.chart, results }));

  const target = Math.max(12, size.rows);
  while (rows.length < target) rows.push(blank());
  return rows.slice(0, target);
}

export const PANEL_BACKGROUND = COLORS.panel;
export const SCREEN_BACKGROUND = COLORS.screen;
