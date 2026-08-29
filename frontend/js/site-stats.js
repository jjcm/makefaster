/**
 * The landing band's numbers, derived from the public site leaderboard.
 *
 * Kept free of DOM access so the arithmetic can be tested directly: the
 * component owns the markup, this module owns what "the average LCP
 * improvement" actually means.
 *
 * A site appears on the board once per load mode — `POST /api/submit-site`
 * upserts one row per site per mode — so a site measured cold and warm has two
 * rows and would otherwise weigh twice as much in an average as a site measured
 * once. `oneRunPerSite` collapses that to a single run per site, preferring the
 * cold load: it is the harder number, and it is what the site leaderboard shows
 * by default.
 *
 * Only LCP, TTI and the site count come from here. Submissions carry no
 * Lighthouse performance score, so the band does not claim one.
 */

/** The load mode a site is counted by when it was measured both ways. */
const PREFERRED_MODE = "cold";

/** Which site a row belongs to. The URL is the board's own identity for one. */
function siteKey(row) {
  return String((row && (row.url || row.name)) || "").trim().toLowerCase();
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value);
}

/**
 * One run per site, in first-seen order. A site with both a cold and a warm
 * row keeps the cold one; a site measured only warm keeps that, because
 * dropping it would undercount the board.
 *
 * @param {Array<object>} rows the raw /data/sites.json rows
 * @returns {Array<object>} at most one row per site
 */
export function oneRunPerSite(rows) {
  if (!Array.isArray(rows)) return [];

  var order = [];
  var chosen = {};

  rows.forEach(function (row) {
    var key = siteKey(row);
    if (!key) return;
    var current = chosen[key];
    if (!current) {
      order.push(key);
      chosen[key] = row;
      return;
    }
    // A later cold row replaces a warm one; a second row of the same mode does
    // not, so the board's own ordering decides ties.
    if (current.mode !== PREFERRED_MODE && row.mode === PREFERRED_MODE) chosen[key] = row;
  });

  return order.map(function (key) {
    return chosen[key];
  });
}

/**
 * The mean of one delta across the runs that measured it, or null when none
 * did. A row missing the field is skipped rather than counted as a zero, which
 * would drag the average toward "no improvement".
 */
function averageDelta(runs, key) {
  var total = 0;
  var measured = 0;
  runs.forEach(function (run) {
    if (!isNumber(run[key])) return;
    total += run[key];
    measured += 1;
  });
  return measured === 0 ? null : total / measured;
}

/**
 * The three numbers the band shows.
 *
 * @param {Array<object>} rows the raw /data/sites.json rows
 * @returns {{siteCount: number, lcpDelta: number|null, ttiDelta: number|null}}
 *   deltas are percentages vs. baseline, negative = faster, null = nothing on
 *   the board has measured that metric yet
 */
export function summarizeSites(rows) {
  var runs = oneRunPerSite(rows);
  return {
    siteCount: runs.length,
    lcpDelta: averageDelta(runs, "lcpDelta"),
    ttiDelta: averageDelta(runs, "ttiDelta"),
  };
}

/**
 * A delta as the band prints it: whole percent, explicitly signed when the
 * average went the wrong way, and an en dash when there is nothing to print.
 * `-0%` is normalized to `0%` — a rounding artefact should not read as a loss.
 */
export function formatDeltaPct(pct) {
  if (!isNumber(pct)) return "\u2013";
  var whole = Math.round(pct) || 0;
  return (whole > 0 ? "+" : "") + whole + "%";
}

/** The "before" bar's height in css/style.css, which the "after" bar scales from. */
export const BEFORE_BAR_PX = 104;

/**
 * The "after" bar's height for a delta, in pixels. Clamped so a huge win still
 * leaves a visible stub and a regression cannot grow out of the 132px chart.
 */
export function afterBarHeight(pct) {
  if (!isNumber(pct)) return 0;
  var scaled = Math.round(BEFORE_BAR_PX * (1 + pct / 100));
  return Math.max(6, Math.min(124, scaled));
}
