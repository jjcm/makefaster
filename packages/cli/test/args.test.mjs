import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, USAGE } from "../lib/args.js";

test("defaults", () => {
  const { args, errors } = parseArgs([]);
  assert.deepEqual(errors, []);
  assert.equal(args.targetDir, null);
  assert.equal(args.cli, null);
  assert.equal(args.model, null);
  assert.equal(args.maxMisses, 5);
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
  const { args, errors } = parseArgs(["../mysite", "--cli", "claude", "--url", "example.com", "--max-misses", "3", "--api", "https://api.example.com/"]);
  assert.deepEqual(errors, []);
  assert.equal(args.targetDir, "../mysite");
  assert.equal(args.cli, "claude");
  assert.equal(args.url, "example.com");
  assert.equal(args.maxMisses, 3);
  assert.equal(args.api, "https://api.example.com"); // trailing slash stripped
});

test("--cli aliases map to canonical keys", () => {
  for (const [alias, key] of [["cursor-agent", "cursor"], ["agent", "cursor"], ["claude-code", "claude"], ["Codex", "codex"]]) {
    const { args, errors } = parseArgs(["--cli", alias]);
    assert.deepEqual(errors, [], alias);
    assert.equal(args.cli, key, alias);
  }
});

test("errors: unknown flag, bad cli, bad max-misses, missing values, extra positional", () => {
  assert.match(parseArgs(["--frobnicate"]).errors[0], /unknown option/);
  assert.match(parseArgs(["--cli", "gemini"]).errors[0], /--cli must be one of/);
  assert.match(parseArgs(["--max-misses", "0"]).errors[0], /between 1 and 100/);
  assert.match(parseArgs(["--max-misses", "nope"]).errors[0], /between 1 and 100/);
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
  assert.match(USAGE, /--max-misses/);
  assert.match(USAGE, /--model <id>/);
  assert.match(USAGE, /--no-tui/);
  assert.match(USAGE, /An agent CLI runs\nhidden/);
  assert.match(USAGE, /--cli <makefaster\|cursor\|claude\|codex>/);
});
