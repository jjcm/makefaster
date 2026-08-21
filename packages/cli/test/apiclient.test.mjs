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
  missStreak: 5,
  stoppedReason: "miss-streak",
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
    lcpRaw: 1750,
    lcpDelta: -27.1, // (1750-2400)/2400
    ttiRaw: 3050,
    ttiDelta: -21.8,
    name: "Example",
    favicon: "https://example.com/favicon.ico",
  });
  const warm = payloads.find((p) => p.mode === "warm");
  assert.equal(warm.lcpDelta, -29.1);
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
