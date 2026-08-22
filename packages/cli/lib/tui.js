/**
 * A minimal alternate-screen renderer — raw ANSI, no dependencies.
 *
 * This is makefaster's own full-screen view. The agent CLI it drives stays
 * hidden behind piped stdio (see lib/invoke.js); nothing here ever hands the
 * terminal to another product's interface.
 *
 * Terminal state is borrowed, so it is always given back: leaving the alternate
 * screen and showing the cursor happens on stop(), on `q`/Ctrl-C, and from a
 * process-exit guard, so even a crash cannot leave an invisible cursor behind.
 */

import { PANEL_BACKGROUND, buildDashboard } from "./dashboard.js";
import { renderRow } from "./theme.js";

const ENTER_ALT = "\u001b[?1049h";
const LEAVE_ALT = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CURSOR_HOME = "\u001b[H";
const CLEAR_BELOW = "\u001b[J";

const MIN_FRAME_INTERVAL_MS = 80;

/** True only when both directions are a terminal we can take over safely. */
export function tuiSupported({ stdout = process.stdout, stdin = process.stdin, env = process.env } = {}) {
  if (env.MAKEFASTER_NO_TUI) return false;
  if (env.TERM === "dumb") return false;
  return Boolean(stdout.isTTY && stdin.isTTY && typeof stdin.setRawMode === "function");
}

/**
 * @param {object} [options]
 * @param {NodeJS.WriteStream} [options.stdout]
 * @param {NodeJS.ReadStream} [options.stdin]
 * @param {() => void} [options.onQuit] called on q / Ctrl-C / Esc
 */
export function createTui({ stdout = process.stdout, stdin = process.stdin, onQuit = () => {} } = {}) {
  let running = false;
  let lastFrameAt = 0;
  let pendingModel = null;
  let scheduled = null;
  let previousRawMode = false;

  const size = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });

  const onData = (chunk) => {
    const key = chunk.toString("utf8");
    if (key === "q" || key === "Q" || key === "\u0003" || key === "\u001b") onQuit();
  };
  const onResize = () => paint(pendingModel, { force: true });
  const restore = () => {
    if (!running) return;
    running = false;
    stdin.removeListener("data", onData);
    stdout.removeListener?.("resize", onResize);
    process.removeListener("SIGWINCH", onResize);
    process.removeListener("exit", restore);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(previousRawMode);
    stdin.pause();
    stdout.write(`${SHOW_CURSOR}${LEAVE_ALT}`);
  };

  function paint(model, { force = false } = {}) {
    if (!running || model === null) return;
    pendingModel = model;
    const now = Date.now();
    if (!force && now - lastFrameAt < MIN_FRAME_INTERVAL_MS) {
      // Coalesce bursts of events into one frame rather than tearing.
      if (scheduled === null) {
        scheduled = setTimeout(() => {
          scheduled = null;
          paint(pendingModel, { force: true });
        }, MIN_FRAME_INTERVAL_MS - (now - lastFrameAt));
        scheduled.unref?.();
      }
      return;
    }
    if (scheduled !== null) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    lastFrameAt = now;
    const dimensions = size();
    const rows = buildDashboard({ ...model, size: dimensions });
    const frame = rows
      .map((row) => renderRow(row, { width: dimensions.columns, background: PANEL_BACKGROUND }))
      .join("\n");
    stdout.write(`${CURSOR_HOME}${frame}${CLEAR_BELOW}`);
  }

  return {
    get running() {
      return running;
    },
    size,
    start() {
      if (running) return;
      running = true;
      previousRawMode = Boolean(stdin.isRaw);
      stdout.write(`${ENTER_ALT}${HIDE_CURSOR}${CURSOR_HOME}${CLEAR_BELOW}`);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      // Both, because only some platforms emit one of them.
      stdout.on?.("resize", onResize);
      process.on("SIGWINCH", onResize);
      process.on("exit", restore);
    },
    render(model) {
      paint(model);
    },
    stop: restore,
  };
}
