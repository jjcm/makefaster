import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_COMPLETIONS_PATH, runOpenRouterSession } from "../lib/agents/openrouter.js";
import { createTools } from "../lib/agents/tools.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-hosted-"));
  mkdirSync(join(dir, ".makefaster"), { recursive: true });
  return { dir, steps: join(dir, ".makefaster", "thinking.log") };
}

/** A fake proxy: replies from a script, and records every request. */
function fakeProxy(replies) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const reply = replies[requests.length - 1] ?? { choices: [{ message: { role: "assistant", content: "done" } }] };
    if (reply.httpStatus) {
      return { ok: false, status: reply.httpStatus, json: async () => reply.body ?? {} };
    }
    return { ok: true, status: 200, json: async () => reply };
  };
  return { requests, fetchImpl };
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function assistantWithCalls(...calls) {
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] };
}

function collectReporter() {
  const seen = [];
  return { seen, update: (entry) => seen.push(entry), done: () => {} };
}

test("the hosted session runs the model's tool calls and stops when it stops calling", async () => {
  const { dir, steps } = repo();
  const { requests, fetchImpl } = fakeProxy([
    assistantWithCalls(
      toolCall("1", "report_step", { tag: "INITIALIZING", text: "Prepping project and installing dependencies." }),
      toolCall("2", "write_file", { path: "index.html", contents: "<h1>hi</h1>" }),
    ),
    assistantWithCalls(toolCall("3", "read_file", { path: "index.html" })),
    { choices: [{ message: { role: "assistant", content: "finished" } }] },
  ]);
  const reporter = collectReporter();

  const result = await runOpenRouterSession({
    prompt: "follow the skill",
    cwd: dir,
    apiBase: "https://makefaster.dev",
    stepLogPath: steps,
    reporter,
    fetchImpl,
  });

  assert.deepEqual(result, { exitCode: 0, stderrTail: "", aborted: false, authRequired: false, detail: null });
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<h1>hi</h1>");
  assert.equal(
    readFileSync(steps, "utf8"),
    "[INITIALIZING] Prepping project and installing dependencies.\n",
  );

  // Three round trips, all to the proxy path, and the tool results were fed back.
  assert.equal(requests.length, 3);
  assert.ok(requests[0].url.endsWith(CHAT_COMPLETIONS_PATH), requests[0].url);
  const secondTurn = requests[1].body.messages;
  assert.equal(secondTurn.at(-1).role, "tool");
  assert.match(secondTurn.at(-1).content, /wrote index\.html/);
  // The dashboard's heartbeat saw the work, even though the panel does not.
  assert.ok(reporter.seen.length >= 4);
});

// The credential lives on the server. The CLI must not send one, and must not
// name a model — the server pins it.
test("the hosted session sends no credential and no model", async () => {
  const { dir, steps } = repo();
  const { requests, fetchImpl } = fakeProxy([{ choices: [{ message: { role: "assistant", content: "done" } }] }]);

  await runOpenRouterSession({ prompt: "go", cwd: dir, apiBase: "https://makefaster.dev", stepLogPath: steps, fetchImpl });

  const { init, body } = requests[0];
  const headerNames = Object.keys(init.headers).map((name) => name.toLowerCase());
  assert.equal(headerNames.includes("authorization"), false);
  assert.equal(headerNames.includes("x-api-key"), false);
  assert.equal("model" in body, false, "the server pins the model");
  assert.equal(JSON.stringify(init).includes("sk-"), false);
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "the model needs its tools");
});

test("a proxy error becomes a readable reason, not a crash", async () => {
  const { dir, steps } = repo();
  const { fetchImpl } = fakeProxy([{
    httpStatus: 503,
    body: { ok: false, errors: ["this makefaster deployment has no OpenRouter credential configured"] },
  }]);

  const result = await runOpenRouterSession({ prompt: "go", cwd: dir, apiBase: "https://makefaster.dev", stepLogPath: steps, fetchImpl });
  assert.equal(result.exitCode, 1);
  assert.match(result.detail, /no OpenRouter credential configured/);
  assert.equal(result.stderrTail, result.detail);
});

test("the hosted session stops itself rather than looping forever", async () => {
  const { dir, steps } = repo();
  // Always another tool call: a model that never finishes.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => assistantWithCalls(toolCall("x", "list_dir", { path: "." })),
  });

  const result = await runOpenRouterSession({
    prompt: "go", cwd: dir, apiBase: "https://makefaster.dev", stepLogPath: steps, fetchImpl, maxTurns: 3,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.detail, /without finishing/);
});

test("an unknown tool is an error the model can read, not a thrown exception", async () => {
  const { dir, steps } = repo();
  const { requests, fetchImpl } = fakeProxy([
    assistantWithCalls(toolCall("1", "delete_everything", { path: "/" })),
    { choices: [{ message: { role: "assistant", content: "ok" } }] },
  ]);

  const result = await runOpenRouterSession({ prompt: "go", cwd: dir, apiBase: "https://makefaster.dev", stepLogPath: steps, fetchImpl });
  assert.equal(result.exitCode, 0);
  assert.match(requests[1].body.messages.at(-1).content, /no such tool/);
});

// ---------------------------------------------------------------- the tools

test("the tools cannot touch anything outside the repo", async () => {
  const { dir, steps } = repo();
  const tools = createTools({ cwd: dir, stepLogPath: steps });

  for (const path of ["../escape.txt", "../../etc/passwd", "/etc/passwd", join(dir, "..", "sneaky.txt")]) {
    const read = await tools.read_file({ path });
    assert.equal(read.ok, false, `read ${path}`);
    assert.match(read.text, /outside the repo|ENOENT/);

    const write = await tools.write_file({ path, contents: "nope" });
    assert.equal(write.ok, false, `write ${path}`);
  }
  assert.equal(existsSync(join(dir, "..", "sneaky.txt")), false);

  // An absolute path inside the repo is fine — models write them constantly.
  const inside = await tools.write_file({ path: join(dir, "src", "app.js"), contents: "ok" });
  assert.equal(inside.ok, true, inside.text);
  assert.equal(readFileSync(join(dir, "src", "app.js"), "utf8"), "ok");
});

test("edit_file insists on an unambiguous match", async () => {
  const { dir, steps } = repo();
  const tools = createTools({ cwd: dir, stepLogPath: steps });
  writeFileSync(join(dir, "style.css"), "a { color: red }\nb { color: red }\n");

  const ambiguous = await tools.edit_file({ path: "style.css", find: "color: red", replace: "color: blue" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.text, /matched 2 times/);

  const missing = await tools.edit_file({ path: "style.css", find: "color: green", replace: "x" });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /did not match/);

  const good = await tools.edit_file({ path: "style.css", find: "a { color: red }", replace: "a { color: blue }" });
  assert.equal(good.ok, true, good.text);
  assert.match(readFileSync(join(dir, "style.css"), "utf8"), /a \{ color: blue \}/);
});

test("report_step only accepts the documented tags", async () => {
  const { dir, steps } = repo();
  const tools = createTools({ cwd: dir, stepLogPath: steps });

  assert.equal((await tools.report_step({ tag: "EXECUTE", text: "working" })).ok, false);
  assert.equal((await tools.report_step({ tag: "TEST", text: "" })).ok, false);
  assert.equal((await tools.report_step({ tag: "test", text: "Running lighthouse" })).ok, true);
  // Multi-line prose is flattened, because the panel is one line per step.
  await tools.report_step({ tag: "SKIP", text: "Enable Gzip\n  — the CDN does it already." });

  assert.deepEqual(readFileSync(steps, "utf8").split("\n").filter(Boolean), [
    "[TEST] Running lighthouse",
    "[SKIP] Enable Gzip — the CDN does it already.",
  ]);
});

test("run_shell returns the exit code and output, and cannot hang the loop", async () => {
  const { dir, steps } = repo();
  const tools = createTools({ cwd: dir, stepLogPath: steps });

  const hello = await tools.run_shell({ command: "echo hello && pwd" });
  assert.match(hello.text, /^exit 0/);
  assert.match(hello.text, /hello/);

  const failure = await tools.run_shell({ command: "exit 3" });
  assert.match(failure.text, /^exit 3/);

  // A command that would wait for input gets EOF, not a hung dashboard.
  const noStdin = await tools.run_shell({ command: "read -r line; echo \"got:$line\"" });
  assert.match(noStdin.text, /got:/);

  const timedOut = await tools.run_shell({ command: "sleep 5", timeout_ms: 1000 });
  assert.match(timedOut.text, /timed out after 1000ms/);
});

test("read_file numbers lines and pages through a long file", async () => {
  const { dir, steps } = repo();
  const tools = createTools({ cwd: dir, stepLogPath: steps });
  writeFileSync(join(dir, "long.txt"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));

  const page = await tools.read_file({ path: "long.txt", start_line: 10, max_lines: 3 });
  assert.equal(page.text, "10\tline 10\n11\tline 11\n12\tline 12");
});
