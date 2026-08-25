import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEP_TAGS, parseStepLine, watchStepLog } from "../lib/stepLog.js";

function logFile() {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-steplog-"));
  const path = join(dir, "thinking.log");
  return { path, append: (line) => appendFileSync(path, `${line}\n`), write: (text) => writeFileSync(path, text) };
}

test("the tag vocabulary is small and fixed", () => {
  assert.deepEqual(STEP_TAGS, [
    "INITIALIZING", "TEST", "CHECKLIST", "SKIP", "TRY", "RESULT", "EXTRA", "DONE",
  ]);
});

test("watchStepLog reports each new step once", () => {
  const { path, append } = logFile();
  const seen = [];
  append("[INITIALIZING] Prepping project and installing dependencies.");
  const watcher = watchStepLog({ path, onStep: (step) => seen.push(step), intervalMs: 60_000 });
  assert.deepEqual(seen, [{ tag: "INITIALIZING", text: "Prepping project and installing dependencies." }]);

  assert.equal(watcher.poll(), false, "an unchanged file reports nothing");

  append("[TEST] Running lighthouse tests for initial baseline");
  assert.equal(watcher.poll(), true);
  assert.deepEqual(seen.at(-1), { tag: "TEST", text: "Running lighthouse tests for initial baseline" });

  // Only the new line, never the whole file again.
  append("[TRY] Enable Gzip Compression");
  watcher.poll();
  assert.equal(seen.length, 3);
  watcher.stop();
});

// The agent is a text generator writing to a file; the panel has to survive
// whatever else ends up in there.
test("watchStepLog ignores everything that is not one of the documented steps", () => {
  const { path, append } = logFile();
  const seen = [];
  const watcher = watchStepLog({ path, onStep: (step) => seen.push(step), intervalMs: 60_000 });

  append("Read File src/app/page.tsx");
  append("$ bun run build");
  append("  ⏺ Bash(npm run lighthouse)");
  append("[EXECUTE] working");
  append("[OBSERVE] Read File");
  append("[HYPOTHESIS] thinking");
  append("");
  watcher.poll();
  assert.deepEqual(seen, [], "none of that is a reported step");

  append("[SKIP] Enable Brotli Compression — the origin only serves precompressed files.");
  watcher.poll();
  assert.deepEqual(seen, [
    { tag: "SKIP", text: "Enable Brotli Compression — the origin only serves precompressed files." },
  ]);
  watcher.stop();
});

test("watchStepLog waits for the newline before showing a line", () => {
  const { path, write } = logFile();
  const seen = [];
  write("[TEST] Running lighthouse tests for ini");
  const watcher = watchStepLog({ path, onStep: (step) => seen.push(step), intervalMs: 60_000 });
  assert.deepEqual(seen, []);

  write("[TEST] Running lighthouse tests for initial baseline\n");
  watcher.poll();
  assert.deepEqual(seen, [{ tag: "TEST", text: "Running lighthouse tests for initial baseline" }]);
  watcher.stop();
});

test("watchStepLog re-reads a file that was replaced rather than appended to", () => {
  const { path, write } = logFile();
  const seen = [];
  write("[TRY] Reduce Font Payload\n[RESULT] -120ms — kept.\n");
  const watcher = watchStepLog({ path, onStep: (step) => seen.push(step), intervalMs: 60_000 });
  assert.equal(seen.length, 2);

  write("[DONE] Checklist finished.\n");
  watcher.poll();
  assert.deepEqual(seen.at(-1), { tag: "DONE", text: "Checklist finished." });
  watcher.stop();
});

test("watchStepLog waits patiently for a file that does not exist yet", () => {
  const { path } = logFile();
  const seen = [];
  const watcher = watchStepLog({ path: join(path, "nope.log"), onStep: () => seen.push(1), intervalMs: 60_000 });
  assert.equal(watcher.poll(), false);
  assert.deepEqual(seen, []);
  watcher.stop();
});

test("parseStepLine is case-insensitive on the tag and trims the sentence", () => {
  assert.deepEqual(parseStepLine("[extra] 5 follow-ups chosen: a, b, c, d, e."),
    { tag: "EXTRA", text: "5 follow-ups chosen: a, b, c, d, e." });
  assert.deepEqual(parseStepLine("\t[Checklist]   Walking 50 categories in rank order.   "),
    { tag: "CHECKLIST", text: "Walking 50 categories in rank order." });
});
