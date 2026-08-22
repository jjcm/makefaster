import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressReporter, describeEvent } from "../lib/progress.js";

test("claude/cursor stream-json events collapse into short labels", () => {
  assert.equal(describeEvent("claude-stream-json", { type: "system", subtype: "init" }), "session started");
  assert.equal(
    describeEvent("claude-stream-json", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/css/app.css" } }] },
    }),
    "editing app.css",
  );
  assert.equal(
    describeEvent("cursor-stream-json", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npx lighthouse http://localhost:8000" } }] },
    }),
    "running npx lighthouse http://localhost:8000",
  );
  assert.equal(
    describeEvent("claude-stream-json", { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
    "thinking",
  );
  assert.equal(describeEvent("claude-stream-json", { type: "result", subtype: "success", num_turns: 7 }), "agent finished after 7 turns");
  assert.match(describeEvent("claude-stream-json", { type: "result", is_error: true }), /reported an error/);
});

test("codex JSONL events collapse into short labels, old and new envelopes", () => {
  assert.equal(
    describeEvent("codex-jsonl", { type: "item.completed", item: { item_type: "command_execution", command: "npm test" } }),
    "running npm test",
  );
  assert.equal(
    describeEvent("codex-jsonl", { type: "item.completed", item: { item_type: "file_change", changes: { "/repo/index.html": {} } } }),
    "editing index.html",
  );
  assert.equal(describeEvent("codex-jsonl", { msg: { type: "exec_command_begin", command: ["node", "bench.js"] } }), "running node bench.js");
  assert.equal(describeEvent("codex-jsonl", { msg: { type: "agent_reasoning", text: "..." } }), "thinking");
  assert.equal(describeEvent("codex-jsonl", { msg: { type: "task_complete" } }), "agent finished");
});

test("unrecognised events are ignored rather than rendered as noise", () => {
  assert.equal(describeEvent("claude-stream-json", { type: "some_future_event" }), null);
  assert.equal(describeEvent("codex-jsonl", { type: "some_future_event" }), null);
  assert.equal(describeEvent("claude-stream-json", null), null);
  assert.equal(describeEvent("claude-stream-json", "not an object"), null);
});

test("long labels are trimmed so the status line stays one row", () => {
  const label = describeEvent("claude-stream-json", {
    type: "assistant",
    message: { content: [{ type: "text", text: "x".repeat(400) }] },
  });
  assert.ok(label.length <= 68, label.length);
  assert.ok(label.endsWith("…"));
});

test("a TTY reporter rewrites one line; a pipe prints a line per change", () => {
  const tty = [];
  const ttyReporter = createProgressReporter({ write: (chunk) => tty.push(chunk), isTty: true });
  ttyReporter.update("session started");
  ttyReporter.update("session started"); // repeat: nothing new to show
  ttyReporter.update("editing index.html");
  ttyReporter.done();
  assert.equal(ttyReporter.eventCount, 3);
  assert.equal(ttyReporter.lastLabel, "editing index.html");
  assert.equal(tty.length, 3);
  for (const chunk of tty) assert.ok(chunk.startsWith("\r\u001b[2K"), chunk);
  assert.ok(tty.every((chunk) => !chunk.includes("\n")), "the TTY status line never adds rows");

  const piped = [];
  const pipedReporter = createProgressReporter({ write: (chunk) => piped.push(chunk), isTty: false });
  pipedReporter.update("session started");
  pipedReporter.update("session started");
  pipedReporter.update("editing index.html");
  pipedReporter.done();
  assert.deepEqual(piped, ["  session started\n", "  editing index.html\n"]);
});

test("null labels leave the current line alone but still count the event", () => {
  const chunks = [];
  const reporter = createProgressReporter({ write: (chunk) => chunks.push(chunk), isTty: false });
  reporter.update("thinking");
  reporter.update(null);
  assert.equal(reporter.eventCount, 2);
  assert.deepEqual(chunks, ["  thinking\n"]);
});
