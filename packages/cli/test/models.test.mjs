import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAMILY_BEST,
  MAX_RECOMMENDATIONS,
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
  assert.equal(benchmarkFamily("claude-fable-5-max"), "claude-fable-5");
  assert.equal(benchmarkFamily("claude-opus-4-8[1m]"), "claude-opus-4-8");
  assert.equal(benchmarkFamily("gpt-5.6-sol-max"), "gpt-5.6-sol");
  assert.equal(benchmarkFamily("cursor-grok-4.5-high"), "grok-4.5");
  assert.equal(benchmarkScore("gpt-5.6-terra-max"), 64.9);
  // Families the snapshot never scored stay unscored rather than guessing.
  assert.equal(benchmarkFamily("claude-opus-5[1m]"), null);
  assert.equal(benchmarkFamily("gpt-5.2"), null);
  assert.equal(benchmarkScore("gpt-5.2"), null);
});

test("every provider offers five models and never more", () => {
  for (const key of ["cursor", "claude", "codex"]) {
    const models = modelsForProvider(key);
    assert.equal(models.length, MAX_RECOMMENDATIONS, key);
    assert.equal(new Set(models.map((m) => m.id)).size, MAX_RECOMMENDATIONS, `${key} has duplicate ids`);
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

test("Cursor offers the snapshot's top five families", () => {
  assert.deepEqual(modelsForProvider("cursor").map((m) => m.id), [
    "claude-fable-5-max",
    "gpt-5.6-sol-max",
    "gpt-5.6-terra-max",
    "claude-opus-4-8-max",
    "claude-sonnet-5-max",
  ]);
  assert.deepEqual(modelsForProvider("cursor").map((m) => m.score), [70.5, 67.2, 64.9, 62.3, 61.5]);
});

test("Claude Code offers Anthropic only: three ranked, two unranked", () => {
  const models = modelsForProvider("claude");
  assert.deepEqual(models.map((m) => m.id), [
    "claude-fable-5",
    "claude-opus-4-8[1m]",
    "claude-sonnet-5",
    "claude-opus-5[1m]",
    "claude-opus-4-7[1m]",
  ]);
  assert.deepEqual(models.map((m) => m.score), [70.5, 62.3, 61.5, null, null]);
  for (const model of models) assert.match(model.id, /^claude-/);
  for (const model of models.slice(3)) assert.match(model.detail, /not in the CursorBench 3\.2 snapshot/);
});

test("Codex offers OpenAI only: four ranked, one unranked", () => {
  const models = modelsForProvider("codex");
  assert.deepEqual(models.map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"]);
  assert.deepEqual(models.map((m) => m.score), [67.2, 64.9, 61.1, 58.4, null]);
  for (const model of models) assert.match(model.id, /^gpt-/);
});

test("the picker default is the top-intelligence model", () => {
  assert.equal(defaultModelFor("cursor").id, "claude-fable-5-max");
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
  const scoredPassthrough = resolveModel("cursor", "claude-fable-5-thinking-high");
  assert.equal(scoredPassthrough.passthrough, true);
  assert.equal(scoredPassthrough.score, 70.5);

  assert.equal(resolveModel("cursor", "   "), null);
});
