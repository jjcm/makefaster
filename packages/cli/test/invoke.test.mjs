import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADLESS_STDIO,
  buildAgentInvocation,
  buildAuthProbe,
  interpretAuthProbe,
  signedOutGuidance,
} from "../lib/invoke.js";
import { runAgent } from "../lib/session.js";

const PROVIDERS = {
  cursor: { key: "cursor", displayName: "Cursor Agent", executablePath: "/usr/local/bin/cursor-agent", signIn: "cursor-agent login" },
  claude: { key: "claude", displayName: "Claude Code", executablePath: "/usr/local/bin/claude", signIn: "claude auth login" },
  codex: { key: "codex", displayName: "Codex", executablePath: "/usr/local/bin/codex", signIn: "codex login" },
};

function invoke(key, overrides = {}) {
  return buildAgentInvocation({
    provider: PROVIDERS[key],
    prompt: "run the makefaster loop",
    cwd: "/repo",
    env: { HOME: "/home/dev", PATH: "/usr/bin" },
    ...overrides,
  });
}

test("no provider ever inherits stdio or attaches the user's stdin", () => {
  for (const key of Object.keys(PROVIDERS)) {
    const { options } = invoke(key);
    assert.deepEqual(options.stdio, HEADLESS_STDIO, key);
    assert.notEqual(options.stdio, "inherit", key);
    assert.equal(options.stdio[0], "ignore", `${key} must not attach the TTY to stdin`);
    assert.equal(options.stdio[1], "pipe", key);
    assert.equal(options.stdio[2], "pipe", key);
    assert.equal(options.windowsHide, true, key);
    assert.equal(options.cwd, "/repo", key);
  }
});

test("the child inherits the user's environment so existing credentials are reused", () => {
  for (const key of Object.keys(PROVIDERS)) {
    const { options } = invoke(key);
    assert.equal(options.env.HOME, "/home/dev", key);
    assert.equal(options.env.NO_COLOR, "1", key);
    assert.equal(options.env.FORCE_COLOR, "0", key);
  }
  // CODEX_HOME is a credential location, so it must survive into the child.
  const { options } = invoke("codex", { env: { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-work" } });
  assert.equal(options.env.CODEX_HOME, "/home/dev/.codex-work");
});

test("no provider argv can start a login, a browser, or a device-code flow", () => {
  for (const key of Object.keys(PROVIDERS)) {
    const { args } = invoke(key, { model: "some-model" });
    const argv = args.join(" ");
    assert.doesNotMatch(argv, /\blogin\b/, key);
    assert.doesNotMatch(argv, /\blogout\b/, key);
    assert.doesNotMatch(argv, /device.?code/i, key);
    assert.doesNotMatch(argv, /--api-key/, key);
  }
});

test("cursor: print mode, auto-approved, model passed through", () => {
  const { command, args, streamFormat } = invoke("cursor", { model: "claude-fable-5-max" });
  assert.equal(command, "/usr/local/bin/cursor-agent");
  assert.equal(streamFormat, "cursor-stream-json");
  assert.deepEqual(args, [
    "-p",
    "--output-format", "stream-json",
    "--force",
    "--trust",
    "--approve-mcps",
    "--workspace", "/repo",
    "--model", "claude-fable-5-max",
    "run the makefaster loop",
  ]);
  // The prompt is the last argument, so nothing is ever read from stdin.
  assert.equal(args.at(-1), "run the makefaster loop");
});

test("claude: print mode with stream-json, permissions skipped, model passed through", () => {
  const { args, streamFormat } = invoke("claude", { model: "claude-fable-5" });
  assert.equal(streamFormat, "claude-stream-json");
  assert.deepEqual(args, [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", "claude-fable-5",
    "run the makefaster loop",
  ]);
});

test("claude: as root, keep the auto-approve intent with a mode root accepts", () => {
  // Claude Code exits before the session starts if asked to skip permissions
  // as root, so the flag is swapped rather than dropped silently.
  const { args } = invoke("claude", { model: "claude-sonnet-5", isRoot: true });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.deepEqual(args.slice(-3), ["--model", "claude-sonnet-5", "run the makefaster loop"]);
});

test("codex: exec, workspace-write sandbox, approvals never, model passed through", () => {
  const { args, streamFormat } = invoke("codex", { model: "gpt-5.6-sol" });
  assert.equal(streamFormat, "codex-jsonl");
  assert.deepEqual(args, [
    "exec",
    "--sandbox", "workspace-write",
    "-c", 'approval_policy="never"',
    "--skip-git-repo-check",
    "--json",
    "--cd", "/repo",
    "--model", "gpt-5.6-sol",
    "run the makefaster loop",
  ]);
  // --full-auto was removed from the Codex CLI; never send it.
  assert.ok(!args.includes("--full-auto"));
});

test("each provider's headless entry point is present and its TUI is not", () => {
  assert.ok(invoke("cursor").args.includes("-p"));
  assert.ok(invoke("claude").args.includes("-p"));
  assert.equal(invoke("codex").args[0], "exec");
});

test("omitting the model omits the flag rather than sending an empty value", () => {
  for (const key of Object.keys(PROVIDERS)) {
    assert.ok(!invoke(key).args.includes("--model"), key);
  }
});

test("an unknown provider fails loudly instead of falling back to a TUI", () => {
  assert.throws(
    () => buildAgentInvocation({ provider: { key: "gemini", displayName: "Gemini", executablePath: "gemini" }, prompt: "x", cwd: "/repo" }),
    /no headless invocation is defined/,
  );
});

test("auth probes are read-only, piped, and never a login", () => {
  const expected = {
    cursor: ["status", "--format", "json"],
    claude: ["auth", "status"],
    codex: ["login", "status"],
  };
  for (const [key, args] of Object.entries(expected)) {
    const probe = buildAuthProbe({ provider: PROVIDERS[key], env: {} });
    assert.deepEqual(probe.args, args, key);
    assert.deepEqual(probe.options.stdio, HEADLESS_STDIO, key);
  }
  // "login status" only reports state; a bare "login" would start a flow.
  assert.deepEqual(buildAuthProbe({ provider: PROVIDERS.codex, env: {} }).args.slice(-1), ["status"]);
  assert.equal(buildAuthProbe({ provider: { key: "gemini" }, env: {} }), null);
});

test("interpretAuthProbe only reports signed-out on a positive signal", () => {
  assert.equal(interpretAuthProbe({ status: 0 }).state, "signed-in");
  assert.equal(interpretAuthProbe({ status: 1, stdout: "Not logged in" }).state, "signed-out");
  const jsonProbe = interpretAuthProbe({ status: 0, stdout: '{"loggedIn": false}' });
  assert.equal(jsonProbe.state, "signed-out");
  // A raw JSON blob is not a sentence to show the user.
  assert.equal(jsonProbe.detail, null);
  assert.equal(interpretAuthProbe({ status: 1, stdout: "Not logged in" }).detail, "Not logged in");
  assert.equal(interpretAuthProbe({ status: 1, signedOutExitCodes: [1] }).state, "signed-out");

  // A CLI too old to know the probe says nothing about credentials.
  assert.equal(interpretAuthProbe({ status: 2, stderr: "error: unrecognized subcommand 'auth'" }).state, "unknown");
  assert.equal(interpretAuthProbe({ status: 1, stderr: "Usage: codex [OPTIONS]" }).state, "unknown");
  assert.equal(interpretAuthProbe({ status: null, timedOut: true }).state, "unknown");
  assert.equal(interpretAuthProbe({ status: null, error: new Error("ENOENT") }).state, "unknown");
  assert.equal(interpretAuthProbe({ status: 7, stderr: "something else entirely" }).state, "unknown");
});

test("signedOutGuidance points at the native CLI and never at makefaster", () => {
  const message = signedOutGuidance(PROVIDERS.claude, "Not logged in");
  assert.match(message, /Claude Code is signed out/);
  assert.match(message, /claude auth login/);
  assert.match(message, /rerun npx makefaster/);
  assert.equal(message.split("\n").length, 1);
});

// A real spawn, to prove the contract end to end: the child sees the headless
// argv, has no stdin, and its stdout never reaches this terminal.
test("runAgent spawns hidden and returns the child's exit code", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "makefaster-invoke-"));
  const fake = join(dir, "fake-agent");
  writeFileSync(fake, [
    "#!/usr/bin/env node",
    "const argv = process.argv.slice(2);",
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, argv, isTTY: Boolean(process.stdin.isTTY) }) + '\\n');",
    "require('node:fs').writeFileSync(process.env.FAKE_AGENT_REPORT, JSON.stringify({ argv, stdinIsTty: Boolean(process.stdin.isTTY) }));",
    "process.exit(3);",
  ].join("\n"));
  chmodSync(fake, 0o755);
  const reportPath = join(dir, "report.json");

  const written = [];
  const result = await runAgent({
    provider: { key: "claude", displayName: "Fake Claude", executablePath: fake },
    prompt: "loop please",
    cwd: dir,
    model: { id: "claude-fable-5", label: "Fable 5" },
    env: { ...process.env, FAKE_AGENT_REPORT: reportPath },
    isRoot: false,
    reporter: {
      eventCount: 0,
      lastLabel: null,
      update: (entry) => written.push(entry?.text ?? entry),
      done: () => written.push("[done]"),
    },
  });

  assert.equal(result.exitCode, 3);
  const report = JSON.parse((await import("node:fs")).readFileSync(reportPath, "utf8"));
  assert.equal(report.stdinIsTty, false, "the child must not see a TTY on stdin");
  assert.ok(report.argv.includes("-p"));
  assert.ok(report.argv.includes("--dangerously-skip-permissions"));
  assert.deepEqual(report.argv.slice(-3), ["--model", "claude-fable-5", "loop please"]);
  // The child's stream became progress labels, not raw terminal output.
  assert.deepEqual(written, ["session started", "agent finished after 2 turns", "[done]"]);
});

test("runAgent reports a missing binary instead of throwing a raw spawn error", async () => {
  await assert.rejects(
    runAgent({
      provider: { key: "codex", displayName: "Codex", executablePath: join(tmpdir(), "makefaster-not-a-real-binary") },
      prompt: "x",
      cwd: tmpdir(),
      reporter: { eventCount: 0, lastLabel: null, update: () => {}, done: () => {} },
    }),
    /failed to launch Codex/,
  );
});
