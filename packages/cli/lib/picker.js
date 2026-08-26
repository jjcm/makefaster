/**
 * Interactive terminal prompts over raw readline — no dependencies.
 *   selectFrom  — arrow-key (or j/k, or 1-9) list picker
 *   confirm     — y/n question
 *   question    — free-text question
 * Non-TTY stdin throws { code: "NO_TTY" } so callers can degrade explicitly.
 */

import readline from "node:readline";
import { bold, cyan, dim } from "./ui.js";

/**
 * How long a lone ESC byte may sit unfollowed before it means "the user pressed
 * Escape" rather than "an arrow sequence is still arriving". Arrow keys are
 * multi-byte escape sequences, and raw-mode reads are allowed to split them
 * across `data` events — which happens in practice when the terminal is busy,
 * e.g. repainting a small window every keypress.
 */
const ESC_GRACE_MS = 50;

function requireTty(stdin = process.stdin) {
  if (!stdin.isTTY) {
    throw Object.assign(new Error("interactive prompt needs a TTY"), { code: "NO_TTY" });
  }
}

const SGR_PATTERN = /\u001b\[[0-9;]*m/g;

/** Visible width of a line, not counting ANSI style sequences. */
export function visibleLength(text) {
  return String(text).replace(SGR_PATTERN, "").length;
}

/**
 * Clip a (possibly styled) line to `width` visible columns, ellipsizing when it
 * would overflow. Style sequences are carried through without counting, and a
 * clipped styled line ends with a reset so the cut cannot leak color into the
 * next row. Picker rows must never wrap: a wrapped row occupies more physical
 * lines than the renderer accounts for, and the stale extra lines are what
 * ghosting is made of.
 */
export function clipLine(text, width) {
  const line = String(text);
  if (visibleLength(line) <= width) return line;
  let out = "";
  let visible = 0;
  let styled = false;
  let i = 0;
  const budget = Math.max(0, width - 1); // reserve one column for the ellipsis
  while (i < line.length && visible < budget) {
    if (line[i] === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(line.slice(i));
      if (match) {
        out += match[0];
        styled = true;
        i += match[0].length;
        continue;
      }
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${styled ? "\u001b[0m" : ""}`;
}

const SEQUENCE_NAMES = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

/**
 * Decode raw-mode bytes into key events, tolerating escape sequences that are
 * split across reads. Returns the keys that are complete plus the trailing
 * bytes that may still be the start of one, for the caller to prepend to the
 * next chunk. Both CSI ("\u001b[A") and SS3 ("\u001bOA") arrows decode to the
 * same names, because terminals in application-cursor-keys mode send the
 * latter and a picker has no say in which mode it inherits.
 *
 * @param {string} input
 * @returns {{keys: Array<{name: string, sequence: string}>, pending: string}}
 */
export function parseKeys(input) {
  const keys = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "\u001b") {
      keys.push({ name: ch, sequence: ch });
      i += 1;
      continue;
    }
    if (i === input.length - 1) {
      // ESC with nothing after it yet: maybe Escape, maybe half an arrow.
      return { keys, pending: "\u001b" };
    }
    const introducer = input[i + 1];
    if (introducer === "[" || introducer === "O") {
      let j = i + 2;
      while (j < input.length && /[0-9;]/.test(input[j])) j += 1;
      if (j === input.length) return { keys, pending: input.slice(i) };
      const final = input[j];
      keys.push({ name: SEQUENCE_NAMES[final] ?? `sequence-${final}`, sequence: input.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // ESC followed by an ordinary byte is a real Escape press, then that byte.
    keys.push({ name: "escape", sequence: "\u001b" });
    i += 1;
  }
  return { keys, pending: "" };
}

/**
 * The picker frame as fully-clipped lines — pure, so tests can render at any
 * size. Every line fits `width` (no wrapping, ever), and when the options
 * outnumber the rows available only a window around the selection is shown, so
 * the frame also fits `height` and cursor-up repositioning cannot clamp
 * against the top of a short terminal.
 */
export function renderFrame({ title, options, index, width, height }) {
  const chrome = 2; // the title and the footer
  const visibleCount = Math.max(1, Math.min(options.length, height - chrome));
  const first = Math.min(
    Math.max(0, index - Math.floor((visibleCount - 1) / 2)),
    options.length - visibleCount,
  );
  const rows = options.slice(first, first + visibleCount).map((option, offset) => {
    const i = first + offset;
    const pointer = i === index ? cyan(">") : " ";
    const label = i === index ? bold(option.label) : option.label;
    const detail = option.detail ? `  ${dim(option.detail)}` : "";
    return `  ${pointer} ${i + 1}. ${label}${detail}`;
  });
  const lines = [title, ...rows, dim("  arrows/jk move - enter select - q cancel")];
  return lines.map((line) => clipLine(line, width));
}

/**
 * @param {object} args
 * @param {string} args.title
 * @param {Array<{label: string, detail?: string}>} args.options
 * @param {number} [args.defaultIndex]
 * @param {NodeJS.ReadStream} [args.stdin]
 * @param {NodeJS.WriteStream} [args.stdout]
 * @returns {Promise<number|null>} selected index, or null when cancelled
 */
export function selectFrom({ title, options, defaultIndex = 0, stdin = process.stdin, stdout = process.stdout }) {
  requireTty(stdin);
  return new Promise((resolve) => {
    let index = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    let renderedLines = 0;
    let pending = "";
    let escTimer = null;
    let done = false;

    function render() {
      // Up over exactly the lines the previous frame drew, back to column 1,
      // and clear to the end of the screen. This is only sound because every
      // frame line is clipped to the terminal width: renderFrame guarantees a
      // logical line is one physical line, so the count cannot drift.
      if (renderedLines > 0) stdout.write(`\u001b[${renderedLines}A\u001b[G\u001b[J`);
      const lines = renderFrame({
        title,
        options,
        index,
        width: stdout.columns || 80,
        height: stdout.rows || 24,
      });
      stdout.write(lines.join("\n") + "\n");
      renderedLines = lines.length;
    }

    function finish(result) {
      if (done) return;
      done = true;
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      resolve(result);
    }

    function handleKey(key) {
      if (key.name === "\u0003" || key.name === "q" || key.name === "escape") return finish(null); // ctrl-c / q / esc
      if (key.name === "\r" || key.name === "\n") return finish(index);
      if (key.name === "up" || key.name === "k") index = (index - 1 + options.length) % options.length;
      else if (key.name === "down" || key.name === "j") index = (index + 1) % options.length;
      else if (/^[1-9]$/.test(key.name)) {
        const n = Number.parseInt(key.name, 10) - 1;
        if (n < options.length) { index = n; render(); return finish(index); }
        return;
      } else return;
      render();
    }

    function onData(chunk) {
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      const parsed = parseKeys(pending + chunk.toString("utf8"));
      pending = parsed.pending;
      for (const key of parsed.keys) {
        handleKey(key);
        if (done) return;
      }
      if (pending === "\u001b") {
        escTimer = setTimeout(() => {
          escTimer = null;
          pending = "";
          handleKey({ name: "escape", sequence: "\u001b" });
        }, ESC_GRACE_MS);
        escTimer.unref?.();
      }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

/** y/n question; returns the default on empty input. */
export function confirm(prompt, { def = false } = {}) {
  requireTty();
  const suffix = def ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} ${dim(suffix)} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(def);
      resolve(a === "y" || a === "yes");
    });
  });
}

/** Free-text question; returns the trimmed answer ("" when empty). */
export function question(prompt) {
  requireTty();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
