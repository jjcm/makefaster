import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BLOCKS,
  MAX_BLOCK_CHARS,
  openThinkingTrace,
  readThinkingTrace,
  resetThinkingTrace,
  thinkingTextOf,
  withThinkingTrace,
} from "../lib/thinkingTrace.js";

function tracePath() {
  return join(mkdtempSync(join(tmpdir(), "makefaster-trace-")), "thinking-trace.jsonl");
}

/** A reporter of the shape the agent modules are given. */
function fakeReporter() {
  const entries = [];
  return {
    entries,
    eventCount: 0,
    lastLabel: null,
    update(entry) {
      entries.push(entry);
    },
    done() {
      entries.push("done");
    },
  };
}

test("thinkingTextOf reads reasoning out of every provider's stream", () => {
  assert.equal(
    thinkingTextOf("acp", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the LCP element is the hero" } }),
    "the LCP element is the hero",
  );
  assert.equal(
    thinkingTextOf("claude-stream-json", {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "font swap is not the problem" }] },
    }),
    "font swap is not the problem",
  );
  assert.equal(
    thinkingTextOf("codex-app-server", { method: "item/reasoning/delta", params: { delta: "preload " } }),
    "preload ",
  );
  assert.equal(
    thinkingTextOf("codex-app-server", { method: "item/completed", params: { item: { type: "reasoning", text: "preload the hero" } } }),
    "preload the hero",
  );
  assert.equal(
    thinkingTextOf("codex-jsonl", { msg: { type: "agent_reasoning", text: "measure before keeping" } }),
    "measure before keeping",
  );
  assert.equal(
    thinkingTextOf("openai-message", { role: "assistant", reasoning: "walk the checklist in order" }),
    "walk the checklist in order",
  );
  assert.equal(
    thinkingTextOf("openai-message", { role: "assistant", reasoning_details: [{ text: "one" }, { text: " two" }] }),
    "one two",
  );
});

test("thinkingTextOf never reads a tool call, a tool result, or plain assistant prose", () => {
  const notThoughts = [
    ["acp", { sessionUpdate: "tool_call", kind: "execute", rawInput: { command: "yarn build" } }],
    ["acp", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I ran the build" } }],
    ["claude-stream-json", { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "yarn build" } }] } }],
    ["claude-stream-json", { type: "assistant", message: { content: [{ type: "text", text: "here is the plan" }] } }],
    // Encrypted reasoning is not ours to unwrap, so it is left alone.
    ["claude-stream-json", { type: "assistant", message: { content: [{ type: "redacted_thinking", data: "AAAA" }] } }],
    ["claude-stream-json", { type: "user", message: { content: [{ type: "tool_result", content: "1200 lines of output" }] } }],
    ["codex-app-server", { method: "item/completed", params: { item: { type: "commandExecution", command: "yarn build" } } }],
    ["codex-jsonl", { msg: { type: "exec_command_begin", command: ["yarn", "build"] } }],
    ["openai-message", { role: "assistant", content: "the build passed" }],
  ];
  for (const [format, event] of notThoughts) {
    assert.equal(thinkingTextOf(format, event), null, `${format}: ${JSON.stringify(event)}`);
  }
});

test("streamed chunks coalesce into one block, and a non-thought event closes it", () => {
  const path = tracePath();
  const trace = openThinkingTrace({ path, clock: () => 1_700_000_000_000 });
  const reporter = withThinkingTrace(fakeReporter(), trace);

  reporter.thought("the hero image ");
  reporter.update({ tag: "HYPOTHESIS", text: "thinking" });
  reporter.thought("is the LCP element");
  reporter.update({ tag: "HYPOTHESIS", text: "thinking" });
  // A tool call is not a thought, so the block it interrupts is closed.
  reporter.update({ tag: "EXECUTE", text: "running yarn build" });
  reporter.thought("that beat the noise floor");
  reporter.done();

  assert.deepEqual(readThinkingTrace(path).map((block) => block.text), [
    "the hero image is the LCP element",
    "that beat the noise floor",
  ]);
});

test("a cumulative snapshot replaces the deltas it repeats instead of doubling them", () => {
  const path = tracePath();
  const trace = openThinkingTrace({ path, clock: () => 1 });
  trace.record("preload ");
  trace.record("preload the hero");
  trace.record("preload the hero"); // the same text again, as a completed item
  trace.close();

  assert.deepEqual(readThinkingTrace(path).map((block) => block.text), ["preload the hero"]);
});

test("the trace is capped, so a chatty model cannot fill a disk", () => {
  const path = tracePath();
  const trace = openThinkingTrace({ path, clock: () => 1 });

  trace.record("x".repeat(MAX_BLOCK_CHARS + 500));
  trace.flush();
  for (let i = 0; i < MAX_BLOCKS + 20; i++) {
    trace.record(`thought ${i}`);
    trace.flush();
  }
  trace.close();

  const blocks = readThinkingTrace(path);
  assert.equal(blocks.length, MAX_BLOCKS);
  assert.ok(blocks[0].text.length <= MAX_BLOCK_CHARS);
  assert.ok(trace.stats.dropped > 0);
});

test("the wrapper is transparent: the reporter underneath still sees every event", () => {
  const path = tracePath();
  const trace = openThinkingTrace({ path, clock: () => 1 });
  const underlying = fakeReporter();
  const reporter = withThinkingTrace(underlying, trace);

  reporter.update({ tag: "OBSERVE", text: "reading index.html" });
  reporter.thought("a thought nobody shows");
  reporter.update(null);
  reporter.done();

  assert.deepEqual(underlying.entries, [{ tag: "OBSERVE", text: "reading index.html" }, null, "done"]);
  // And the thought went to the file rather than to the reporter.
  assert.deepEqual(readThinkingTrace(path).map((block) => block.text), ["a thought nobody shows"]);
});

test("a half-written line is skipped rather than failing the read", () => {
  const path = tracePath();
  writeFileSync(path, `{"seq":1,"at":"2026-08-25T00:00:00.000Z","text":"complete"}\n{"seq":2,"at":"2026`);
  assert.deepEqual(readThinkingTrace(path).map((block) => block.text), ["complete"]);

  resetThinkingTrace(path);
  assert.equal(readFileSync(path, "utf8"), "");
  assert.deepEqual(readThinkingTrace(path), []);
});

test("reading a trace that was never written is empty, not an error", () => {
  assert.deepEqual(readThinkingTrace(join(tracePath(), "nope", "missing.jsonl")), []);
});
