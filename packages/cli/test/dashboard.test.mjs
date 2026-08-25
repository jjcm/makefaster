import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateHeights, buildDashboard, deriveMetrics, deriveRuns, deriveVerdict, pickMode } from "../lib/dashboard.js";
import { fit, formatDuration, plainText, renderRow, seg } from "../lib/theme.js";

const RESULTS = {
  version: 1,
  site: { url: "example.com" },
  northStar: "lcp",
  profilingTool: "lighthouse 12.x, median of 3 runs",
  noiseFloor: { lcpMs: 40 },
  baseline: { cold: { lcpMs: 2420, ttiMs: 3900, fcpMs: 1400, tbtMs: 210, cls: 0.08, score: 72 } },
  final: { cold: { lcpMs: 1680, ttiMs: 3050, fcpMs: 1150, tbtMs: 120, cls: 0.03, score: 91 } },
  iterations: [
    { n: 1, name: "Inline critical CSS", description: "Inlined above-the-fold styles", deltaMs: -140, deltaPct: -5.8, kept: true },
    { n: 2, name: "Preload thumbnails", deltaMs: 150, deltaPct: 6.6, kept: false },
    { n: 3, name: "Convert hero to AVIF", deltaMs: -600, deltaPct: -26.3, kept: true },
  ],
};

/** The run plan the CLI writes into state.json (see session.runPlan). */
const STATE = { round: 1, checklistCount: 24, extrasBudget: 5, plannedRuns: 29 };

const text = (rows) => rows.map(plainText).join("\n");

test("pickMode prefers the mode that was actually measured", () => {
  assert.equal(pickMode(RESULTS), "cold");
  assert.equal(pickMode({ baseline: { warm: { lcpMs: 1 } } }), "warm");
  assert.equal(pickMode(null), "cold");
});

test("deriveMetrics compares candidate to baseline and knows which way is better", () => {
  const metrics = deriveMetrics(RESULTS);
  assert.deepEqual(metrics.map((m) => m.short), ["LCP", "TBT", "FCP", "TTI", "CLS", "PERF SCORE"]);

  const lcp = metrics.find((m) => m.short === "LCP");
  assert.equal(lcp.candidate, "1.68 s");
  assert.equal(lcp.baseline, "2.42 s");
  assert.equal(lcp.changeLabel, "-30.6%");
  assert.equal(lcp.better, true);

  // A higher score is better, so the sign flips meaning and it reads as points.
  const score = metrics.find((m) => m.short === "PERF SCORE");
  assert.equal(score.changeLabel, "+19");
  assert.equal(score.better, true);

  const cls = metrics.find((m) => m.short === "CLS");
  assert.equal(cls.candidate, "0.03");
  assert.equal(cls.better, true);
});

test("deriveMetrics omits metrics the session never measured", () => {
  const metrics = deriveMetrics({ baseline: { cold: { lcpMs: 2000, ttiMs: 3000 } }, final: { cold: { lcpMs: 1800, ttiMs: 2900 } } });
  assert.deepEqual(metrics.map((m) => m.short), ["LCP", "TTI"]);
});

test("deriveMetrics marks a regression as worse, not just as a positive number", () => {
  const metrics = deriveMetrics({ baseline: { cold: { lcpMs: 1000 } }, final: { cold: { lcpMs: 1200 } } });
  assert.equal(metrics[0].changeLabel, "+20%");
  assert.equal(metrics[0].better, false);
});

test("deriveRuns walks the deltas from the baseline; reverted runs do not move it", () => {
  const { baseline, runs, best } = deriveRuns(RESULTS);
  assert.equal(baseline, 2420);
  assert.deepEqual(runs.map((r) => r.value), [2420, 2280, 2430, 1680]);
  //                                          base  kept  reverted (from 2280) kept
  assert.deepEqual(runs.map((r) => r.label), ["000", "001", "002", "003"]);
  assert.equal(best.value, 1680);
  assert.equal(best.label, "003");
});

test("deriveRuns skips unmeasured iterations rather than plotting a guess", () => {
  const { runs } = deriveRuns({
    baseline: { cold: { lcpMs: 1000 } },
    iterations: [{ n: 1, name: "no numbers" }, { n: 2, name: "measured", deltaMs: -100, kept: true }],
  });
  assert.deepEqual(runs.map((r) => r.value), [1000, 900]);
});

// The whole point of the chart: a measured iteration is a run whatever the
// verdict was. A run that only appears when it wins is a highlight reel.
test("a keep adds a bar and moves the candidate off the baseline", () => {
  const results = {
    northStar: "lcp",
    baseline: { warm: { lcpMs: 4658, ttiMs: 6000 } },
    iterations: [{ n: 1, name: "Defer non-critical scripts", deltaMs: -1050, deltaPct: -22.5, kept: true }],
  };
  const { runs, candidate, best } = deriveRuns(results);
  assert.deepEqual(runs.map((r) => r.value), [4658, 3608]);
  assert.equal(candidate.index, 1);
  assert.equal(candidate.metrics.lcpMs, 3608);
  assert.equal(best.label, "001");

  // No results.final yet — mid-run the candidate column is where the keeps have
  // walked the site to, not the baseline sitting at 0%.
  const lcp = deriveMetrics(results).find((m) => m.short === "LCP");
  assert.equal(lcp.candidate, "3.61 s");
  assert.equal(lcp.baseline, "4.66 s");
  assert.equal(lcp.changeLabel, "-22.5%");
  assert.equal(lcp.better, true);
  assert.equal(deriveVerdict(results).label, "IMPROVED");
});

test("a reverted miss still gets a bar, and does not move the candidate", () => {
  const results = {
    northStar: "lcp",
    baseline: { cold: { lcpMs: 2000 } },
    iterations: [
      { n: 1, name: "Preload LCP image", deltaMs: 210, deltaPct: 10.5, kept: false },
      { n: 2, name: "Enable gzip", deltaMs: -300, deltaPct: -15, kept: true },
      { n: 3, name: "Inline critical CSS", deltaMs: 40, deltaPct: 2.4, kept: false },
    ],
  };
  const { runs, candidate } = deriveRuns(results);
  assert.deepEqual(runs.map((r) => r.value), [2000, 2210, 1700, 1740]);
  assert.deepEqual(runs.map((r) => r.kept), [true, false, true, false]);
  // The last run is a miss, so the site still stands at the last keep.
  assert.equal(candidate.index, 2);
  assert.equal(candidate.metrics.lcpMs, 1700);
});

test("an iteration that reports where it landed is plotted without a delta", () => {
  const results = {
    northStar: "lcp",
    baseline: { warm: { lcpMs: 4658, ttiMs: 6000 } },
    iterations: [{ n: 1, name: "Defer non-critical scripts", kept: true, measured: { warm: { lcpMs: 3608, ttiMs: 5200 } } }],
  };
  const { runs, candidate } = deriveRuns(results);
  assert.deepEqual(runs.map((r) => r.value), [4658, 3608]);
  // The delta is the measurement against the state it ran from, so the verdict
  // and the RESULT line still have a number to quote.
  assert.equal(runs[1].deltaMs, -1050);
  assert.equal(deriveVerdict(results).label, "IMPROVED");
  assert.equal(candidate.metrics.ttiMs, 5200);
  assert.equal(deriveMetrics(results).find((m) => m.short === "TTI").candidate, "5.20 s");
});

// An absolute wins over a delta, because it is the number that was measured
// rather than one derived from a running total.
test("an absolute north-star value is trusted over a stale delta", () => {
  const { runs } = deriveRuns({
    baseline: { cold: { lcpMs: 2000 } },
    iterations: [{ n: 1, name: "x", deltaMs: -1, kept: true, measured: { cold: { lcpMs: 1500 } } }],
  });
  assert.deepEqual(runs.map((r) => r.value), [2000, 1500]);
  assert.equal(runs[1].deltaMs, -500);
});

test("a stub with no numbers is not a run, a verdict, or a candidate", () => {
  const results = {
    northStar: "lcp",
    baseline: { cold: { lcpMs: 2000, ttiMs: 3000 } },
    iterations: [{ kept: false }, { n: 2, kept: true }],
  };
  const { runs, candidate } = deriveRuns(results);
  assert.deepEqual(runs.map((r) => r.value), [2000], "an unfilled row has nothing to plot");
  assert.equal(candidate.isBaseline, true);
  assert.equal(deriveVerdict(results).label, "PENDING");
  assert.deepEqual(deriveMetrics(results).map((m) => m.changeLabel), ["0%", "0%"]);
});

test("a skip never gets a bar, even when it was written into iterations", () => {
  const { runs } = deriveRuns({
    baseline: { cold: { lcpMs: 2000 } },
    iterations: [
      { n: 1, name: "Enable gzip", skipped: true, measured: { cold: { lcpMs: 2000 } } },
      { n: 2, name: "Lazy-load components", kept: "skipped", deltaMs: 0 },
      { n: 3, name: "Inline critical CSS", deltaMs: -120, kept: true },
    ],
  });
  assert.deepEqual(runs.map((r) => r.label), ["000", "003"]);
});

test("deriveRuns needs a baseline before it will plot anything", () => {
  assert.deepEqual(deriveRuns(null).runs, []);
  assert.deepEqual(deriveRuns({ iterations: [{ deltaMs: -10 }] }).runs, []);
});

test("deriveVerdict reads the latest iteration against the noise floor", () => {
  assert.equal(deriveVerdict(RESULTS).label, "IMPROVED");
  assert.equal(deriveVerdict({ iterations: [{ deltaMs: 200 }] }).label, "REGRESSED");
  assert.equal(deriveVerdict({ noiseFloor: { lcpMs: 40 }, iterations: [{ deltaMs: 12 }] }).label, "UNCHANGED");
  assert.equal(deriveVerdict({}).label, "PENDING");
});

test("allocateHeights honours the panel floors and never overruns the terminal", () => {
  for (const rows of [12, 18, 24, 30, 34, 40, 60, 120]) {
    const { gap, log, metrics, chart } = allocateHeights(rows);
    assert.equal(log + metrics + chart + gap * 2, rows, `rows=${rows}`);
    assert.ok(metrics > 0, `rows=${rows} must always keep the numbers`);
    if (chart > 0) assert.ok(chart >= 8, `rows=${rows}`);
    if (log > 0) assert.ok(log >= 5, `rows=${rows}`);
  }
  // Short terminals drop the chart first, then the log — numbers survive last.
  assert.equal(allocateHeights(16).chart, 0);
  assert.equal(allocateHeights(12).log, 0);
  assert.ok(allocateHeights(40).chart > 0 && allocateHeights(40).log > 0);
});

test("buildDashboard fills exactly the terminal it was given", () => {
  for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }, { columns: 200, rows: 60 }]) {
    const rows = buildDashboard({ size, results: RESULTS, log: [] });
    assert.equal(rows.length, size.rows, JSON.stringify(size));
    for (const row of rows) {
      assert.ok(plainText(row).length <= size.columns + 2, `row overflows at ${JSON.stringify(size)}: ${plainText(row).length}`);
    }
  }
});

test("buildDashboard renders all three panels with their real numbers", () => {
  const frame = text(buildDashboard({
    size: { columns: 120, rows: 44 },
    results: RESULTS,
    state: STATE,
    provider: { displayName: "Cursor Agent" },
    model: { id: "claude-fable-5-max", label: "Claude Fable 5 (max)" },
    status: "RUNNING",
    updatedAt: "10:42:32",
    log: [
      { time: "10:42:11", tag: "CHECKLIST", text: "Walking 50 imported categories in rank order." },
      { time: "10:42:12", tag: "TRY", text: "Convert hero to AVIF and preload the hero font" },
      { time: "10:42:32", tag: "RESULT", text: "-260ms / -10.8% on lcp — kept" },
    ],
  }));

  // Panel titles.
  assert.match(frame, />_ AGENT THINKING/);
  assert.match(frame, /AUTORESEARCH \/ WEBSITE SPEED/);
  assert.match(frame, /RUN TIMINGS \(LCP in ms\)/);

  // Top panel: header context plus the tagged log.
  assert.match(frame, /model: claude-fable-5-max/);
  assert.match(frame, /cli: Cursor Agent \(hidden\)/);
  assert.match(frame, /10:42:11\s+\[CHECKLIST\]\s+Walking 50 imported categories/);
  assert.match(frame, /\[TRY\]/);
  assert.match(frame, /\[RESULT\]/);

  // Middle panel: loop, experiment, status, metrics, comparison table, footer.
  assert.match(frame, /LOOP 003/);
  assert.match(frame, /CURRENT EXPERIMENT: Convert hero to AVIF/);
  assert.match(frame, /STATUS: RUNNING/);
  assert.match(frame, /RESULT: IMPROVED/);
  assert.match(frame, /UPDATED: 10:42:32/);
  assert.match(frame, /PAGE LOAD TIME \(LCP\)\s+1\.68 s\s+2\.42 s\s+-30\.6%/);
  assert.match(frame, /CANDIDATE/);
  assert.match(frame, /exp_003/);
  assert.match(frame, /exp_000/);
  assert.match(frame, /profiler: lighthouse 12\.x/);

  // Bottom panel: bars, axis labels, footer stats. The chart is bars and
  // numbers — no legend block and no reference line drawn through the plot.
  assert.match(frame, /Lower is better/);
  assert.match(frame, /1680/);
  assert.match(frame, /2420/);
  assert.match(frame, /★1680/, "the best run keeps its star");
  assert.match(frame, /ROLLING AVERAGE \(last 5 runs\)/);
  assert.match(frame, /TOTAL RUNS: 4/);
  assert.match(frame, /IMPROVEMENT vs BASELINE: -30\.6%/);
  assert.doesNotMatch(frame, /BEST exp_/);
  assert.doesNotMatch(frame, /BASELINE exp_/);
  assert.doesNotMatch(frame, /OTHER RUNS/);
  assert.doesNotMatch(frame, /╌/);
});

// Mid-run, before results.final exists: the panels must have moved off the
// baseline, or the user reads a working loop as a stalled one.
test("buildDashboard advances the loop and the candidate before final is written", () => {
  const frame = text(buildDashboard({
    size: { columns: 120, rows: 44 },
    results: {
      northStar: "lcp",
      noiseFloor: { lcpMs: 40 },
      baseline: { warm: { lcpMs: 4658 } },
      iterations: [
        { n: 1, name: "Preload LCP image", deltaMs: 210, deltaPct: 4.5, kept: false },
        { n: 2, name: "Defer non-critical scripts", deltaMs: -1050, deltaPct: -22.5, kept: true },
      ],
    },
    log: [],
  }));

  assert.match(frame, /LOOP 002/);
  assert.match(frame, /CURRENT EXPERIMENT: Defer non-critical scripts/);
  assert.match(frame, /RESULT: IMPROVED/);
  assert.match(frame, /exp_002/, "the candidate column names the last kept run");
  assert.match(frame, /PAGE LOAD TIME \(LCP\)\s+3\.61 s\s+4\.66 s\s+-22\.5%/);
  assert.match(frame, /TOTAL RUNS: 3/, "baseline, the miss, and the keep");
  assert.match(frame, /3608/);
  assert.match(frame, /4868/);
});

test("buildDashboard survives an empty session and a half-written file", () => {
  for (const results of [null, {}, { iterations: [] }, { baseline: {} }]) {
    const rows = buildDashboard({ size: { columns: 100, rows: 40 }, results, log: [] });
    assert.equal(rows.length, 40);
    const frame = text(rows);
    assert.match(frame, /AUTORESEARCH \/ WEBSITE SPEED/);
    assert.match(frame, /waiting for the first baseline measurement/);
  }
});

// The counter is a position in a planned run, not a tally: "LOOP 005" on its own
// reads like an ending on a board with 24 categories still to walk.
test("the loop counter shows the run's planned length, and the panel says what it is made of", () => {
  const frame = text(buildDashboard({
    size: { columns: 120, rows: 44 },
    results: RESULTS,
    state: STATE,
    log: [],
  }));
  assert.match(frame, /LOOP 003 OF 029/);
  assert.match(frame, /24 checklist \+ up to 5 extra/);
  assert.match(frame, /round 1/);
});

// A round from an older session, or one recorded before the plan existed, still
// renders — it just says less.
test("the loop counter falls back to a bare count without a plan", () => {
  const frame = text(buildDashboard({
    size: { columns: 120, rows: 44 },
    results: RESULTS,
    state: { round: 2 },
    log: [],
  }));
  assert.match(frame, /LOOP 003/);
  assert.doesNotMatch(frame, /LOOP 003 OF/);
  assert.match(frame, /round 2/);
});

test("a long log keeps only what fits, newest last", () => {
  const log = Array.from({ length: 400 }, (_, i) => ({ time: "00:00:00", tag: "TRY", text: `line ${i}` }));
  const frame = text(buildDashboard({ size: { columns: 100, rows: 44 }, results: RESULTS, log }));
  assert.match(frame, /line 399/);
  assert.doesNotMatch(frame, /line 0\b/);
});

test("renderRow produces exactly the requested cell count", () => {
  const plain = renderRow([seg("abc", "value"), seg("def", "muted")], { width: 10 }).replace(/\u001b\[[0-9;]*m/g, "");
  assert.equal(plain, "abcdef    ");
  const clipped = renderRow([seg("abcdefghijkl")], { width: 5 }).replace(/\u001b\[[0-9;]*m/g, "");
  assert.equal(clipped, "abcde");
});

test("theme formatting helpers", () => {
  assert.equal(formatDuration(1680), "1.68 s");
  assert.equal(formatDuration(180), "180 ms");
  assert.equal(formatDuration(Number.NaN), "—");
  assert.equal(fit("a very long sentence indeed", 10), "a very lo…");
  assert.equal(fit("short", 10), "short");
});
