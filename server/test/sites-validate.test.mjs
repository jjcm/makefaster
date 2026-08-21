import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSiteUrl, upsertSite, displayNameForUrl, defaultFaviconForUrl } from "../lib/sites.mjs";
import { validateSitePayload, validateImprovementsPayload } from "../lib/validate.mjs";

test("normalizeSiteUrl accepts common shapes and rejects junk", () => {
  assert.equal(normalizeSiteUrl("example.com"), "example.com");
  assert.equal(normalizeSiteUrl("https://Example.com/some/path?q=1"), "example.com");
  assert.equal(normalizeSiteUrl("www.example.co.uk"), "example.co.uk");
  assert.equal(normalizeSiteUrl("http://sub.domain.dev"), "sub.domain.dev");
  assert.equal(normalizeSiteUrl("localhost"), null);
  assert.equal(normalizeSiteUrl("not a url"), null);
  assert.equal(normalizeSiteUrl(""), null);
  assert.equal(normalizeSiteUrl(42), null);
  assert.equal(normalizeSiteUrl("javascript:alert(1)"), null);
});

test("displayNameForUrl and defaultFaviconForUrl", () => {
  assert.equal(displayNameForUrl("docs.example.com"), "Example");
  assert.equal(displayNameForUrl("jjcm.org"), "Jjcm");
  assert.equal(defaultFaviconForUrl("example.com"), "https://icons.duckduckgo.com/ip3/example.com.ico");
});

test("upsertSite inserts a new row with tests=1 and derived name/favicon", () => {
  const { rows, row, created } = upsertSite([], {
    url: "example.com", mode: "cold", lcpRaw: 1200, lcpDelta: -20, ttiRaw: 2000, ttiDelta: -15,
  }, "2026-08-21T00:00:00.000Z");
  assert.equal(created, true);
  assert.equal(rows.length, 1);
  assert.equal(row.tests, 1);
  assert.equal(row.name, "Example");
  assert.equal(row.favicon, "https://icons.duckduckgo.com/ip3/example.com.ico");
  assert.equal(row.measuredAt, "2026-08-21T00:00:00.000Z");
});

test("upsertSite updates the (url, mode) row, increments tests, keeps other modes", () => {
  const seed = [
    { name: "Example", url: "example.com", favicon: "x", lcpRaw: 1500, lcpDelta: -10, ttiRaw: 2500, ttiDelta: -5, mode: "cold", tests: 3, measuredAt: "old" },
    { name: "Example", url: "example.com", favicon: "x", lcpRaw: 900, lcpDelta: -12, ttiRaw: 1500, ttiDelta: -9, mode: "warm", tests: 3, measuredAt: "old" },
  ];
  const { rows, row, created } = upsertSite(seed, {
    url: "example.com", mode: "cold", lcpRaw: 1100, lcpDelta: -25, ttiRaw: 2100, ttiDelta: -18,
  }, "2026-08-21T00:00:00.000Z");
  assert.equal(created, false);
  assert.equal(rows.length, 2);
  assert.equal(row.tests, 4);
  assert.equal(row.lcpRaw, 1100);
  assert.equal(row.favicon, "x"); // kept from the existing row
  assert.equal(rows.find((r) => r.mode === "warm").tests, 3); // untouched
  assert.equal(seed[0].tests, 3); // input not mutated
});

test("validateSitePayload happy path normalizes and rounds", () => {
  const result = validateSitePayload({
    url: "https://Example.com/x", mode: "warm",
    lcpRaw: 1200.6, lcpDelta: -20.34, ttiRaw: 2000.2, ttiDelta: -15.56,
    favicon: "https://example.com/favicon.ico", name: "  Example  ",
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value, {
    url: "example.com", mode: "warm",
    lcpRaw: 1201, lcpDelta: -20.3, ttiRaw: 2000, ttiDelta: -15.6,
    favicon: "https://example.com/favicon.ico", name: "Example",
  });
});

test("validateSitePayload rejects bad payloads with reasons", () => {
  for (const [payload, needle] of [
    [null, "object"],
    [{ url: "nope", mode: "cold", lcpRaw: 1, lcpDelta: 0, ttiRaw: 1, ttiDelta: 0 }, "url"],
    [{ url: "example.com", mode: "hot", lcpRaw: 1, lcpDelta: 0, ttiRaw: 1, ttiDelta: 0 }, "mode"],
    [{ url: "example.com", mode: "cold", lcpRaw: -5, lcpDelta: 0, ttiRaw: 1, ttiDelta: 0 }, "lcpRaw"],
    [{ url: "example.com", mode: "cold", lcpRaw: 1, lcpDelta: -200, ttiRaw: 1, ttiDelta: 0 }, "lcpDelta"],
    [{ url: "example.com", mode: "cold", lcpRaw: 1, lcpDelta: 0, ttiRaw: 1, ttiDelta: 0, favicon: "ftp://x" }, "favicon"],
  ]) {
    const result = validateSitePayload(payload);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes(needle)), `expected an error about ${needle}, got: ${result.errors}`);
  }
});

test("validateImprovementsPayload happy path trims and strips any url field", () => {
  const result = validateImprovementsPayload({
    url: "should-be-discarded.example.com",
    improvements: [
      { name: "  Inline critical CSS  ", description: "Inlined above-the-fold styles", deltaMs: -120, deltaPct: -8.5 },
      { name: "Preload LCP image", deltaPct: -3 },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].name, "Inline critical CSS");
  assert.equal(result.value[1].description, "");
  assert.equal(result.value[1].deltaMs, undefined);
  for (const entry of result.value) assert.equal("url" in entry, false);
});

test("validateImprovementsPayload rejects bad payloads", () => {
  for (const [payload, needle] of [
    [{}, "non-empty array"],
    [{ improvements: [] }, "non-empty array"],
    [{ improvements: [{ description: "no name", deltaMs: -1 }] }, "name"],
    [{ improvements: [{ name: "x", deltaMs: Infinity }] }, "deltaMs"],
    [{ improvements: [{ name: "x" }] }, "at least one"],
    [{ improvements: Array.from({ length: 51 }, (_, i) => ({ name: `n${i}`, deltaMs: -1 })) }, "capped"],
  ]) {
    const result = validateImprovementsPayload(payload);
    assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(payload).slice(0, 80)}`);
    assert.ok(result.errors.some((e) => e.includes(needle)), `expected an error about "${needle}", got: ${result.errors}`);
  }
});
