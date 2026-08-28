import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEFORE_BAR_PX,
  afterBarHeight,
  formatDeltaPct,
  oneRunPerSite,
  summarizeSites,
} from "../js/site-stats.js";

/* A board with a site measured both ways, one measured cold only, and one warm only. */
const BOARD = [
  { url: "alpha.dev", mode: "cold", lcpDelta: -40, ttiDelta: -30 },
  { url: "alpha.dev", mode: "warm", lcpDelta: -10, ttiDelta: -8 },
  { url: "beta.dev", mode: "cold", lcpDelta: -20, ttiDelta: -10 },
  { url: "gamma.dev", mode: "warm", lcpDelta: -30, ttiDelta: -20 },
];

const urls = (rows) => rows.map((r) => r.url);

// A site is on the board once per load mode, so averaging the raw rows would
// weigh a site measured twice as much as a site measured once.
test("a site measured cold and warm is counted once, on its cold run", () => {
  const runs = oneRunPerSite(BOARD);
  assert.deepEqual(urls(runs), ["alpha.dev", "beta.dev", "gamma.dev"]);
  assert.deepEqual(runs.map((r) => r.mode), ["cold", "cold", "warm"]);
  assert.equal(runs[0].lcpDelta, -40, "alpha keeps its cold measurement");
});

test("the cold run wins whichever order the board returns the two rows in", () => {
  const warmFirst = [BOARD[1], BOARD[0]];
  assert.equal(oneRunPerSite(warmFirst)[0].mode, "cold");
  assert.equal(oneRunPerSite([BOARD[0], BOARD[1]])[0].mode, "cold");
  // And a site measured only warm is kept rather than dropped, which would
  // undercount the board.
  assert.deepEqual(urls(oneRunPerSite([BOARD[3]])), ["gamma.dev"]);
});

test("the averages are over one run per site, not over every row", () => {
  const stats = summarizeSites(BOARD);
  assert.equal(stats.siteCount, 3);
  // (-40 + -20 + -30) / 3, not the four-row mean of -25.
  assert.equal(stats.lcpDelta, -30);
  assert.equal(stats.ttiDelta, -20);
});

// A missing delta is not a zero: counting it as one would drag the average
// toward "no improvement" and understate every site that did report.
test("a row missing a delta is skipped for that metric but still counts as a site", () => {
  const stats = summarizeSites([
    { url: "a.dev", mode: "cold", lcpDelta: -40, ttiDelta: -20 },
    { url: "b.dev", mode: "cold", lcpDelta: -20 },
  ]);
  assert.equal(stats.siteCount, 2);
  assert.equal(stats.lcpDelta, -30);
  assert.equal(stats.ttiDelta, -20, "the one measured TTI is the average");
});

test("an empty board is zero sites and no averages, not zero percent", () => {
  for (const empty of [[], null, undefined, "nope"]) {
    const stats = summarizeSites(empty);
    assert.deepEqual(stats, { siteCount: 0, lcpDelta: null, ttiDelta: null }, String(empty));
  }
  // A board whose rows measured nothing is the same story.
  assert.deepEqual(summarizeSites([{ url: "a.dev", mode: "cold" }]), {
    siteCount: 1,
    lcpDelta: null,
    ttiDelta: null,
  });
});

test("rows without a site to belong to are ignored", () => {
  assert.deepEqual(urls(oneRunPerSite([{ mode: "cold", lcpDelta: -50 }, { url: "  ", mode: "cold" }])), []);
  // The URL is matched case-insensitively, so one site is not two rows.
  assert.equal(oneRunPerSite([{ url: "A.dev", mode: "warm" }, { url: "a.dev", mode: "cold" }]).length, 1);
});

test("a delta prints as whole percent, signed only when it went the wrong way", () => {
  assert.equal(formatDeltaPct(-38.4), "-38%");
  assert.equal(formatDeltaPct(-38.6), "-39%");
  assert.equal(formatDeltaPct(12.2), "+12%");
  // A rounding artefact must not read as a loss.
  assert.equal(formatDeltaPct(-0.2), "0%");
  for (const nothing of [null, undefined, NaN, Infinity, "-38"]) {
    assert.equal(formatDeltaPct(nothing), "\u2013", String(nothing));
  }
});

test("the after bar scales from the before bar and stays inside the chart", () => {
  assert.equal(afterBarHeight(-38), Math.round(BEFORE_BAR_PX * 0.62));
  assert.equal(afterBarHeight(0), BEFORE_BAR_PX);
  // A near-total win still leaves a visible stub, and a regression cannot grow
  // out of the 132px chart.
  assert.equal(afterBarHeight(-99.9), 6);
  assert.equal(afterBarHeight(400), 124);
  // Nothing measured draws no bar at all.
  assert.equal(afterBarHeight(null), 0);
});
