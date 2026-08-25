import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, USAGE } from "../lib/args.js";

test("defaults", () => {
  const { args, errors } = parseArgs([]);
  assert.deepEqual(errors, []);
  assert.equal(args.targetDir, null);
  assert.equal(args.cli, null);
  assert.equal(args.model, null);
  assert.equal(args.extras, 5);
  assert.equal(args.help, false);
});

test("the dashboard is on unless --no-tui turns it off", () => {
  assert.equal(parseArgs([]).args.tui, true);
  assert.equal(parseArgs(["--no-tui"]).args.tui, false);
});

test("--model is taken verbatim, brackets and all", () => {
  assert.equal(parseArgs(["--model", "gpt-5.6-sol"]).args.model, "gpt-5.6-sol");
  assert.equal(parseArgs(["--model", "claude-opus-4-8[1m]"]).args.model, "claude-opus-4-8[1m]");
  assert.match(parseArgs(["--model"]).errors[0], /needs a value/);
});

test("positional dir plus flags", () => {
  const { args, errors } = parseArgs(["../mysite", "--cli", "claude", "--url", "example.com", "--extras", "3", "--api", "https://api.example.com/"]);
  assert.deepEqual(errors, []);
  assert.equal(args.targetDir, "../mysite");
  assert.equal(args.cli, "claude");
  assert.equal(args.url, "example.com");
  assert.equal(args.extras, 3);
  assert.equal(args.api, "https://api.example.com"); // trailing slash stripped
});

// The extras are the only budget in the run; the checklist's length comes from
// the board. Zero of them is a legitimate "checklist only" run.
test("--extras accepts 0 and rejects what is not a small count", () => {
  assert.equal(parseArgs(["--extras", "0"]).args.extras, 0);
  assert.deepEqual(parseArgs(["--extras", "0"]).errors, []);
  assert.match(parseArgs(["--extras", "-1"]).errors[0], /needs a value/);
  assert.match(parseArgs(["--extras", "99"]).errors[0], /between 0 and 20/);
  assert.match(parseArgs(["--extras", "nope"]).errors[0], /between 0 and 20/);
});

// The miss-streak stop rule is gone, and its flag says so rather than reading
// as a typo — someone passing it is asking for the behaviour that starved runs.
test("--max-misses is refused with the reason", () => {
  const { errors } = parseArgs(["--max-misses", "5"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--max-misses is gone/);
  assert.match(errors[0], /whole imported checklist/);
});

test("--cli aliases map to canonical keys", () => {
  for (const [alias, key] of [["cursor-agent", "cursor"], ["agent", "cursor"], ["claude-code", "claude"], ["Codex", "codex"]]) {
    const { args, errors } = parseArgs(["--cli", alias]);
    assert.deepEqual(errors, [], alias);
    assert.equal(args.cli, key, alias);
  }
});

test("errors: unknown flag, bad cli, missing values, extra positional", () => {
  assert.match(parseArgs(["--frobnicate"]).errors[0], /unknown option/);
  assert.match(parseArgs(["--cli", "gemini"]).errors[0], /--cli must be one of/);
  assert.match(parseArgs(["--extras"]).errors[0], /needs a value/);
  assert.match(parseArgs(["--url"]).errors[0], /needs a value/);
  assert.match(parseArgs(["a", "b"]).errors[0], /unexpected argument/);
});

test("--cli accepts the hosted provider under either name", () => {
  for (const value of ["makefaster", "openrouter", "hosted", "MakeFaster"]) {
    assert.equal(parseArgs(["--cli", value]).args.cli, "makefaster", value);
  }
  assert.match(parseArgs(["--cli", "gemini"]).errors[0], /makefaster, cursor, claude, codex/);
});

test("help and version flags", () => {
  assert.equal(parseArgs(["-h"]).args.help, true);
  assert.equal(parseArgs(["--version"]).args.version, true);
  assert.match(USAGE, /npx makefaster/);
  assert.match(USAGE, /--extras <n>/);
  assert.doesNotMatch(USAGE, /--max-misses/);
  assert.match(USAGE, /--model <id>/);
  assert.match(USAGE, /--no-tui/);
  assert.match(USAGE, /An agent CLI runs\nhidden/);
  assert.match(USAGE, /--cli <makefaster\|cursor\|claude\|codex>/);
});
