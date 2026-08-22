import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEVER_INJECTED_ENV,
  PROTOCOL_STDIO,
  buildAgentSpawn,
  childEnv,
  claudePrintModeArgs,
  isAuthRequiredError,
  signedOutGuidance,
} from "../lib/invoke.js";
import { loadClaudeAgentSdk } from "../lib/agents/claudeCode.js";

const PROVIDERS = {
  cursor: { key: "cursor", displayName: "Cursor Agent", executablePath: "/usr/local/bin/cursor-agent", signIn: "cursor-agent login" },
  claude: { key: "claude", displayName: "Claude Code", executablePath: "/usr/local/bin/claude", signIn: "claude auth login" },
  codex: { key: "codex", displayName: "Codex", executablePath: "/usr/local/bin/codex", signIn: "codex login" },
};

const ENV = { HOME: "/home/dev", PATH: "/usr/bin" };
const spawnFor = (key, overrides = {}) => buildAgentSpawn({ provider: PROVIDERS[key], cwd: "/repo", env: ENV, ...overrides });

test("every provider is a piped protocol child, never an inherited TUI", () => {
  for (const key of Object.keys(PROVIDERS)) {
    const { options } = spawnFor(key);
    assert.deepEqual(options.stdio, PROTOCOL_STDIO, key);
    assert.notEqual(options.stdio, "inherit", key);
    // stdin is a pipe we write protocol frames into — not the user's terminal.
    assert.equal(options.stdio[0], "pipe", key);
    assert.equal(options.stdio[1], "pipe", key);
    assert.equal(options.stdio[2], "pipe", key);
    assert.equal(options.windowsHide, true, key);
    assert.equal(options.cwd, "/repo", key);
  }
});

test("cursor launches ACP with --model before the subcommand", () => {
  // bb composes the model flag as prefixArgs ahead of the launch spec's own
  // args, so `--model` is a global option and `acp` stays last.
  const withModel = spawnFor("cursor", { model: "claude-fable-5-thinking-medium" });
  assert.equal(withModel.protocol, "acp");
  assert.equal(withModel.command, "/usr/local/bin/cursor-agent");
  assert.deepEqual(withModel.args, ["--model", "claude-fable-5-thinking-medium", "acp"]);
  assert.equal(withModel.args.at(-1), "acp");

  // No model: the account default, not a guessed id.
  assert.deepEqual(spawnFor("cursor").args, ["acp"]);
});

test("cursor gets no print mode, no prompt in argv, and no permission flag", () => {
  const { args } = spawnFor("cursor", { model: "gpt-5.6-sol-medium" });
  assert.ok(!args.includes("-p"), "print mode is not the ACP path");
  assert.ok(!args.includes("--print"));
  assert.ok(!args.includes("--output-format"));
  // --force / --yolo / --trust / --approve-mcps belong to other agents; Cursor
  // has no permission flag, so permission is answered over the protocol.
  for (const flag of ["--force", "--yolo", "--trust", "--approve-mcps", "--always-approve"]) {
    assert.ok(!args.includes(flag), `cursor must not be passed ${flag}`);
  }
  assert.ok(!args.some((arg) => arg.includes(" ")), "no prompt text rides argv");
});

test("codex launches the app-server and pins no model on the command line", () => {
  const spec = spawnFor("codex", { model: "gpt-5.6-sol" });
  assert.equal(spec.protocol, "codex-app-server");
  assert.deepEqual(spec.args, ["app-server"]);
  // The model and the permission posture ride thread/start and turn/start.
  assert.ok(!spec.args.includes("--model"));
  assert.ok(!spec.args.includes("exec"));
  assert.ok(!spec.args.includes("--full-auto"));
  assert.ok(!spec.args.includes("--sandbox"));
});

test("no provider argv can start a login, a browser, or a device-code flow", () => {
  for (const key of Object.keys(PROVIDERS)) {
    const argv = spawnFor(key, { model: "some-model" }).args.join(" ");
    assert.doesNotMatch(argv, /\blogin\b/, key);
    assert.doesNotMatch(argv, /\blogout\b/, key);
    assert.doesNotMatch(argv, /device.?code/i, key);
    assert.doesNotMatch(argv, /--api-key/, key);
  }
});

test("the child environment is the user's own, with no API key injected", () => {
  const env = childEnv({ HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-work", PATH: "/usr/bin" });
  assert.deepEqual(env, { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-work", PATH: "/usr/bin" });
  // An injected key fights the OAuth credentials the CLI already stored.
  for (const key of NEVER_INJECTED_ENV) assert.ok(!(key in env), `${key} must never be set by makefaster`);

  for (const key of Object.keys(PROVIDERS)) {
    const { options } = spawnFor(key);
    assert.equal(options.env.HOME, "/home/dev", key);
    for (const name of NEVER_INJECTED_ENV) assert.ok(!(name in options.env), `${key} must not receive ${name}`);
  }
  // A key the user set themselves is theirs to keep — makefaster only refuses to add one.
  assert.equal(childEnv({ ANTHROPIC_API_KEY: "sk-user-own" }).ANTHROPIC_API_KEY, "sk-user-own");
});

test("claude print-mode fallback loads ~/.claude settings and skips permissions", () => {
  const args = claudePrintModeArgs({ model: "claude-fable-5" });
  assert.deepEqual(args, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "user,project,local",
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
    "--model", "claude-fable-5",
  ]);
  // The prompt is a stdin frame, so --input-format is what keeps it off argv.
  assert.ok(args.includes("--input-format"));
  assert.ok(!args.some((arg) => arg.includes(" ")));
});

test("claude as root keeps the auto-approve intent with a mode root accepts", () => {
  // Claude Code exits before the session starts if asked to skip permissions as
  // root, so the flag is swapped rather than dropped silently.
  const args = claudePrintModeArgs({ model: "claude-sonnet-5", isRoot: true });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("bypassPermissions"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.deepEqual(args.slice(-2), ["--model", "claude-sonnet-5"]);
});

test("omitting the model omits the flag rather than sending an empty value", () => {
  assert.ok(!claudePrintModeArgs().includes("--model"));
  assert.ok(!spawnFor("cursor").args.includes("--model"));
});

test("an unknown provider fails loudly instead of falling back to a TUI", () => {
  assert.throws(
    () => buildAgentSpawn({ provider: { key: "gemini", displayName: "Gemini", executablePath: "gemini" }, cwd: "/repo" }),
    /no protocol invocation is defined/,
  );
});

test("isAuthRequiredError only fires on the child's own auth words", () => {
  for (const text of [
    "Authentication required",
    "You are not logged in",
    "Not signed in. Run `cursor-agent login`.",
    "unauthenticated",
    "OAuth token has expired",
    "invalid credentials",
    "HTTP 401 Unauthorized",
  ]) {
    assert.equal(isAuthRequiredError(text), true, text);
  }
  for (const text of [
    "",
    "ENOENT: no such file or directory",
    "codex app-server exited (code 1, signal null)",
    "the model refused to answer",
    "Error: connection reset",
  ]) {
    assert.equal(isAuthRequiredError(text), false, JSON.stringify(text));
  }
  assert.equal(isAuthRequiredError(new Error("Authentication required")), true);
  assert.equal(isAuthRequiredError(null, undefined, "not logged in"), true);
});

test("signedOutGuidance points at the native CLI and never at makefaster", () => {
  const message = signedOutGuidance(PROVIDERS.claude, "Not logged in");
  assert.match(message, /Claude Code needs a sign-in/);
  assert.match(message, /claude auth login/);
  assert.match(message, /rerun npx makefaster/);
  assert.equal(message.split("\n").length, 1, "a multi-line lecture is not the point");
  // A multi-line detail is collapsed rather than pasted in.
  assert.equal(signedOutGuidance(PROVIDERS.codex, "line one\nline two").split("\n").length, 1);
});

test("the Agent SDK is optional: a missing module is not an error", async () => {
  assert.equal(await loadClaudeAgentSdk(() => Promise.reject(new Error("Cannot find module"))), null);
  // A module without query() is not the SDK we can drive.
  assert.equal(await loadClaudeAgentSdk(() => Promise.resolve({})), null);
  const fake = { query: () => {} };
  assert.equal(await loadClaudeAgentSdk(() => Promise.resolve(fake)), fake);
  // Reality check: this repo ships no dependencies, so the real import fails.
  assert.equal(await loadClaudeAgentSdk(), null);
});
