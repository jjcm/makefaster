import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTui, tuiSupported } from "../lib/tui.js";
import { niceMax } from "../lib/dashboard.js";

function fakeStreams({ columns = 100, rows = 40 } = {}) {
  const written = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns, rows, isTTY: true,
    write: (chunk) => { written.push(chunk); return true; },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false,
    rawModeCalls: [],
    setRawMode(value) { this.isRaw = value; this.rawModeCalls.push(value); },
    resume() { this.resumed = true; },
    pause() { this.paused = true; },
  });
  return { stdout, stdin, written, all: () => written.join("") };
}

test("tuiSupported needs both directions to be a usable TTY", () => {
  const { stdout, stdin } = fakeStreams();
  assert.equal(tuiSupported({ stdout, stdin, env: {} }), true);
  assert.equal(tuiSupported({ stdout: { ...stdout, isTTY: false }, stdin, env: {} }), false);
  assert.equal(tuiSupported({ stdout, stdin: { ...stdin, isTTY: false }, env: {} }), false);
  assert.equal(tuiSupported({ stdout, stdin, env: { TERM: "dumb" } }), false);
  assert.equal(tuiSupported({ stdout, stdin, env: { MAKEFASTER_NO_TUI: "1" } }), false);
});

test("start enters the alternate screen and stop gives the terminal back", () => {
  const { stdout, stdin, all } = fakeStreams();
  const tui = createTui({ stdout, stdin });
  const exitListenersBefore = process.listenerCount("exit");

  tui.start();
  assert.ok(all().includes("\u001b[?1049h"), "must enter the alternate screen");
  assert.ok(all().includes("\u001b[?25l"), "must hide the cursor");
  assert.deepEqual(stdin.rawModeCalls, [true]);
  assert.equal(tui.running, true);
  assert.ok(process.listenerCount("exit") > exitListenersBefore, "must arm an exit guard");

  tui.stop();
  assert.ok(all().includes("\u001b[?25h"), "must show the cursor again");
  assert.ok(all().includes("\u001b[?1049l"), "must leave the alternate screen");
  assert.deepEqual(stdin.rawModeCalls, [true, false], "raw mode must be restored");
  assert.equal(stdin.paused, true);
  assert.equal(tui.running, false);
  assert.equal(process.listenerCount("exit"), exitListenersBefore, "listeners must be released");
  // Idempotent: a second stop (e.g. from the exit guard) must not write again.
  const before = all().length;
  tui.stop();
  assert.equal(all().length, before);
});

test("q, Esc and Ctrl-C all quit; other keys do not", () => {
  const { stdout, stdin } = fakeStreams();
  let quits = 0;
  const tui = createTui({ stdout, stdin, onQuit: () => { quits += 1; } });
  tui.start();
  for (const key of ["q", "Q", "\u0003", "\u001b"]) stdin.emit("data", Buffer.from(key));
  assert.equal(quits, 4);
  stdin.emit("data", Buffer.from("x"));
  stdin.emit("data", Buffer.from("\r"));
  assert.equal(quits, 4);
  tui.stop();
});

test("render draws the full frame and nothing before start or after stop", () => {
  const { stdout, stdin, written, all } = fakeStreams({ columns: 100, rows: 40 });
  const tui = createTui({ stdout, stdin });

  tui.render({ results: null, log: [] });
  assert.equal(written.length, 0, "render before start must be a no-op");

  tui.start();
  written.length = 0;
  tui.render({ results: null, log: [], status: "RUNNING" });
  const frame = written.join("");
  assert.ok(frame.startsWith("\u001b[H"), "each frame homes the cursor instead of scrolling");
  assert.ok(frame.endsWith("\u001b[J"), "each frame clears anything left below");
  assert.equal(frame.replace(/\u001b\[[0-9;]*m/g, "").split("\n").length, 40, "one line per terminal row");
  assert.match(frame, /AUTORESEARCH/);

  tui.stop();
  written.length = 0;
  tui.render({ results: null, log: [] });
  assert.equal(written.length, 0, "render after stop must be a no-op");
});

test("a resize repaints at the new size instead of reusing the old layout", () => {
  const { stdout, stdin, written } = fakeStreams({ columns: 100, rows: 40 });
  const tui = createTui({ stdout, stdin });
  tui.start();
  tui.render({ results: null, log: [] });

  stdout.columns = 60;
  stdout.rows = 20;
  written.length = 0;
  stdout.emit("resize");

  const frame = written.join("").replace(/\u001b\[[0-9;]*m/g, "");
  const lines = frame.replace("\u001b[H", "").split("\n");
  assert.equal(lines.length, 20, "the frame follows the new row count");
  assert.equal(tui.size().columns, 60);
  tui.stop();
});

test("niceMax rounds an axis maximum up to a readable step", () => {
  assert.equal(niceMax(2420), 2500);
  assert.equal(niceMax(1680), 2000);
  assert.equal(niceMax(940), 1000);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
  for (const value of [1, 7, 99, 101, 3333, 87654]) assert.ok(niceMax(value) >= value, value);
});
