import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopView } from "../lib/loopView.js";
import { watchResults } from "../lib/resultsWatch.js";
import { parseStepLine } from "../lib/stepLog.js";

function session() {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-loopview-"));
  const path = join(dir, "results.json");
  const steps = join(dir, "thinking.log");
  return {
    dir,
    path,
    steps,
    write: (value) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)),
    report: (line) => appendFileSync(steps, `${line}\n`),
  };
}

function harness(session) {
  const frames = [];
  const tui = { render: (model) => frames.push(model) };
  const view = createLoopView({
    tui,
    paths: { results: session.path, steps: session.steps },
    state: { round: 1 },
    provider: { key: "cursor", displayName: "Cursor Agent" },
    model: { id: "claude-fable-5-max", label: "Claude Fable 5 (max)" },
    now: () => new Date("2026-08-22T10:42:32Z"),
  });
  return { view, frames, last: () => frames[frames.length - 1] };
}

test("watchResults reports a change once and ignores a half-written file", () => {
  const { path, write } = session();
  const seen = [];
  write({ version: 1, northStar: "lcp" });
  const watcher = watchResults({ path, onChange: (results) => seen.push(results), intervalMs: 60_000 });
  assert.equal(seen.length, 1, "the initial read counts as a change");

  assert.equal(watcher.poll(), false, "an unchanged file is not re-reported");

  write('{"version": 1, "iterations": [');
  assert.equal(watcher.poll(), false, "a mid-write file is not an error, just not ready");
  assert.equal(seen.length, 1);

  write({ version: 1, iterations: [{ n: 1, name: "x", deltaMs: -10, kept: true }] });
  assert.equal(watcher.poll(), true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].iterations.length, 1);
  watcher.stop();
});

test("watchResults waits patiently for a file that does not exist yet", () => {
  const { path } = session();
  const seen = [];
  const watcher = watchResults({ path: join(path, "nope.json"), onChange: () => seen.push(1), intervalMs: 60_000 });
  assert.equal(watcher.poll(), false);
  assert.deepEqual(seen, []);
  watcher.stop();
});

// The whole point of the panel: it shows what the agent says it is doing, and
// nothing about how it is doing it. A tool-call transcript is not progress.
test("the agent's protocol stream never reaches the thinking panel", () => {
  const paths = session();
  const { view, last } = harness(paths);

  for (const noise of [
    { tag: "EXECUTE", text: "working" },
    { tag: "EXECUTE", text: "bun run build" },
    { tag: "OBSERVE", text: "Read File" },
    { tag: "HYPOTHESIS", text: "thinking" },
    { tag: "EXECUTE", text: "approved bash" },
    "editing index.html",
    null,
  ]) {
    view.reporter.update(noise);
  }

  assert.deepEqual(view.log, [], "the stream must not put anything in the panel");
  // It is still consumed: the count is the heartbeat, and the last label is what
  // the non-TUI path prints.
  assert.equal(view.reporter.eventCount, 7);
  assert.equal(view.reporter.lastLabel, "editing index.html");

  view.render();
  assert.equal(last().provider.displayName, "Cursor Agent");
  assert.equal(last().model.id, "claude-fable-5-max");
  view.stop();
});

test("a step the agent reports is rendered as one tagged summary", () => {
  const paths = session();
  const { view, frames } = harness(paths);
  const before = frames.length;

  paths.report("[INITIALIZING] Prepping project and installing dependencies.");
  paths.report("[TEST] Running lighthouse tests for initial baseline");
  paths.report("[TEST] Running lighthouse tests for initial baseline"); // repeat collapses
  view.flush();

  assert.deepEqual(view.log.map((entry) => [entry.tag, entry.text]), [
    ["INITIALIZING", "Prepping project and installing dependencies."],
    ["TEST", "Running lighthouse tests for initial baseline"],
  ]);
  assert.ok(frames.length > before, "a reported step repaints");
  view.stop();
});

// The channel is the agent's report, not a second stdout: anything that is not
// one of the documented tags is ignored rather than shown.
test("untagged and unknown-tag lines in the step log are ignored", () => {
  const paths = session();
  const { view } = harness(paths);

  paths.report("Read File src/app/index.tsx");
  paths.report("$ bun run build");
  paths.report("[EXECUTE] working");
  paths.report("[OBSERVE] Read File");
  paths.report("");
  paths.report("[TRY] Enable Gzip Compression");
  view.flush();

  assert.deepEqual(view.log.map((entry) => [entry.tag, entry.text]), [["TRY", "Enable Gzip Compression"]]);
  view.stop();
});

test("a summary written without its newline yet is not shown half-finished", () => {
  const paths = session();
  const { view } = harness(paths);

  writeFileSync(paths.steps, "[TEST] Running lighthouse tests for ini");
  view.flush();
  assert.deepEqual(view.log, []);

  writeFileSync(paths.steps, "[TEST] Running lighthouse tests for initial baseline\n");
  view.flush();
  assert.deepEqual(view.log.map((entry) => entry.text), ["Running lighthouse tests for initial baseline"]);
  view.stop();
});

test("parseStepLine accepts the documented tags and nothing else", () => {
  assert.deepEqual(parseStepLine("[SKIP] Precompress Static Assets — the CDN already does it."),
    { tag: "SKIP", text: "Precompress Static Assets — the CDN already does it." });
  assert.deepEqual(parseStepLine("  [done]  Finished the checklist.  "), { tag: "DONE", text: "Finished the checklist." });
  for (const line of ["[EXECUTE] working", "[OBSERVE] Read File", "[PLAN] planning", "no tag here", "[TEST]", "", "[TEST]   "]) {
    assert.equal(parseStepLine(line), null, line);
  }
  // One line means one line: a pasted wall of text is cut to a summary's length.
  assert.equal(parseStepLine(`[TRY] ${"x".repeat(400)}`).text.length, 200);
});

test("every log line carries a clock time", () => {
  const paths = session();
  const { view } = harness(paths);
  paths.report("[INITIALIZING] Session started.");
  view.flush();
  assert.match(view.log[0].time, /^\d{2}:\d{2}:\d{2}$/);
  view.stop();
});

test("a new results.json iteration produces exactly one RESULT line", () => {
  const paths = session();
  paths.write({ version: 1, northStar: "lcp", baseline: { cold: { lcpMs: 2420, ttiMs: 3900 } }, iterations: [] });
  const { view, last } = harness(paths);

  // The baseline is announced from the file, not from the agent's stream.
  assert.deepEqual(view.log.map((e) => e.tag), ["TEST"]);
  assert.match(view.log[0].text, /Baseline measured \(cold\): LCP 2420ms/);

  paths.write({
    version: 1, northStar: "lcp",
    baseline: { cold: { lcpMs: 2420, ttiMs: 3900 } },
    iterations: [
      { n: 1, name: "Inline critical CSS", description: "Inlined above-the-fold styles", deltaMs: -140, deltaPct: -5.8, kept: true },
      { n: 2, name: "Preload thumbnails", deltaMs: 150, deltaPct: 6.6, kept: false },
    ],
  });
  view.flush();

  assert.deepEqual(view.log.map((e) => [e.tag, e.text]), [
    ["TEST", "Baseline measured (cold): LCP 2420ms"],
    ["RESULT", "Inline critical CSS: -140ms / -5.8% on lcp — kept"],
    ["RESULT", "Preload thumbnails: +150ms / +6.6% on lcp — reverted, did not beat the noise floor"],
  ]);
  assert.equal(last().results.iterations.length, 2);
  assert.match(last().updatedAt, /^\d{2}:\d{2}:\d{2}$/);

  // Re-reading the same file must not duplicate the lines.
  const count = view.log.length;
  view.flush();
  assert.equal(view.log.length, count);
  view.stop();
});

// `Unnamed experiment: no delta recorded — reverted` was the panel reporting a
// miss the agent never measured, off a row it had not filled in yet.
test("a row with no numbers on it is not reported as a result", () => {
  const paths = session();
  paths.write({ version: 1, northStar: "lcp", baseline: { warm: { lcpMs: 4658 } }, iterations: [] });
  const { view } = harness(paths);

  paths.write({
    version: 1, northStar: "lcp",
    baseline: { warm: { lcpMs: 4658 } },
    iterations: [{ kept: true }],
  });
  view.flush();
  assert.deepEqual(view.log.filter((e) => e.tag === "RESULT"), []);

  // The same row, once the measurement lands, is a result — announced once.
  paths.write({
    version: 1, northStar: "lcp",
    baseline: { warm: { lcpMs: 4658 } },
    iterations: [{ n: 1, name: "Defer non-critical scripts", deltaMs: -1050, deltaPct: -22.5, kept: true }],
  });
  view.flush();
  view.flush();
  assert.deepEqual(view.log.filter((e) => e.tag === "RESULT").map((e) => e.text), [
    "Defer non-critical scripts: -1050ms / -22.5% on lcp — kept",
  ]);
  view.stop();
});

test("an iteration that reports only where it landed still gets its RESULT line", () => {
  const paths = session();
  paths.write({
    version: 1, northStar: "lcp",
    baseline: { warm: { lcpMs: 4658 } },
    iterations: [{ n: 1, name: "Defer non-critical scripts", kept: true, measured: { warm: { lcpMs: 3608 } } }],
  });
  const { view } = harness(paths);

  assert.deepEqual(view.log.filter((e) => e.tag === "RESULT").map((e) => e.text), [
    "Defer non-critical scripts: -1050ms / -22.5% on lcp — kept",
  ]);
  view.stop();
});

test("setStatus is reflected in the next frame", () => {
  const paths = session();
  const { view, last } = harness(paths);
  view.setStatus("DONE");
  assert.equal(last().status, "DONE");
  view.stop();
});

test("the log is bounded so a long session cannot grow without limit", () => {
  const paths = session();
  const { view } = harness(paths);
  for (let i = 0; i < 1200; i++) view.append("TRY", `step ${i}`);
  assert.ok(view.log.length <= 500, view.log.length);
  assert.equal(view.log.at(-1).text, "step 1199");
  view.stop();
});
