/**
 * End-to-end protocol tests: real spawned children speaking ACP and the codex
 * app-server dialect, so the wire shapes are proven rather than asserted about.
 *
 * Each fake records the frames it received, which is how these tests check the
 * things that matter and cannot be seen from argv alone: that stdin is a pipe
 * rather than a TTY, that the model is pinned where each protocol expects it,
 * and that permission and approval requests are answered without a human.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcpSession } from "../lib/agents/acp.js";
import { runCodexSession, listCodexModels } from "../lib/agents/codexAppServer.js";
import { runAgent } from "../lib/session.js";

function recorder() {
  const entries = [];
  return {
    entries,
    reporter: {
      eventCount: 0,
      lastLabel: null,
      update(entry) {
        if (entry) entries.push([entry.tag, entry.text]);
      },
      done() {},
    },
    tags: () => entries.map(([tag]) => tag),
    texts: () => entries.map(([, text]) => text),
  };
}

function writeFake(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

/** A `cursor-agent acp` stand-in that records frames and asks for permission. */
const FAKE_ACP = `
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const report = { argv: process.argv.slice(2), stdinIsTty: Boolean(process.stdin.isTTY), frames: [] };
const flush = () => fs.writeFileSync(process.env.FAKE_REPORT, JSON.stringify(report));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const pending = new Map();
let nextId = 0;
function ask(method, params) {
  const id = ++nextId;
  return new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}
createInterface({ input: process.stdin, terminal: false }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  report.frames.push(message);
  flush();
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } } });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session-1" } });
      return;
    case "session/prompt": {
      const sid = message.params.sessionId;
      const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: u } });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read index.html", kind: "read", status: "pending", locations: [{ path: "/repo/index.html" }] });
      const answer = await ask("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "t2", title: "Edit index.html", kind: "edit" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      });
      report.permissionAnswer = answer.result;
      flush();
      update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit index.html", kind: "edit", status: "completed" });
      update({ sessionUpdate: "tool_call", toolCallId: "t3", title: "", kind: "execute", status: "pending", rawInput: { command: "npx lighthouse http://localhost:8000" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "kept the change" } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown " + message.method } });
  }
});
`;

/** A `codex app-server` stand-in that raises an approval mid-turn. */
const FAKE_APP_SERVER = `
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const report = { argv: process.argv.slice(2), stdinIsTty: Boolean(process.stdin.isTTY), frames: [] };
const flush = () => fs.writeFileSync(process.env.FAKE_REPORT, JSON.stringify(report));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const pending = new Map();
let nextId = 0;
function ask(method, params) {
  const id = ++nextId;
  return new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}
createInterface({ input: process.stdin, terminal: false }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  report.frames.push(message);
  flush();
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    case "model/list":
      send({ jsonrpc: "2.0", id: message.id, result: { data: [
        { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false },
        { id: "gpt-5.2", model: "gpt-5.2", displayName: "GPT-5.2", hidden: false },
        { id: "secret", model: "secret", displayName: "Hidden", hidden: true },
      ] } });
      return;
    case "thread/start":
      send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "codex-thread-1" } } });
      return;
    case "turn/start": {
      const threadId = message.params.threadId;
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      notify("turn/started", { threadId, turn: { id: "turn-1", status: "inProgress" } });
      notify("item/completed", { threadId, turnId: "turn-1", item: { type: "reasoning", id: "r1" } });
      const answer = await ask("item/commandExecution/requestApproval", {
        threadId, turnId: "turn-1", itemId: "c1",
        command: "npx lighthouse http://localhost:8000",
        availableDecisions: ["accept", "acceptForSession", "decline"],
      });
      report.commandApproval = answer.result;
      flush();
      const fileAnswer = await ask("item/fileChange/requestApproval", { threadId, turnId: "turn-1", itemId: "f1", grantRoot: "/repo" });
      report.fileApproval = fileAnswer.result;
      flush();
      notify("item/completed", { threadId, turnId: "turn-1", item: { type: "commandExecution", id: "c1", command: "npx lighthouse http://localhost:8000", cwd: "/repo", status: "completed", aggregatedOutput: null, exitCode: 0, durationMs: 10 } });
      notify("item/completed", { threadId, turnId: "turn-1", item: { type: "fileChange", id: "f1", changes: [{ path: "/repo/index.html" }], status: "completed" } });
      notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown " + message.method } });
  }
});
`;

function session(body, name) {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-protocol-"));
  const path = writeFake(dir, name, body);
  const reportPath = join(dir, "report.json");
  return { dir, path, reportPath, read: () => JSON.parse(readFileSync(reportPath, "utf8")) };
}

const SKIP = { skip: process.platform === "win32" };

test("cursor: ACP handshake, model before `acp`, no TTY on stdin", SKIP, async () => {
  const fake = session(FAKE_ACP, "fake-cursor-agent");
  const log = recorder();
  const result = await runAcpSession({
    provider: { key: "cursor", displayName: "Cursor Agent", executablePath: fake.path, signIn: "cursor-agent login" },
    prompt: "run the makefaster loop",
    cwd: fake.dir,
    model: { id: "claude-fable-5-thinking-medium", label: "Fable 5" },
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.authRequired, false);

  const report = fake.read();
  assert.deepEqual(report.argv, ["--model", "claude-fable-5-thinking-medium", "acp"]);
  assert.equal(report.stdinIsTty, false, "the child must never see a TTY on stdin");

  const byMethod = new Map(report.frames.filter((f) => f.method).map((f) => [f.method, f]));
  const initialize = byMethod.get("initialize");
  assert.equal(initialize.params.protocolVersion, 1);
  assert.equal(initialize.params.clientInfo.name, "makefaster");
  // makefaster advertises no filesystem capability, so the agent edits directly.
  assert.deepEqual(initialize.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(byMethod.get("session/new").params, { cwd: fake.dir, mcpServers: [] });
  assert.deepEqual(byMethod.get("session/prompt").params.prompt, [{ type: "text", text: "run the makefaster loop" }]);
  // Never an authenticate call: Cursor advertises no auth methods and the
  // credentials `cursor-agent login` wrote are reused as-is.
  assert.ok(!byMethod.has("authenticate"));
});

test("cursor: a permission request is answered without a human, preferring a lasting grant", SKIP, async () => {
  const fake = session(FAKE_ACP, "fake-cursor-agent");
  const log = recorder();
  await runAcpSession({
    provider: { key: "cursor", displayName: "Cursor Agent", executablePath: fake.path },
    prompt: "loop",
    cwd: fake.dir,
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });
  // allow_always over allow_once, so the same tool is not re-asked every round.
  assert.deepEqual(fake.read().permissionAnswer, { outcome: { outcome: "selected", optionId: "always" } });
});

test("cursor: session/update becomes tagged loop steps", SKIP, async () => {
  const fake = session(FAKE_ACP, "fake-cursor-agent");
  const log = recorder();
  await runAcpSession({
    provider: { key: "cursor", displayName: "Cursor Agent", executablePath: fake.path },
    prompt: "loop",
    cwd: fake.dir,
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });
  assert.deepEqual(log.entries, [
    ["HYPOTHESIS", "thinking"],
    ["OBSERVE", "Read index.html"],
    ["EXECUTE", "approved Edit index.html"],
    ["EXECUTE", "Edit index.html"],
    // An untitled execute call is labelled from its command, and a measuring
    // command is the loop's TEST step.
    ["TEST", "running npx lighthouse http://localhost:8000"],
    ["OBSERVE", "kept the change"],
  ]);
});

test("codex: app-server handshake, model on thread/start, workspace-write with approvals never", SKIP, async () => {
  const fake = session(FAKE_APP_SERVER, "fake-codex");
  const log = recorder();
  const result = await runCodexSession({
    provider: { key: "codex", displayName: "Codex", executablePath: fake.path, signIn: "codex login" },
    prompt: "run the makefaster loop",
    cwd: fake.dir,
    model: { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });

  assert.equal(result.exitCode, 0);
  const report = fake.read();
  assert.deepEqual(report.argv, ["app-server"]);
  assert.equal(report.stdinIsTty, false);

  const byMethod = new Map(report.frames.filter((f) => f.method).map((f) => [f.method, f]));
  assert.equal(byMethod.get("initialize").params.clientInfo.name, "makefaster");

  const start = byMethod.get("thread/start").params;
  assert.equal(start.model, "gpt-5.6-sol", "the model is pinned on the thread, not in argv");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.sandbox, "workspace-write");
  assert.equal(start.cwd, fake.dir);

  const turn = byMethod.get("turn/start").params;
  assert.equal(turn.threadId, "codex-thread-1");
  assert.deepEqual(turn.input, [{ type: "text", text: "run the makefaster loop", text_elements: [] }]);
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [fake.dir],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test("codex: approvals are answered even though the policy is never", SKIP, async () => {
  const fake = session(FAKE_APP_SERVER, "fake-codex");
  const log = recorder();
  await runCodexSession({
    provider: { key: "codex", displayName: "Codex", executablePath: fake.path },
    prompt: "loop",
    cwd: fake.dir,
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });
  const report = fake.read();
  // A hidden child blocking on an approval would hang with nothing on screen.
  assert.deepEqual(report.commandApproval, { decision: "acceptForSession" });
  assert.deepEqual(report.fileApproval, { decision: "acceptForSession" });
  assert.deepEqual(log.entries, [
    ["OBSERVE", "turn started"],
    ["HYPOTHESIS", "thinking"],
    ["EXECUTE", "approved npx lighthouse http://localhost:8000"],
    ["EXECUTE", "approved a file change"],
    ["TEST", "running npx lighthouse http://localhost:8000"],
    ["EXECUTE", "editing index.html"],
    ["RESULT", "turn completed"],
  ]);
});

test("codex: the round waits for turn/completed, not just the turn/start reply", SKIP, async () => {
  // turn/start is only an acknowledgement; settling on it would read
  // results.json before the agent had written the iteration.
  const fake = session(FAKE_APP_SERVER, "fake-codex");
  const log = recorder();
  await runCodexSession({
    provider: { key: "codex", displayName: "Codex", executablePath: fake.path },
    prompt: "loop",
    cwd: fake.dir,
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });
  assert.deepEqual(log.entries.at(-1), ["RESULT", "turn completed"]);
});

test("codex: live model/list drops hidden models", SKIP, async () => {
  const fake = session(FAKE_APP_SERVER, "fake-codex");
  const models = await listCodexModels({
    provider: { key: "codex", displayName: "Codex", executablePath: fake.path },
    cwd: fake.dir,
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
  });
  assert.deepEqual(models, [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
  ]);
});

test("a signed-out child is reported as auth-required, not as a crash", SKIP, async () => {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-protocol-"));
  const path = writeFake(dir, "signed-out", `
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Authentication required. Run \`cursor-agent login\`." } }) + "\\n");
});
`);
  const log = recorder();
  const result = await runAcpSession({
    provider: { key: "cursor", displayName: "Cursor Agent", executablePath: path, signIn: "cursor-agent login" },
    prompt: "loop",
    cwd: dir,
    reporter: log.reporter,
  });
  assert.equal(result.authRequired, true);
  assert.match(result.detail, /Authentication required/);
});

test("runAgent routes each provider to its protocol runner", SKIP, async () => {
  const fake = session(FAKE_ACP, "fake-cursor-agent");
  const log = recorder();
  const result = await runAgent({
    provider: { key: "cursor", displayName: "Cursor Agent", executablePath: fake.path },
    prompt: "loop",
    cwd: fake.dir,
    model: { id: "gpt-5.6-sol-medium", label: "Sol" },
    env: { ...process.env, FAKE_REPORT: fake.reportPath },
    reporter: log.reporter,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRequired, false);
  assert.deepEqual(fake.read().argv, ["--model", "gpt-5.6-sol-medium", "acp"]);

  await assert.rejects(
    runAgent({ provider: { key: "gemini", displayName: "Gemini", executablePath: "gemini" }, prompt: "x", cwd: fake.dir, reporter: log.reporter }),
    /no protocol runner is defined/,
  );
});

test("q during a round kills the child instead of orphaning it", SKIP, async () => {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-protocol-"));
  const path = writeFake(dir, "never-finishes", `
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\\n");
    return;
  }
  if (message.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s" } }) + "\\n");
    return;
  }
  // session/prompt is never answered.
});
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const log = recorder();
  const running = runAcpSession({
    provider: { key: "cursor", displayName: "Cursor Agent", executablePath: path },
    prompt: "loop",
    cwd: dir,
    reporter: log.reporter,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, 0, "a deliberate stop is not a failure");
});
