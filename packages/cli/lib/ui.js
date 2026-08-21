/**
 * Tiny terminal helpers — colors that respect NO_COLOR and non-TTY output,
 * plus the shared banner. No dependencies.
 */

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  Boolean(process.stdout.isTTY);

function paint(code) {
  return (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text));
}

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

export const OK = green("+");
export const FAIL = red("x");
export const ARROW = "->";

export function hr(width = 56) {
  return dim("-".repeat(width));
}

export function banner(version) {
  const lines = [
    "",
    `  ${bold("makefaster")} ${dim(`v${version}`)}`,
    `  ${dim("autoresearch loop: profile -> hypothesis -> measure -> keep or revert")}`,
    "",
  ];
  return lines.join("\n");
}

/** "1842" -> "1,842" without locale surprises. */
export function formatInt(value) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Signed percentage with one decimal: -12.34 -> "-12.3%". */
export function formatPct(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** Signed milliseconds: -120 -> "-120ms". */
export function formatMs(value) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${formatInt(rounded)}ms`;
}
