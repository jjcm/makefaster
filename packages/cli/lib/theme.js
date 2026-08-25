/**
 * The makefaster dashboard's palette and its one primitive: turn a row of
 * styled segments into exactly N terminal cells.
 *
 * Layout math never sees escape codes. A row is an array of
 * `{ text, style }` segments, so width, padding and truncation are measured on
 * plain strings and color is applied last. That also means the dashboard can be
 * asserted on as text in tests.
 *
 * Every glyph the dashboard draws — box borders, block bars, the best-run star —
 * is a single-width character, so `text.length` is the cell count.
 */

const enabled = () => !process.env.NO_COLOR && process.env.TERM !== "dumb";

/** Dark forest ground, light-green values, orange reserved for run identity. */
export const COLORS = {
  screen: 233,
  panel: 234,
  border: 65,
  title: 151,
  label: 108,
  value: 156,
  accent: 214,
  muted: 240,
  good: 156,
  bad: 174,
  bar: 71,
  barBest: 194,
  axis: 59,
};

const STYLES = {
  text: { fg: COLORS.value },
  border: { fg: COLORS.border },
  title: { fg: COLORS.title, bold: true },
  heading: { fg: COLORS.label, bold: true },
  label: { fg: COLORS.label },
  value: { fg: COLORS.value, bold: true },
  accent: { fg: COLORS.accent, bold: true },
  muted: { fg: COLORS.muted },
  good: { fg: COLORS.good },
  bad: { fg: COLORS.bad },
  bar: { fg: COLORS.bar },
  barBest: { fg: COLORS.barBest, bold: true },
  axis: { fg: COLORS.axis },
  tag: { fg: COLORS.label, bold: true },
  time: { fg: COLORS.muted },
};

export const BOX = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h: "─", v: "│",
  lt: "├", rt: "┤",
};

/** Bottom-anchored eighths, for bar tops that fall between rows. */
export const BLOCKS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];
export const BLOCK_FULL = "█";
export const STAR = "★";

/** @returns {{text: string, style: string}} */
export function seg(text, style = "text") {
  return { text: String(text), style };
}

/** The plain text of a row — what layout math and tests operate on. */
export function plainText(segments) {
  return segments.map((s) => s.text).join("");
}

function sgr(style, background) {
  if (!enabled()) return "";
  const spec = STYLES[style] ?? STYLES.text;
  const codes = ["0"];
  if (background !== null && background !== undefined) codes.push(`48;5;${background}`);
  codes.push(`38;5;${spec.fg}`);
  if (spec.bold) codes.push("1");
  return `\u001b[${codes.join(";")}m`;
}

/**
 * Render one row as exactly `width` cells: segments in order, hard-truncated
 * when they overflow and space-padded when they fall short.
 *
 * @param {Array<{text: string, style: string}>} segments
 * @param {object} options
 * @param {number} options.width
 * @param {number|null} [options.background] 256-color index for the row fill
 */
export function renderRow(segments, { width, background = null }) {
  let used = 0;
  let out = "";
  for (const { text, style } of segments) {
    if (used >= width) break;
    const slice = text.length > width - used ? text.slice(0, width - used) : text;
    if (slice.length === 0) continue;
    out += `${sgr(style, background)}${slice}`;
    used += slice.length;
  }
  if (used < width) out += `${sgr("text", background)}${" ".repeat(width - used)}`;
  return `${out}${enabled() ? "\u001b[0m" : ""}`;
}

/** Truncate to `width` cells, marking the cut with an ellipsis. */
export function fit(text, width) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (width <= 0) return "";
  if (flat.length <= width) return flat;
  return width === 1 ? "…" : `${flat.slice(0, width - 1)}…`;
}

/** "1680" -> "1.68 s"; "180" -> "180 ms" — the dashboard's time format. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}
