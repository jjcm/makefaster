import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopView } from "../lib/loopView.js";
import { watchResults } from "../lib/resultsWatch.js";

function session() {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-loopview-"));
  const path = join(dir, "results.json");
  return { dir, path, write: (value) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)) };
}

function harness(session) {
  const frames = [];
  const tui = { render: (model) => frames.push(model) };
  const view = createLoopView({
    tui,
    paths: { results: session.path },
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

test("the reporter turns stream events into tagged log lines and repaints", () => {
  const paths = session();
  const { view, frames, last } = harness(paths);
  const before = frames.length;

  view.reporter.update({ tag: "EXECUTE", text: "editing index.html" });
  view.reporter.update({ tag: "TEST", text: "running npx lighthouse" });
  view.reporter.update({ tag: "TEST", text: "running npx lighthouse" }); // repeat collapses
  view.reporter.update(null); // unrecognised event: counted, not logged

  assert.deepEqual(view.log.map((entry) => [entry.tag, entry.text]), [
    ["EXECUTE", "editing index.html"],
    ["TEST", "running npx lighthouse"],
  ]);
  assert.equal(view.reporter.eventCount, 4);
  assert.equal(view.reporter.lastLabel, "running npx lighthouse");
  assert.ok(frames.length > before, "each logged line repaints");
  assert.equal(last().provider.displayName, "Cursor Agent");
  assert.equal(last().model.id, "claude-fable-5-max");
  view.stop();
});

test("every log line carries a clock time", () => {
  const paths = session();
  const { view } = harness(paths);
  view.reporter.update({ tag: "OBSERVE", text: "session started" });
  assert.match(view.log[0].time, /^\d{2}:\d{2}:\d{2}$/);
  view.stop();
});

test("a new results.json iteration produces the RESULT and COMPARE lines", () => {
  const paths = session();
  paths.write({ version: 1, northStar: "lcp", baseline: { cold: { lcpMs: 2420, ttiMs: 3900 } }, iterations: [] });
  const { view, last } = harness(paths);

  // The baseline is announced from the file, not from the agent's stream.
  assert.deepEqual(view.log.map((e) => e.tag), ["OBSERVE"]);
  assert.match(view.log[0].text, /baseline measured \(cold\): LCP 2420ms/);

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
    ["OBSERVE", "baseline measured (cold): LCP 2420ms"],
    ["HYPOTHESIS", "Inline critical CSS"],
    ["PLAN", "Inlined above-the-fold styles"],
    ["RESULT", "measured -140ms / -5.8% on lcp"],
    ["COMPARE", "beat the noise floor — kept, new best candidate"],
    ["HYPOTHESIS", "Preload thumbnails"],
    ["RESULT", "measured +150ms / +6.6% on lcp"],
    ["COMPARE", "did not beat the noise floor — reverted"],
  ]);
  assert.equal(last().results.iterations.length, 2);
  assert.match(last().updatedAt, /^\d{2}:\d{2}:\d{2}$/);

  // Re-reading the same file must not duplicate the lines.
  const count = view.log.length;
  view.flush();
  assert.equal(view.log.length, count);
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
  for (let i = 0; i < 1200; i++) view.reporter.update({ tag: "EXECUTE", text: `step ${i}` });
  assert.ok(view.log.length <= 500, view.log.length);
  assert.equal(view.log.at(-1).text, "step 1199");
  view.stop();
});
