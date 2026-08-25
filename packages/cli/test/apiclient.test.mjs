import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API_BASE,
  buildImprovementsPayload,
  buildSitePayloads,
  resolveApiBase,
} from "../lib/apiClient.js";

const RESULTS = {
  version: 1,
  site: { url: "example.com", name: "Example", favicon: "https://example.com/favicon.ico" },
  northStar: "lcp",
  baseline: {
    cold: { lcpMs: 2400, ttiMs: 3900, fcpMs: 1400 },
    warm: { lcpMs: 1100, ttiMs: 1700 },
  },
  final: {
    cold: { lcpMs: 1750, ttiMs: 3050, fcpMs: 1150 },
    warm: { lcpMs: 780, ttiMs: 1240 },
  },
  iterations: [
    { n: 1, name: "Inline critical CSS", description: "Inlined above-the-fold styles", category: "Inline Critical CSS", deltaMs: -260, deltaPct: -10.8, kept: true },
    { n: 2, name: "Preload thumbnails", description: "Preload first grid images", category: "Resource Preloading", deltaMs: 150, deltaPct: 6.2, kept: false },
    { n: 3, name: "Subset fonts", description: "Only ship used glyphs", category: "Font Subsetting", deltaMs: -90, deltaPct: -4.1, kept: true },
    { n: 4, name: "No-delta oddity", description: "kept but no numbers", kept: true },
  ],
  stoppedReason: "checklist-complete",
};

test("resolveApiBase: flag > env > default, trailing slash stripped", () => {
  assert.equal(resolveApiBase({ flag: "https://x.dev/", env: { MAKEFASTER_API_BASE: "https://y.dev" } }), "https://x.dev");
  assert.equal(resolveApiBase({ env: { MAKEFASTER_API_BASE: "https://y.dev/" } }), "https://y.dev");
  assert.equal(resolveApiBase({ env: {} }), DEFAULT_API_BASE);
});

test("buildSitePayloads produces one payload per complete mode with computed deltas", () => {
  const payloads = buildSitePayloads(RESULTS, "example.com");
  assert.equal(payloads.length, 2);
  const cold = payloads.find((p) => p.mode === "cold");
  assert.deepEqual(cold, {
    url: "example.com",
    mode: "cold",
    lcpBefore: 2400,
    lcpRaw: 1750,
    lcpDelta: -27.1, // (1750-2400)/2400
    ttiBefore: 3900,
    ttiRaw: 3050,
    ttiDelta: -21.8,
    name: "Example",
    favicon: "https://example.com/favicon.ico",
    // Three keeps, none of them classified, so all three count as generic —
    // see the keep-split test below.
    genericKeepPct: 100,
    siteSpecificKeepPct: 0,
  });
  const warm = payloads.find((p) => p.mode === "warm");
  assert.equal(warm.lcpDelta, -29.1);
  assert.equal(warm.lcpBefore, 1100);
  assert.equal(warm.ttiBefore, 1700);
});

test("buildSitePayloads skips incomplete modes and zero baselines", () => {
  const onlyCold = buildSitePayloads({
    baseline: { cold: { lcpMs: 1000, ttiMs: 2000 }, warm: { lcpMs: 500 } },
    final: { cold: { lcpMs: 900, ttiMs: 1800 }, warm: { lcpMs: 400, ttiMs: 800 } },
  }, "example.com");
  assert.equal(onlyCold.length, 1);
  assert.equal(onlyCold[0].mode, "cold");

  const zeroBase = buildSitePayloads({
    baseline: { cold: { lcpMs: 0, ttiMs: 2000 } },
    final: { cold: { lcpMs: 900, ttiMs: 1800 } },
  }, "example.com");
  assert.equal(zeroBase.length, 0);

  assert.equal(buildSitePayloads(null, "example.com").length, 0);
});

test("buildSitePayloads sends the pull request the run was opened as", () => {
  const withPr = { ...RESULTS, site: { ...RESULTS.site, prUrl: "  https://github.com/jjcm/n8n/pull/1  " } };
  for (const payload of buildSitePayloads(withPr, "example.com")) {
    assert.equal(payload.prUrl, "https://github.com/jjcm/n8n/pull/1");
  }

  // `pr` is read too, and a value that is not an http(s) URL is dropped rather
  // than submitted and rejected.
  const shortField = { ...RESULTS, site: { ...RESULTS.site, pr: "https://github.com/jjcm/dify/pull/1" } };
  assert.equal(buildSitePayloads(shortField, "example.com")[0].prUrl, "https://github.com/jjcm/dify/pull/1");

  const bogus = { ...RESULTS, site: { ...RESULTS.site, prUrl: "javascript:alert(1)" } };
  assert.equal("prUrl" in buildSitePayloads(bogus, "example.com")[0], false);

  // A results.json written before the field existed still submits.
  assert.equal("prUrl" in buildSitePayloads(RESULTS, "example.com")[0], false);
});

test("buildSitePayloads reports how many keeps were reusable techniques", () => {
  // RESULTS keeps three iterations and says nothing about any of them, which is
  // every session written before the field existed: all of them count as
  // generic, because all of them are submitted to the improvement board.
  assert.equal(buildSitePayloads(RESULTS, "example.com")[0].genericKeepPct, 100);
  assert.equal(buildSitePayloads(RESULTS, "example.com")[0].siteSpecificKeepPct, 0);

  const mixed = {
    ...RESULTS,
    iterations: [
      { n: 1, name: "Enable gzip", generic: true, deltaMs: -300, kept: true },
      { n: 2, name: "Lazy-load components", generic: true, deltaMs: -200, kept: true },
      { n: 3, name: "Reduce font payload", generic: true, deltaMs: -100, kept: true },
      { n: 4, name: "Stop gating first paint on the flag client", generic: true, deltaMs: -90, kept: true },
      { n: 5, name: "Drop a duplicated product query", generic: false, deltaMs: -80, kept: true },
      // Reverts are not keeps, so they are not in the split at all.
      { n: 6, name: "Preload thumbnails", deltaMs: 120, kept: false },
    ],
  };
  const split = buildSitePayloads(mixed, "example.com")[0];
  assert.equal(split.genericKeepPct, 80);
  assert.equal(split.siteSpecificKeepPct, 20);

  // A run that kept nothing has no split to report.
  const noKeeps = { ...RESULTS, iterations: [{ n: 1, name: "Preload thumbnails", deltaMs: 120, kept: false }] };
  const bare = buildSitePayloads(noKeeps, "example.com")[0];
  assert.equal("genericKeepPct" in bare, false);
  assert.equal("siteSpecificKeepPct" in bare, false);
});

test("buildImprovementsPayload keeps only kept iterations with deltas, anonymously", () => {
  const payload = buildImprovementsPayload(RESULTS);
  assert.equal(payload.improvements.length, 2); // kept:false and no-delta entries dropped
  assert.deepEqual(payload.improvements[0], {
    name: "Inline critical CSS",
    description: "Inlined above-the-fold styles",
    deltaMs: -260,
    deltaPct: -10.8,
  });
  assert.equal(JSON.stringify(payload).includes("example.com"), false, "payload must not leak the site URL");

  assert.equal(buildImprovementsPayload({ iterations: [] }), null);
  assert.equal(buildImprovementsPayload({}), null);
});

test("buildImprovementsPayload leaves site-specific notes on the machine", () => {
  const payload = buildImprovementsPayload({
    iterations: [{
      n: 1,
      name: "Reduce font payload",
      description: "Ship only the font weights and styles the page actually paints",
      category: "Reduce Font Payload",
      notes: "Playfair Display cut from 4 weights x 2 styles in src/styles/fonts.css",
      deltaMs: -260,
      kept: true,
    }],
  });
  assert.deepEqual(payload.improvements[0], {
    name: "Reduce font payload",
    description: "Ship only the font weights and styles the page actually paints",
    deltaMs: -260,
  });
  assert.equal(JSON.stringify(payload).includes("Playfair"), false, "notes must not be submitted");
});

test("buildImprovementsPayload leaves site-specific findings off the shared board", () => {
  const payload = buildImprovementsPayload({
    iterations: [
      { n: 1, name: "Enable gzip", generic: true, deltaMs: -300, kept: true },
      { n: 2, name: "Stop double-rendering the pricing widget", generic: false, deltaMs: -120, kept: true },
      // No classification: submitted, the way every older session was.
      { n: 3, name: "Reduce font payload", deltaMs: -90, kept: true },
    ],
  });
  assert.deepEqual(payload.improvements.map((i) => i.name), ["Enable gzip", "Reduce font payload"]);

  // A run whose only keep was site-specific submits nothing at all.
  assert.equal(
    buildImprovementsPayload({
      iterations: [{ n: 1, name: "Stop double-rendering the pricing widget", generic: false, deltaMs: -120, kept: true }],
    }),
    null
  );
});
