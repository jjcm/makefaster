/**
 * Interactive terminal prompts over raw readline — no dependencies.
 *   selectFrom  — arrow-key (or j/k, or 1-9) list picker
 *   confirm     — y/n question
 *   question    — free-text question
 * Non-TTY stdin throws { code: "NO_TTY" } so callers can degrade explicitly.
 */

import readline from "node:readline";
import { bold, cyan, dim } from "./ui.js";

function requireTty() {
  if (!process.stdin.isTTY) {
    throw Object.assign(new Error("interactive prompt needs a TTY"), { code: "NO_TTY" });
  }
}

/**
 * @param {object} args
 * @param {string} args.title
 * @param {Array<{label: string, detail?: string}>} args.options
 * @param {number} [args.defaultIndex]
 * @returns {Promise<number|null>} selected index, or null when cancelled
 */
export function selectFrom({ title, options, defaultIndex = 0 }) {
  requireTty();
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let index = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    let renderedLines = 0;

    function render() {
      if (renderedLines > 0) {
        stdout.write(`\u001b[${renderedLines}A\u001b[J`);
      }
      const lines = [title, ...options.map((option, i) => {
        const pointer = i === index ? cyan(">") : " ";
        const label = i === index ? bold(option.label) : option.label;
        const detail = option.detail ? `  ${dim(option.detail)}` : "";
        return `  ${pointer} ${i + 1}. ${label}${detail}`;
      }), dim("  arrows/jk move - enter select - q cancel")];
      stdout.write(lines.join("\n") + "\n");
      renderedLines = lines.length;
    }

    function finish(result) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      resolve(result);
    }

    function onData(chunk) {
      const key = chunk.toString("utf8");
      if (key === "\u0003" || key === "q" || key === "\u001b") return finish(null); // ctrl-c / q / esc
      if (key === "\r" || key === "\n") return finish(index);
      if (key === "\u001b[A" || key === "k") index = (index - 1 + options.length) % options.length;
      else if (key === "\u001b[B" || key === "j") index = (index + 1) % options.length;
      else if (/^[1-9]$/.test(key)) {
        const n = Number.parseInt(key, 10) - 1;
        if (n < options.length) { index = n; render(); return finish(index); }
      }
      render();
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
