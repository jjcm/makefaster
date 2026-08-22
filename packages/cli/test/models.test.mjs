import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAMILY_BEST,
  MAX_RECOMMENDATIONS,
  parseCursorModelList,
  benchmarkFamily,
  benchmarkScore,
  defaultModelFor,
  modelsForProvider,
  resolveModel,
} from "../lib/models.js";

test("FAMILY_BEST matches the CursorBench 3.2 snapshot best-per-family scores", () => {
  // Straight from CURSOR_BENCHMARKS in jjcm/bb-plugin-autorouter/benchmarks.ts.
  const expected = {
    "claude-fable-5": 70.5,
    "gpt-5.6-sol": 67.2,
    "gpt-5.6-terra": 64.9,
    "claude-opus-4-8": 62.3,
    "claude-sonnet-5": 61.5,
    "gpt-5.6-luna": 61.1,
    "grok-4.5": 60.03,
    "gpt-5.5": 58.4,
    "composer-2.5": 56.1,
  };
  assert.deepEqual(Object.fromEntries([...FAMILY_BEST].map(([family, best]) => [family, best.score])), expected);
});

test("benchmarkFamily prefers the longest matching family", () => {
  assert.equal(benchmarkFamily("claude-fable-5-thinking-medium"), "claude-fable-5");
  assert.equal(benchmarkFamily("claude-opus-4-8[1m]"), "claude-opus-4-8");
  assert.equal(benchmarkFamily("claude-opus-4-8-thinking-medium"), "claude-opus-4-8");
  assert.equal(benchmarkFamily("gpt-5.6-sol-medium"), "gpt-5.6-sol");
  assert.equal(benchmarkFamily("cursor-grok-4.5-high"), "grok-4.5");
  assert.equal(benchmarkScore("gpt-5.6-terra-medium"), 64.9);
  // Families the snapshot never scored stay unscored rather than guessing.
  assert.equal(benchmarkFamily("claude-opus-5[1m]"), null);
  assert.equal(benchmarkFamily("claude-opus-5-thinking-medium"), null);
  assert.equal(benchmarkFamily("cursor-grok-4.6-medium"), null);
  assert.equal(benchmarkFamily("gpt-5.2"), null);
  assert.equal(benchmarkScore("gpt-5.2"), null);
});

test("no provider offers more than five, and none offers a duplicate", () => {
  for (const key of ["cursor", "claude", "codex"]) {
    const models = modelsForProvider(key);
    assert.ok(models.length <= MAX_RECOMMENDATIONS, `${key}: ${models.length}`);
    assert.equal(new Set(models.map((m) => m.id)).size, models.length, `${key} has duplicate ids`);
  }
  assert.deepEqual(modelsForProvider("nope"), []);
});

test("models sort by CursorBench score, unscored last", () => {
  for (const key of ["cursor", "claude", "codex"]) {
    const models = modelsForProvider(key);
    const scored = models.filter((m) => m.score !== null);
    const unscored = models.filter((m) => m.score === null);
    // Every scored model precedes every unscored one.
    assert.deepEqual(models.slice(0, scored.length), scored, key);
    assert.deepEqual(models.slice(scored.length), unscored, key);
    for (let i = 1; i < scored.length; i++) {
      assert.ok(scored[i - 1].score >= scored[i].score, `${key}: ${scored[i - 1].id} should outrank ${scored[i].id}`);
    }
  }
});

test("Cursor offers the snapshot's top five families as effort variants", () => {
  // Cursor ids are family + reasoning effort (+ optional -fast); bb's primaries
  // pin medium. These are all real ids from `cursor-agent --list-models`.
  assert.deepEqual(modelsForProvider("cursor").map((m) => m.id), [
    "claude-fable-5-thinking-medium",
    "gpt-5.6-sol-medium",
    "gpt-5.6-terra-medium",
    "claude-opus-4-8-thinking-medium",
    "claude-sonnet-5-thinking-medium",
  ]);
  assert.deepEqual(modelsForProvider("cursor").map((m) => m.score), [70.5, 67.2, 64.9, 62.3, 61.5]);
  // Newer-than-snapshot primaries exist as candidates but cannot displace a
  // scored model on a score they do not have.
  for (const model of modelsForProvider("cursor")) assert.notEqual(model.id, "claude-opus-5-thinking-medium");
});

test("Claude Code is bb's curated five: three ranked, two unranked", () => {
  const models = modelsForProvider("claude");
  assert.equal(models.length, 5);
  assert.deepEqual(models.map((m) => m.id), [
    "claude-fable-5",
    "claude-opus-4-8[1m]",
    "claude-sonnet-5",
    "claude-opus-5[1m]",
    "claude-opus-4-7[1m]",
  ]);
  assert.deepEqual(models.map((m) => m.score), [70.5, 62.3, 61.5, null, null]);
  for (const model of models) assert.match(model.id, /^claude-/);
  // Claude ids carry no effort suffix — reasoning is a separate field — and a
  // bracketed context parameter is part of the id.
  for (const model of models) assert.doesNotMatch(model.id, /-(?:low|medium|high|xhigh|max)$/);
  assert.ok(models.some((m) => m.id.includes("[1m]")));
  for (const model of models.slice(3)) assert.match(model.detail, /not in the CursorBench 3\.2 snapshot/);
});

test("Codex shows the four scored families and does not invent a fifth", () => {
  const models = modelsForProvider("codex");
  assert.deepEqual(models.map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.deepEqual(models.map((m) => m.score), [67.2, 64.9, 61.1, 58.4]);
  for (const model of models) assert.match(model.id, /^gpt-/);
});

test("a live model list fills Codex's fifth slot instead of a guess", () => {
  const live = [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
    { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
    { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" },
    { id: "gpt-5.5", displayName: "GPT-5.5" },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
  ];
  const models = modelsForProvider("codex", { live });
  assert.equal(models.length, 5);
  assert.equal(models[4].id, "gpt-5.2");
  assert.equal(models[4].score, null);
  assert.equal(models[4].label, "GPT-5.2");
});

test("a live list drops catalog ids the account cannot run", () => {
  // An account without Fable access must not be offered Fable.
  const live = [
    { id: "gpt-5.6-sol-medium", displayName: "GPT-5.6 Sol" },
    { id: "claude-sonnet-5-thinking-medium", displayName: "Claude Sonnet 5 Thinking" },
    { id: "cursor-grok-4.6-medium", displayName: "Cursor Grok 4.6" },
  ];
  const models = modelsForProvider("cursor", { live });
  assert.deepEqual(models.map((m) => m.id), ["gpt-5.6-sol-medium", "claude-sonnet-5-thinking-medium", "cursor-grok-4.6-medium"]);
  assert.equal(models.at(-1).score, null, "grok 4.6 is newer than the snapshot");
});

test("an empty live list is treated as no answer, not as no models", () => {
  assert.deepEqual(modelsForProvider("codex", { live: [] }).map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.deepEqual(modelsForProvider("codex", { live: null }).map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
});

test("the score is labelled as the family's best, not as this variant's own", () => {
  // The snapshot scores family x effort pairs; the ids pin medium effort, so
  // claiming "@ max" next to them would misread as this variant's score.
  const fable = modelsForProvider("cursor")[0];
  assert.equal(fable.detail, "CursorBench 70.5 — best for claude-fable-5");
  assert.doesNotMatch(fable.detail, /@ max/);
});

test("the picker default is the top-intelligence model", () => {
  assert.equal(defaultModelFor("cursor").id, "claude-fable-5-thinking-medium");
  assert.equal(defaultModelFor("claude").id, "claude-fable-5");
  assert.equal(defaultModelFor("codex").id, "gpt-5.6-sol");
  for (const key of ["cursor", "claude", "codex"]) {
    assert.equal(defaultModelFor(key).score, Math.max(...modelsForProvider(key).map((m) => m.score ?? -1)));
  }
});

test("resolveModel matches the catalog and passes anything else through", () => {
  const known = resolveModel("codex", "GPT-5.6-Sol");
  assert.equal(known.id, "gpt-5.6-sol");
  assert.equal(known.score, 67.2);
  assert.ok(!known.passthrough);

  const unknown = resolveModel("codex", "gpt-6-imaginary");
  assert.equal(unknown.id, "gpt-6-imaginary");
  assert.equal(unknown.score, null);
  assert.equal(unknown.passthrough, true);

  // A passthrough id from a scored family still shows its score.
  const scoredPassthrough = resolveModel("cursor", "claude-fable-5-max");
  assert.equal(scoredPassthrough.passthrough, true);
  assert.equal(scoredPassthrough.score, 70.5);

  assert.equal(resolveModel("cursor", "   "), null);
});

test("parseCursorModelList reads `id - Display Name` and skips the router", () => {
  const output = [
    "Available models",
    "",
    "auto - Auto (default)",
    "claude-fable-5-thinking-medium - Claude Fable 5 1M Medium Thinking (NO ZDR)",
    "gpt-5.6-sol-medium - GPT-5.6 Sol 1M",
    "claude-opus-4-8[1m] - Opus 4.8 bracketed",
    "",
    "Tip: use --model <id> to switch.",
  ].join("\n");
  assert.deepEqual(parseCursorModelList(output), [
    { id: "claude-fable-5-thinking-medium", displayName: "Claude Fable 5 1M Medium Thinking (NO ZDR)" },
    { id: "gpt-5.6-sol-medium", displayName: "GPT-5.6 Sol 1M" },
    { id: "claude-opus-4-8[1m]", displayName: "Opus 4.8 bracketed" },
  ]);
  assert.deepEqual(parseCursorModelList(""), []);
});
