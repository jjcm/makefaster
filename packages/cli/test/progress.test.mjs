import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent, createProgressReporter, describeEvent } from "../lib/progress.js";

test("claude/cursor stream-json events collapse into a loop step and a label", () => {
  assert.deepEqual(classifyEvent("claude-stream-json", { type: "system", subtype: "init" }), { tag: "OBSERVE", text: "session started" });
  assert.deepEqual(
    classifyEvent("claude-stream-json", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/css/app.css" } }] },
    }),
    { tag: "EXECUTE", text: "editing app.css" },
  );
  assert.deepEqual(
    classifyEvent("cursor-stream-json", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/index.html" } }] },
    }),
    { tag: "OBSERVE", text: "reading index.html" },
  );
  assert.deepEqual(
    classifyEvent("claude-stream-json", { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
    { tag: "HYPOTHESIS", text: "thinking" },
  );
  assert.deepEqual(
    classifyEvent("claude-stream-json", { type: "result", subtype: "success", num_turns: 7 }),
    { tag: "RESULT", text: "agent finished after 7 turns" },
  );
  assert.equal(classifyEvent("claude-stream-json", { type: "result", is_error: true }).tag, "RESULT");
});

test("a measuring command is the TEST step; any other command is EXECUTE", () => {
  const command = (text) => classifyEvent("cursor-stream-json", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: text } }] },
  });
  assert.deepEqual(command("npx lighthouse http://localhost:8000"), { tag: "TEST", text: "running npx lighthouse http://localhost:8000" });
  assert.equal(command("node bench/profile.mjs").tag, "TEST");
  assert.equal(command("npm test").tag, "TEST");
  assert.equal(command("git checkout -- index.html").tag, "EXECUTE");
  assert.equal(command("npm run build").tag, "EXECUTE");
});

test("codex JSONL events classify the same way, old and new envelopes", () => {
  assert.deepEqual(
    classifyEvent("codex-jsonl", { type: "item.completed", item: { item_type: "command_execution", command: "npm run build" } }),
    { tag: "EXECUTE", text: "running npm run build" },
  );
  assert.deepEqual(
    classifyEvent("codex-jsonl", { type: "item.completed", item: { item_type: "command_execution", command: "lighthouse http://localhost:8000" } }),
    { tag: "TEST", text: "running lighthouse http://localhost:8000" },
  );
  assert.deepEqual(
    classifyEvent("codex-jsonl", { type: "item.completed", item: { item_type: "file_change", changes: { "/repo/index.html": {} } } }),
    { tag: "EXECUTE", text: "editing index.html" },
  );
  assert.deepEqual(classifyEvent("codex-jsonl", { msg: { type: "exec_command_begin", command: ["node", "bench.js"] } }), { tag: "TEST", text: "running node bench.js" });
  assert.deepEqual(classifyEvent("codex-jsonl", { msg: { type: "agent_reasoning", text: "..." } }), { tag: "HYPOTHESIS", text: "thinking" });
  assert.deepEqual(classifyEvent("codex-jsonl", { msg: { type: "task_complete" } }), { tag: "RESULT", text: "agent finished" });
});

test("unrecognised events are ignored rather than rendered as noise", () => {
  assert.equal(classifyEvent("claude-stream-json", { type: "some_future_event" }), null);
  assert.equal(classifyEvent("codex-jsonl", { type: "some_future_event" }), null);
  assert.equal(classifyEvent("claude-stream-json", null), null);
  assert.equal(classifyEvent("claude-stream-json", "not an object"), null);
  assert.equal(describeEvent("claude-stream-json", { type: "some_future_event" }), null);
});

test("describeEvent is the label alone, for the plain non-TTY line", () => {
  assert.equal(describeEvent("claude-stream-json", { type: "system", subtype: "init" }), "session started");
  assert.equal(
    describeEvent("claude-stream-json", { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { path: "a/b.css" } }] } }),
    "editing b.css",
  );
});

test("long labels are trimmed so the status line stays one row", () => {
  const { text } = classifyEvent("claude-stream-json", {
    type: "assistant",
    message: { content: [{ type: "text", text: "x".repeat(400) }] },
  });
  assert.ok(text.length <= 68, text.length);
  assert.ok(text.endsWith("…"));
});

test("a TTY reporter rewrites one line; a pipe prints a line per change", () => {
  const tty = [];
  const ttyReporter = createProgressReporter({ write: (chunk) => tty.push(chunk), isTty: true });
  ttyReporter.update({ tag: "OBSERVE", text: "session started" });
  ttyReporter.update({ tag: "OBSERVE", text: "session started" }); // repeat: nothing new to show
  ttyReporter.update({ tag: "EXECUTE", text: "editing index.html" });
  ttyReporter.done();
  assert.equal(ttyReporter.eventCount, 3);
  assert.equal(ttyReporter.lastLabel, "editing index.html");
  assert.equal(tty.length, 3);
  for (const chunk of tty) assert.ok(chunk.startsWith("\r\u001b[2K"), chunk);
  assert.ok(tty.every((chunk) => !chunk.includes("\n")), "the TTY status line never adds rows");

  const piped = [];
  const pipedReporter = createProgressReporter({ write: (chunk) => piped.push(chunk), isTty: false });
  pipedReporter.update({ tag: "OBSERVE", text: "session started" });
  pipedReporter.update({ tag: "OBSERVE", text: "session started" });
  pipedReporter.update({ tag: "EXECUTE", text: "editing index.html" });
  pipedReporter.done();
  assert.deepEqual(piped, ["  session started\n", "  editing index.html\n"]);
});

test("null entries leave the current line alone but still count the event", () => {
  const chunks = [];
  const reporter = createProgressReporter({ write: (chunk) => chunks.push(chunk), isTty: false });
  reporter.update({ tag: "HYPOTHESIS", text: "thinking" });
  reporter.update(null);
  reporter.update("a bare string still works");
  assert.equal(reporter.eventCount, 3);
  assert.deepEqual(chunks, ["  thinking\n", "  a bare string still works\n"]);
});
