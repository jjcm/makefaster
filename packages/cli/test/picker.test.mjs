import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { clipLine, parseKeys, renderFrame, selectFrom, visibleLength } from "../lib/picker.js";
import { modelPickerOptions, modelsForProvider } from "../lib/models.js";

const stripStyles = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A minimal terminal emulator — glyph grid, deferred autowrap, and the control
 * sequences the picker uses (cursor up, column 1, clear below; styles are
 * dropped). It exists so a test can see exactly what a real terminal would
 * show, including the wrapped ghost lines the old renderer left behind.
 */
function createScreen({ columns }) {
  const cells = [[]];
  let row = 0;
  let col = 0;
  let wraps = 0;
  const ensure = (r) => { while (cells.length <= r) cells.push([]); };
  return {
    get wraps() { return wraps; },
    write(text) {
      const tokens = String(text).match(/\u001b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? [];
      for (const token of tokens) {
        if (token[0] === "\u001b") {
          const match = /^\u001b\[([0-9;]*)([A-Za-z~])$/.exec(token);
          if (!match) continue;
          const [, params, final] = match;
          if (final === "A") row = Math.max(0, row - Number(params || "1"));
          else if (final === "G") col = 0;
          else if (final === "J") {
            ensure(row);
            cells[row] = cells[row].slice(0, col);
            cells.length = row + 1;
          }
          // "m" (styles) and anything else are invisible to the glyph grid.
          continue;
        }
        if (token === "\n") { row += 1; col = 0; ensure(row); continue; }
        if (token === "\r") { col = 0; continue; }
        if (col >= columns) { wraps += 1; row += 1; col = 0; } // deferred autowrap
        ensure(row);
        cells[row][col] = token;
        col += 1;
      }
    },
    text() {
      return cells.map((line) => Array.from(line, (ch) => ch ?? " ").join("")).join("\n");
    },
  };
}

function fakeTerminal({ columns = 80, rows = 24 } = {}) {
  const screen = createScreen({ columns });
  const stdout = { columns, rows, isTTY: true, write: (chunk) => { screen.write(chunk); return true; } };
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value) { this.isRaw = value; },
    resume() {},
    pause() {},
  });
  const press = (...sequences) => { for (const s of sequences) stdin.emit("data", Buffer.from(s)); };
  return { stdin, stdout, screen, press };
}

const OPTIONS = [{ label: "Alpha" }, { label: "Bravo" }, { label: "Charlie" }];

// ---------------------------------------------------------------------------
// (a) model picker rows render as name-only
// ---------------------------------------------------------------------------

test("model picker rows are the model name and nothing else", () => {
  const models = modelsForProvider("cursor");
  const options = modelPickerOptions(models);
  assert.deepEqual(options, models.map((model) => ({ label: model.label })));
  assert.equal(options[0].label, "Claude Fable 5 (thinking)");
  assert.ok(options.every((option) => option.detail === undefined), "no detail line may ride along");

  const lines = renderFrame({ title: "  most intelligent first", options, index: 0, width: 120, height: 24 })
    .map(stripStyles);
  assert.equal(lines[1], "  > 1. Claude Fable 5 (thinking)");
  assert.equal(lines[3], "    3. GPT-5.6 Terra");
  for (const line of lines) {
    assert.doesNotMatch(line, /gpt-5\.6-terra-medium|thinking-medium/, "no model id slug in a row");
    assert.doesNotMatch(line, /CursorBench/, "no benchmark score in a row");
    assert.doesNotMatch(line, /best for/, "no 'best for …' copy in a row");
    assert.doesNotMatch(line, /not in the .* snapshot/, "no unscored-model blurb in a row");
  }
});

// ---------------------------------------------------------------------------
// (b) overflow: no wrapping, no paint residue
// ---------------------------------------------------------------------------

test("clipLine keeps short lines, ellipsizes long ones, and never counts styles", () => {
  assert.equal(clipLine("plain", 10), "plain");
  assert.equal(clipLine("exactly-10", 10), "exactly-10");
  assert.equal(clipLine("longer than ten", 10), "longer th…");
  // Styled text: the escape codes are free, the cut resets the style.
  const styled = "\u001b[1mBold Name\u001b[0m and trailing text";
  assert.equal(visibleLength(styled), "Bold Name and trailing text".length);
  const clipped = clipLine(styled, 12);
  assert.equal(stripStyles(clipped), "Bold Name a…");
  assert.ok(clipped.endsWith("\u001b[0m"), "a clipped styled line must reset");
});

test("every frame line fits the terminal width, so no row can ever wrap", () => {
  const options = [
    { label: "Claude Fable 5 (thinking), an enormously long label that overflows" },
    { label: "Short" },
  ];
  for (const width of [20, 30, 45]) {
    const lines = renderFrame({ title: "  most intelligent first", options, index: 0, width, height: 24 });
    for (const line of lines) {
      assert.ok(visibleLength(line) <= width, `"${stripStyles(line)}" exceeds ${width} columns`);
      assert.ok(!line.includes("\n"), "a frame line is exactly one physical line");
    }
  }
});

test("moving the selection past an overflowing row leaves no paint residue", async () => {
  const long = "Bravo with an extremely long descriptor that overflows a narrow terminal by a lot";
  const options = [{ label: "Alpha" }, { label: long }, { label: "Charlie" }];
  const { stdin, stdout, screen, press } = fakeTerminal({ columns: 30, rows: 24 });

  const picked = selectFrom({ title: "  pick", options, stdin, stdout });
  press("j"); // onto the overflowing row
  press("j"); // and past it — the old renderer left its wrapped tail here
  const expected = renderFrame({ title: "  pick", options, index: 2, width: 30, height: 24 });
  assert.equal(screen.text(), stripStyles(expected.join("\n")) + "\n", "the screen is exactly the current frame");
  assert.equal(screen.wraps, 0, "no picker row may ever wrap");
  assert.equal((screen.text().match(/>/g) ?? []).length, 1, "exactly one selection pointer survives a repaint");
  assert.ok(!screen.text().includes("overflows a narrow"), "the overflowing tail was clipped, not wrapped");

  press("\r");
  assert.equal(await picked, 2);
});

test("a short terminal windows the list instead of overflowing it", async () => {
  const options = [
    { label: "One" }, { label: "Two" }, { label: "Three" }, { label: "Four" },
    { label: "Five" }, { label: "Six" }, { label: "Seven" },
  ];
  const { stdin, stdout, screen, press } = fakeTerminal({ columns: 40, rows: 5 });
  const picked = selectFrom({ title: "  pick", options, stdin, stdout });

  for (let i = 0; i < 6; i++) press("\u001b[B"); // arrow down to "Seven"
  const lines = screen.text().replace(/\n$/, "").split("\n");
  assert.ok(lines.length <= 5, `the frame must fit 5 rows, got ${lines.length}`);
  assert.ok(screen.text().includes("> 7. Seven"), "the selection stays visible in the window");

  press("\r");
  assert.equal(await picked, 6);
});

// ---------------------------------------------------------------------------
// (c) arrows and j/k both move the selection — at any terminal size
// ---------------------------------------------------------------------------

test("arrow keys move the selection and wrap around, same as j/k", async () => {
  const arrows = fakeTerminal();
  const byArrows = selectFrom({ title: "t", options: OPTIONS, stdin: arrows.stdin, stdout: arrows.stdout });
  arrows.press("\u001b[B", "\u001b[B", "\u001b[A", "\r"); // down down up
  assert.equal(await byArrows, 1);

  const vi = fakeTerminal();
  const byVi = selectFrom({ title: "t", options: OPTIONS, stdin: vi.stdin, stdout: vi.stdout });
  vi.press("j", "j", "k", "\r");
  assert.equal(await byVi, 1);

  const around = fakeTerminal();
  const wrapped = selectFrom({ title: "t", options: OPTIONS, stdin: around.stdin, stdout: around.stdout });
  around.press("\u001b[A", "\r"); // up from the top wraps to the bottom
  assert.equal(await wrapped, 2);
});

test("arrows work in a tiny terminal too", async () => {
  const { stdin, stdout, press } = fakeTerminal({ columns: 18, rows: 4 });
  const picked = selectFrom({ title: "t", options: OPTIONS, stdin, stdout });
  press("\u001b[B", "\u001b[B", "\r");
  assert.equal(await picked, 2);
});

test("an arrow sequence split across reads still moves — it must not cancel", async () => {
  const { stdin, stdout, press } = fakeTerminal();
  const picked = selectFrom({ title: "t", options: OPTIONS, stdin, stdout });
  press("\u001b"); // first read ends on the bare ESC byte…
  press("[B");     // …the rest arrives on the next one
  press("\r");
  assert.equal(await picked, 1);
});

test("application-cursor-keys arrows (SS3, \\u001bOA) work as well", async () => {
  const { stdin, stdout, press } = fakeTerminal();
  const picked = selectFrom({ title: "t", options: OPTIONS, stdin, stdout });
  press("\u001bOB", "\u001bOB", "\u001bOA", "\r");
  assert.equal(await picked, 1);
});

test("a lone Escape still cancels once it is clearly not an arrow", async () => {
  const { stdin, stdout, press } = fakeTerminal();
  const picked = selectFrom({ title: "t", options: OPTIONS, stdin, stdout });
  press("\u001b");
  await sleep(80); // past the grace window that disambiguates ESC from ESC-[-A
  assert.equal(await picked, null);
});

test("q cancels, enter selects, digits jump-select", async () => {
  const q = fakeTerminal();
  const cancelled = selectFrom({ title: "t", options: OPTIONS, stdin: q.stdin, stdout: q.stdout });
  q.press("q");
  assert.equal(await cancelled, null);

  const digit = fakeTerminal();
  const jumped = selectFrom({ title: "t", options: OPTIONS, stdin: digit.stdin, stdout: digit.stdout });
  digit.press("3");
  assert.equal(await jumped, 2);

  const plain = fakeTerminal();
  const defaulted = selectFrom({ title: "t", options: OPTIONS, defaultIndex: 1, stdin: plain.stdin, stdout: plain.stdout });
  plain.press("\r");
  assert.equal(await defaulted, 1);
});

test("parseKeys decodes whole, split, and batched sequences", () => {
  assert.deepEqual(parseKeys("\u001b[A"), { keys: [{ name: "up", sequence: "\u001b[A" }], pending: "" });
  assert.deepEqual(parseKeys("\u001bOB").keys.map((k) => k.name), ["down"]);
  assert.deepEqual(parseKeys("j\u001b[Bk").keys.map((k) => k.name), ["j", "down", "k"]);
  // Incomplete sequences are held for the next read, never misread as ESC.
  assert.deepEqual(parseKeys("\u001b"), { keys: [], pending: "\u001b" });
  assert.deepEqual(parseKeys("\u001b["), { keys: [], pending: "\u001b[" });
  assert.deepEqual(parseKeys("j\u001b[").keys.map((k) => k.name), ["j"]);
  // ESC followed by an ordinary byte is a real Escape press.
  assert.deepEqual(parseKeys("\u001bx").keys.map((k) => k.name), ["escape", "x"]);
});
