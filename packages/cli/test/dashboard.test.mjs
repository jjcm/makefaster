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
  missStreak: 0,
};

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
    state: { round: 1 },
    provider: { displayName: "Cursor Agent" },
    model: { id: "claude-fable-5-max", label: "Claude Fable 5 (max)" },
    status: "RUNNING",
    updatedAt: "10:42:32",
    log: [
      { time: "10:42:11", tag: "OBSERVE", text: "identified slow render path: /assets/hero-bg.jpg blocking LCP" },
      { time: "10:42:12", tag: "HYPOTHESIS", text: "convert hero image to AVIF and preload the hero font" },
      { time: "10:42:32", tag: "COMPARE", text: "beat the noise floor — kept, new best candidate" },
    ],
  }));

  // Panel titles.
  assert.match(frame, />_ AGENT THINKING/);
  assert.match(frame, /AUTORESEARCH \/ WEBSITE SPEED/);
  assert.match(frame, /RUN TIMINGS \(LCP in ms\)/);

  // Top panel: header context plus the tagged log.
  assert.match(frame, /model: claude-fable-5-max/);
  assert.match(frame, /cli: Cursor Agent \(hidden\)/);
  assert.match(frame, /10:42:11\s+\[OBSERVE\]\s+identified slow render path/);
  assert.match(frame, /\[HYPOTHESIS\]/);
  assert.match(frame, /\[COMPARE\]/);

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

  // Bottom panel: bars, axis labels, legend, footer stats.
  assert.match(frame, /Lower is better/);
  assert.match(frame, /1680/);
  assert.match(frame, /2420/);
  assert.match(frame, /★ BEST exp_003/);
  assert.match(frame, /BASELINE exp_000/);
  assert.match(frame, /ROLLING AVERAGE \(last 5 runs\)/);
  assert.match(frame, /TOTAL RUNS: 4/);
  assert.match(frame, /IMPROVEMENT vs BASELINE: -30\.6%/);
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

test("a long log keeps only what fits, newest last", () => {
  const log = Array.from({ length: 400 }, (_, i) => ({ time: "00:00:00", tag: "EXECUTE", text: `line ${i}` }));
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
