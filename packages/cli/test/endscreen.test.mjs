import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEndScreen } from "../lib/endscreen.js";
import { sessionPaths } from "../lib/session.js";

const RESULTS = {
  version: 1,
  site: { url: "example.com", name: "Example", prUrl: "https://github.com/jjcm/example/pull/4" },
  northStar: "lcp",
  baseline: { cold: { lcpMs: 2400, ttiMs: 3900 } },
  final: { cold: { lcpMs: 1750, ttiMs: 3050 } },
  iterations: [
    { n: 1, name: "Inline critical CSS", description: "Inlined above-the-fold styles", deltaMs: -260, deltaPct: -10.8, kept: true, notes: "src/app/shell.tsx line 42" },
    { n: 2, name: "Preload thumbnails", deltaMs: 150, deltaPct: 6.2, kept: false },
  ],
};

const STATE = {
  apiBase: "https://makefaster.test",
  provider: "cursor",
  model: "claude-fable-5",
  modelLabel: "Fable 5",
  runId: "run-xyz",
  startedAt: "2026-08-25T10:00:00.000Z",
  round: 1,
  checklistCount: 12,
  extrasBudget: 5,
  siteUrl: "example.com",
};

/**
 * A session directory with a trace in it, plus the recorder the tests assert
 * on: every prompt in order, every answer given, and every POST made.
 */
function harness({ answers, blocks = ["the hero image is the LCP element", "preloading it beat the noise floor"] }) {
  const cwd = mkdtempSync(join(tmpdir(), "makefaster-endscreen-"));
  const paths = sessionPaths(cwd);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.trace, blocks.map((text, i) => JSON.stringify({ seq: i + 1, at: "2026-08-25T10:0" + i + ":00.000Z", text })).join("\n") + (blocks.length > 0 ? "\n" : ""));

  const asked = [];
  const posts = [];
  const io = {
    log() {},
    question: async () => "",
    confirm: async (prompt, options) => {
      asked.push({ prompt: prompt.trim(), def: options?.def });
      const key = Object.keys(answers).find((needle) => prompt.includes(needle));
      return key === undefined ? false : answers[key];
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(STATE.apiBase, "");
    posts.push({ path, payload: JSON.parse(init.body) });
    const bodies = {
      "/api/submit-site": { ok: true, created: true, row: {} },
      "/api/submit-improvements": { ok: true, results: [] },
      "/api/submit-trace": { ok: true, runId: "run-xyz", thinkingBlocks: blocks.length },
    };
    return { ok: true, status: 200, json: async () => bodies[path] ?? { ok: true } };
  };

  return {
    paths,
    asked,
    posts,
    io,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function run(setup) {
  try {
    return await runEndScreen({ results: RESULTS, state: STATE, paths: setup.paths, io: setup.io, interactive: true });
  } finally {
    setup.restore();
  }
}

test("the chain-of-thought question comes after the results questions, not bundled with them", async () => {
  const setup = harness({ answers: { "Keep looping": false, "Submit site stats": true, "Submit anonymous improvements": true, "Submit the chain of thought": true } });
  const outcome = await run(setup);

  assert.deepEqual(setup.asked.map((entry) => entry.prompt), [
    "Keep looping?",
    "Submit site stats?",
    "Submit anonymous improvements?",
    "Submit the chain of thought?",
  ]);
  assert.deepEqual(setup.posts.map((post) => post.path), [
    "/api/submit-site",
    "/api/submit-improvements",
    "/api/submit-trace",
  ]);
  assert.deepEqual(outcome, { loopMore: false, resultsSubmitted: true, traceSubmitted: true });
});

test("the chain-of-thought question defaults to no and takes an explicit yes", async () => {
  const setup = harness({ answers: { "Keep looping": false, "Submit site stats": true, "Submit anonymous improvements": true } });
  const outcome = await run(setup);

  const cot = setup.asked.find((entry) => entry.prompt.startsWith("Submit the chain"));
  assert.equal(cot.def, false, "the chain-of-thought prompt must default to no");
  assert.equal(outcome.traceSubmitted, false);
  assert.equal(setup.posts.some((post) => post.path === "/api/submit-trace"), false,
    "declining must send nothing at all");
});

test("uploading results and declining the chain of thought are independent answers", async () => {
  // Results yes, trace no.
  const resultsOnly = harness({ answers: { "Submit site stats": true, "Submit anonymous improvements": true } });
  const first = await run(resultsOnly);
  assert.equal(first.resultsSubmitted, true);
  assert.equal(first.traceSubmitted, false);
  assert.deepEqual(resultsOnly.posts.map((post) => post.path), ["/api/submit-site", "/api/submit-improvements"]);

  // Results no, trace yes — still asked, and still sent.
  const traceOnly = harness({ answers: { "Submit the chain of thought": true } });
  const second = await run(traceOnly);
  assert.equal(second.resultsSubmitted, false);
  assert.equal(second.traceSubmitted, true);
  assert.deepEqual(traceOnly.posts.map((post) => post.path), ["/api/submit-trace"]);
  assert.equal(traceOnly.posts[0].payload.resultsSubmitted, false,
    "the trace records that the results were declined");
});

test("looping more skips every submission question, including the trace", async () => {
  const setup = harness({ answers: { "Keep looping": true, "Submit the chain of thought": true } });
  const outcome = await run(setup);

  assert.deepEqual(setup.asked.map((entry) => entry.prompt), ["Keep looping?"]);
  assert.deepEqual(setup.posts, []);
  assert.deepEqual(outcome, { loopMore: true, resultsSubmitted: false, traceSubmitted: false });
});

test("the submitted trace is thinking text plus the iteration list, and nothing else", async () => {
  const setup = harness({ answers: { "Submit the chain of thought": true } });
  await run(setup);

  const { payload } = setup.posts.find((post) => post.path === "/api/submit-trace");
  assert.deepEqual(payload.thinking, [
    { text: "the hero image is the LCP element" },
    { text: "preloading it beat the noise floor" },
  ]);
  assert.equal(payload.runId, "run-xyz");
  assert.equal(payload.product, "Example");
  assert.equal(payload.prUrl, "https://github.com/jjcm/example/pull/4");
  assert.equal(payload.agent, "cursor");
  assert.equal(payload.model, "claude-fable-5");
  assert.equal(payload.round, 1);
  assert.equal(payload.startedAt, "2026-08-25T10:00:00.000Z");
  assert.ok(payload.submittedAt);

  assert.deepEqual(payload.results.iterations, [
    { name: "Inline critical CSS", description: "Inlined above-the-fold styles", kept: true, deltaMs: -260, deltaPct: -10.8 },
    { name: "Preload thumbnails", kept: false, deltaMs: 150, deltaPct: 6.2 },
  ]);
  assert.equal(payload.results.northStar, "lcp");
  assert.deepEqual(payload.results.baseline, RESULTS.baseline);

  // An iteration's `notes` is where the skill puts everything specific to the
  // repo, so it must not travel with the trace — and neither may anything that
  // looks like a tool transcript.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["notes", "shell.tsx", "tool", "stdout", "messages"]) {
    assert.equal(serialized.includes(forbidden), false, `the trace payload carries ${forbidden}`);
  }
});

test("a session that captured no reasoning is not asked and posts nothing", async () => {
  const setup = harness({ answers: { "Submit the chain of thought": true }, blocks: [] });
  const outcome = await run(setup);

  assert.equal(setup.asked.some((entry) => entry.prompt.startsWith("Submit the chain")), false);
  assert.equal(outcome.traceSubmitted, false);
  assert.deepEqual(setup.posts, []);
});

test("a non-interactive run answers nothing and submits nothing", async () => {
  const setup = harness({ answers: { "Submit the chain of thought": true } });
  try {
    const outcome = await runEndScreen({
      results: RESULTS,
      state: STATE,
      paths: setup.paths,
      io: setup.io,
      interactive: false,
    });
    assert.deepEqual(outcome, { loopMore: false, resultsSubmitted: false, traceSubmitted: false });
    assert.deepEqual(setup.asked, []);
    assert.deepEqual(setup.posts, []);
  } finally {
    setup.restore();
  }
});
