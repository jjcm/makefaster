import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The operational skill is the launch site for every Lighthouse cold/warm run:
// prepareSession copies it into .makefaster/SKILL.md and every provider's agent
// follows it verbatim. These tests pin the browser-isolation contract — the
// measurement browser is a dedicated headless Chrome with its own profile,
// never the user's everyday browser — so a future edit cannot quietly put
// Lighthouse tabs back into the user's open Chrome.
const SKILL_PATH = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  "packages", "skill", "SKILL.md",
);
const SKILL = readFileSync(SKILL_PATH, "utf8");

test("the Lighthouse launch site pins a dedicated headless Chrome with an isolated profile", () => {
  const chromeFlags = [...SKILL.matchAll(/--chrome-flags="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(chromeFlags.length > 0, "the skill must spell out the Lighthouse chrome-flags");
  for (const flags of chromeFlags) {
    assert.ok(flags.includes("--headless=new"), `headless is mandatory, got: ${flags}`);
    assert.match(flags, /--user-data-dir=\S*\.makefaster\//, `an isolated profile dir is mandatory, got: ${flags}`);
    assert.ok(flags.includes("--no-first-run"), `--no-first-run is mandatory, got: ${flags}`);
    assert.ok(flags.includes("--no-default-browser-check"), `--no-default-browser-check is mandatory, got: ${flags}`);
  }
});

test("the skill never reuses an existing Chrome debugging port or the user's profile", () => {
  // No example anywhere in the document may attach to an already-running
  // Chrome — that is exactly how measurement tabs end up in the user's browser.
  assert.doesNotMatch(SKILL, /lighthouse[^\n]*--port=\d/, "no Lighthouse example may attach by port");
  assert.match(SKILL, /[Nn]ever pass `--port`/, "the port-reuse ban must be explicit");
  assert.match(
    SKILL,
    /never `connect` or\s+`connectOverCDP` to a browser you did not start/,
    "the Playwright/Puppeteer path must launch its own browser, not connect to the user's",
  );
  assert.match(
    SKILL,
    /must never attach to the user's everyday Chrome/,
    "the isolation requirement must be stated as a rule, not implied",
  );
});

test("CHROME_PATH still means our own headless launch with our own profile", () => {
  assert.match(
    SKILL,
    /`CHROME_PATH`[^]*?still launch it headless with\s+the isolated `--user-data-dir`/,
    "CHROME_PATH picks the binary; it must never mean reusing the user's session",
  );
});

test("the isolation rule covers every measurement, cold and warm, baseline and re-measure", () => {
  assert.match(SKILL, /cold and warm alike, baseline and re-measure alike/);
});
