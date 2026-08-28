import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continuePrompt, kickoffPrompt, prepareSession, runPlan, sessionPaths } from "../lib/session.js";

const provider = { key: "cursor", displayName: "Cursor Agent" };
const model = { id: "claude-fable-5-thinking-medium", label: "Claude Fable 5 (thinking)" };

function checklist(n) {
  return Array.from({ length: n }, (_, i) => ({ rank: i + 1, name: `Category ${i + 1}` }));
}

// The board decides how long the run is. The only number makefaster contributes
// is the extras budget.
test("runPlan is the imported checklist plus the extras, whatever the board's size", () => {
  assert.deepEqual(runPlan(checklist(24), 5), { checklistCount: 24, extrasBudget: 5, plannedRuns: 29 });
  assert.deepEqual(runPlan(checklist(50), 5), { checklistCount: 50, extrasBudget: 5, plannedRuns: 55 });
  assert.deepEqual(runPlan(checklist(24), 0), { checklistCount: 24, extrasBudget: 0, plannedRuns: 24 });
});

// An empty board is N = 0, not a reason to invent a length.
test("runPlan on an empty checklist is just the extras", () => {
  assert.deepEqual(runPlan([], 5), { checklistCount: 0, extrasBudget: 5, plannedRuns: 5 });
  assert.deepEqual(runPlan(null, 5), { checklistCount: 0, extrasBudget: 5, plannedRuns: 5 });
});

test("prepareSession writes the plan into state.json and carries no miss limit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "makefaster-session-"));
  const { state } = prepareSession({
    cwd,
    provider,
    model,
    checklist: checklist(24),
    checklistSource: "https://makefaster.dev/data/improvements.json",
    apiBase: "https://makefaster.dev",
    extras: 5,
    siteUrl: null,
  });

  assert.equal(state.checklistCount, 24);
  assert.equal(state.extrasBudget, 5);
  assert.equal(state.plannedRuns, 29);
  assert.equal("maxMisses" in state, false);
  assert.equal("missStreak" in state, false);

  const onDisk = JSON.parse(readFileSync(sessionPaths(cwd).state, "utf8"));
  assert.equal(onDisk.plannedRuns, 29);
  assert.equal(onDisk.provider, "cursor");
  assert.equal(onDisk.model, "claude-fable-5-thinking-medium");

  // The checklist the agent reads is the one the plan was counted from.
  const imported = JSON.parse(readFileSync(sessionPaths(cwd).improvements, "utf8"));
  assert.equal(imported.categories.length, 24);
});

// The prompt is where the model learns the size of the job. A model told "29
// iterations" does not treat iteration 5 as a natural place to stop.
test("the prompts name the whole run and forbid an early stop", () => {
  for (const prompt of [
    kickoffPrompt(runPlan(checklist(24), 5)),
    continuePrompt(runPlan(checklist(24), 5)),
  ]) {
    assert.match(prompt, /24 imported checklist categories/);
    assert.match(prompt, /up to 5 hypotheses of your own/);
    assert.match(prompt, /up to 29 measured iterations/);
    assert.match(prompt, /no early stop and no miss limit/);
    assert.doesNotMatch(prompt, /missStreak|maxMisses/);
  }
});

test("the kickoff prompt puts the checklist before the extras, and says a skip is not a run", () => {
  const prompt = kickoffPrompt(runPlan(checklist(24), 5));
  assert.match(prompt, /EVERY category/);
  assert.match(prompt, /a skip is not an iteration/);
  assert.ok(prompt.indexOf("rank order") < prompt.indexOf("hypotheses of your own"));
});

test("an empty board is described as extras-only rather than as a 0-run session", () => {
  const prompt = kickoffPrompt(runPlan([], 5));
  assert.match(prompt, /checklist came back empty/);
  assert.match(prompt, /up to 5 hypotheses of your own/);
});
