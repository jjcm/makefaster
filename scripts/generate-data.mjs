#!/usr/bin/env node
/**
 * Generates a synthetic pair of leaderboard files in the shapes the boards use:
 *
 *   sites.json         — site leaderboard rows
 *   improvements.json  — improvement-category leaderboard rows
 *
 * Deterministic (seeded PRNG) so re-running produces identical output. See
 * frontend/js/api.js for the payload contracts.
 *
 * The rows are invented, so they are only ever useful for filling a local
 * development database or eyeballing the SPA with a full board. The public
 * leaderboards carry real submissions only: the committed seed in data/ is
 * empty, and this script refuses to write there so a regeneration cannot put
 * demo sites back on the live site.
 *
 * Usage: node scripts/generate-data.mjs --out-dir <dir>
 *   Then point the server at it: SEED_DIR=<dir> ./run.sh
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED_SEED_DIR = resolve(ROOT, "data");

function parseOutDir(argv) {
  const flag = argv.indexOf("--out-dir");
  const value = flag === -1 ? null : argv[flag + 1];
  if (!value) {
    console.error("usage: node scripts/generate-data.mjs --out-dir <dir>");
    process.exit(1);
  }
  const dir = resolve(process.cwd(), value);
  if (dir === COMMITTED_SEED_DIR) {
    console.error(
      "refusing to write to data/: that is the committed public seed, and it is " +
        "empty on purpose so a fresh migrate cannot republish synthetic rows."
    );
    process.exit(1);
  }
  return dir;
}

const OUT_DIR = parseOutDir(process.argv.slice(2));

/* ---------------------------------------------------------------- PRNG */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x4d46_0001); // "MF" 001
const ri = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

/* ---------------------------------------------------------------- sites */

// The ten rows visible in the design render, verbatim (cold-load numbers).
const HERO_SITES = [
  { name: "Google",             url: "google.com",   lcpRaw: 1842, lcpDelta: -34, ttiRaw: 2945, ttiDelta: -29 },
  { name: "Shopify",            url: "shopify.com",  lcpRaw: 1621, lcpDelta: -28, ttiRaw: 2487, ttiDelta: -24 },
  { name: "GitHub",             url: "github.com",   lcpRaw: 1256, lcpDelta: -31, ttiRaw: 2103, ttiDelta: -26 },
  { name: "Netflix",            url: "netflix.com",  lcpRaw: 2341, lcpDelta: -36, ttiRaw: 3612, ttiDelta: -32 },
  { name: "Medium",             url: "medium.com",   lcpRaw: 1402, lcpDelta: -27, ttiRaw: 2198, ttiDelta: -21 },
  { name: "Airbnb",             url: "airbnb.com",   lcpRaw: 1897, lcpDelta: -33, ttiRaw: 2901, ttiDelta: -28 },
  { name: "X",                  url: "x.com",        lcpRaw: 2102, lcpDelta: -30, ttiRaw: 3145, ttiDelta: -27 },
  { name: "The New York Times", url: "nytimes.com",  lcpRaw: 2356, lcpDelta: -35, ttiRaw: 3842, ttiDelta: -31 },
  { name: "YouTube",            url: "youtube.com",  lcpRaw: 1753, lcpDelta: -29, ttiRaw: 2653, ttiDelta: -25 },
  { name: "Linkedin",           url: "linkedin.com", lcpRaw: 1533, lcpDelta: -26, ttiRaw: 2365, ttiDelta: -22 },
];

const REAL_DOMAINS = [
  "wikipedia.org", "amazon.com", "reddit.com", "stackoverflow.com", "twitch.tv",
  "spotify.com", "apple.com", "microsoft.com", "cloudflare.com", "vercel.com",
  "stripe.com", "figma.com", "notion.so", "slack.com", "zoom.us",
  "dropbox.com", "adobe.com", "salesforce.com", "atlassian.com", "gitlab.com",
  "bitbucket.org", "npmjs.com", "mozilla.org", "web.dev", "smashingmagazine.com",
  "css-tricks.com", "dev.to", "hashnode.com", "substack.com", "ghost.org",
  "wordpress.com", "squarespace.com", "wix.com", "webflow.com", "framer.com",
  "canva.com", "dribbble.com", "behance.net", "unsplash.com", "pexels.com",
  "etsy.com", "ebay.com", "walmart.com", "target.com", "bestbuy.com",
  "ikea.com", "nike.com", "adidas.com", "patagonia.com", "rei.com",
  "bbc.com", "cnn.com", "theguardian.com", "reuters.com", "bloomberg.com",
  "wsj.com", "washingtonpost.com", "theatlantic.com", "wired.com", "arstechnica.com",
  "theverge.com", "techcrunch.com", "engadget.com", "vice.com", "vox.com",
  "espn.com", "nba.com", "nfl.com", "mlb.com", "fifa.com",
  "booking.com", "expedia.com", "kayak.com", "tripadvisor.com", "hotels.com",
  "uber.com", "lyft.com", "doordash.com", "instacart.com", "grubhub.com",
  "coinbase.com", "robinhood.com", "paypal.com", "venmo.com", "wise.com",
  "chase.com", "bankofamerica.com", "fidelity.com", "vanguard.com", "schwab.com",
  "duolingo.com", "khanacademy.org", "coursera.org", "udemy.com", "edx.org",
  "codecademy.com", "freecodecamp.org", "leetcode.com", "kaggle.com", "huggingface.co",
  "openai.com", "anthropic.com", "deepmind.google", "nvidia.com", "amd.com",
  "intel.com", "arm.com", "qualcomm.com", "samsung.com", "sony.com",
  "lg.com", "panasonic.com", "philips.com", "bosch.com", "siemens.com",
  "tesla.com", "rivian.com", "ford.com", "gm.com", "toyota.com",
  "honda.com", "bmw.com", "mercedes-benz.com", "volvo.com", "porsche.com",
  "airfrance.com", "delta.com", "united.com", "southwest.com", "ryanair.com",
  "airbnb.co.uk", "vrbo.com", "zillow.com", "redfin.com", "realtor.com",
  "indeed.com", "glassdoor.com", "monster.com", "ziprecruiter.com", "wellfound.com",
  "asana.com", "trello.com", "monday.com", "clickup.com", "linear.app",
  "basecamp.com", "airtable.com", "smartsheet.com", "miro.com", "lucidchart.com",
  "intercom.com", "zendesk.com", "freshworks.com", "hubspot.com", "mailchimp.com",
  "sendgrid.com", "twilio.com", "plaid.com", "square.com", "shopware.com",
  "bigcommerce.com", "magento.com", "woocommerce.com", "prestashop.com", "snipcart.com",
  "netlify.com", "render.com", "railway.app", "fly.io", "heroku.com",
  "digitalocean.com", "linode.com", "vultr.com", "hetzner.com", "ovhcloud.com",
  "aws.amazon.com", "cloud.google.com", "azure.microsoft.com", "oracle.com", "ibm.com",
  "redhat.com", "canonical.com", "suse.com", "docker.com", "kubernetes.io",
  "grafana.com", "datadoghq.com", "newrelic.com", "sentry.io", "pagerduty.com",
  "elastic.co", "mongodb.com", "redis.io", "postgresql.org", "mysql.com",
  "sqlite.org", "supabase.com", "planetscale.com", "neon.tech", "cockroachlabs.com",
  "discord.com", "telegram.org", "signal.org", "whatsapp.com", "messenger.com",
  "pinterest.com", "tumblr.com", "flickr.com", "vimeo.com", "dailymotion.com",
  "soundcloud.com", "bandcamp.com", "last.fm", "genius.com", "pitchfork.com",
  "imdb.com", "rottentomatoes.com", "letterboxd.com", "goodreads.com", "audible.com",
  "steam.com", "epicgames.com", "gog.com", "itch.io", "roblox.com",
  "minecraft.net", "riotgames.com", "blizzard.com", "ea.com", "ubisoft.com",
  "duckduckgo.com", "brave.com", "opera.com", "vivaldi.com", "protonmail.com",
  "fastmail.com", "hey.com", "superhuman.com", "1password.com", "bitwarden.com",
  "lastpass.com", "dashlane.com", "nordvpn.com", "expressvpn.com", "tailscale.com",
];

const WORD_A = [
  "bright", "swift", "north", "ember", "cobalt", "cedar", "atlas", "lumen",
  "vertex", "pixel", "quartz", "harbor", "summit", "meadow", "onyx", "aurora",
  "falcon", "willow", "granite", "juniper", "marble", "orchid", "raven", "sable",
  "tundra", "velvet", "wander", "zephyr", "beacon", "canyon", "drift", "everly",
  "fable", "glacier", "hollow", "indigo", "jasper", "kindle", "latitude", "mosaic",
];

const WORD_B = [
  "labs", "works", "forge", "stack", "grid", "loop", "shift", "craft",
  "metrics", "pulse", "signal", "systems", "studio", "supply", "market", "digital",
  "commerce", "media", "journal", "review", "collective", "foundry", "analytics", "hosting",
  "software", "goods", "outfitters", "kitchen", "travel", "finance", "health", "learning",
];

const TLDS = ["com", "com", "com", "io", "dev", "co", "app", "net", "org"];

function synthesizeDomains(count, taken) {
  const out = [];
  while (out.length < count) {
    const a = pick(WORD_A);
    const b = pick(WORD_B);
    const domain = `${a}${b}.${pick(TLDS)}`;
    if (taken.has(domain)) continue;
    taken.add(domain);
    const name = a[0].toUpperCase() + a.slice(1) + " " + b[0].toUpperCase() + b.slice(1);
    out.push({ name, url: domain });
  }
  return out;
}

const TOTAL_SITES = 1248;
const taken = new Set([...HERO_SITES.map((s) => s.url), ...REAL_DOMAINS]);
const realEntries = REAL_DOMAINS.map((d) => {
  const base = d.split(".")[0];
  const name = base
    .split(/[-.]/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return { name, url: d };
});
const synthetic = synthesizeDomains(TOTAL_SITES - HERO_SITES.length - realEntries.length, taken);

// Measurement window ends at the timestamp shown in the design render.
const WINDOW_END = Date.parse("2024-05-12T14:15:00Z");
const WINDOW_START = Date.parse("2024-02-01T00:00:00Z");

function randomMeasuredAt() {
  const t = WINDOW_START + Math.floor(rand() * (WINDOW_END - WINDOW_START));
  const d = new Date(t);
  d.setUTCSeconds(0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

const favicon = (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`;

const rows = [];

function pushSite(site, { hero = false } = {}) {
  const cold = hero
    ? { lcpRaw: site.lcpRaw, lcpDelta: site.lcpDelta, ttiRaw: site.ttiRaw, ttiDelta: site.ttiDelta }
    : {
        lcpRaw: ri(900, 3400),
        lcpDelta: ri(-38, -26),
        ttiRaw: 0,
        ttiDelta: ri(-34, -22),
      };
  if (!hero) cold.ttiRaw = cold.lcpRaw + ri(500, 1500);

  const warmScale = 0.55 + rand() * 0.2;
  const warm = {
    lcpRaw: Math.round(cold.lcpRaw * warmScale),
    lcpDelta: Math.min(-8, cold.lcpDelta + ri(4, 9)),
    ttiRaw: Math.round(cold.ttiRaw * warmScale),
    ttiDelta: Math.min(-6, cold.ttiDelta + ri(4, 9)),
  };

  const tests = ri(3, 10);
  const measuredAt = hero && site.url === "google.com" ? "2024-05-12T14:15:00Z" : randomMeasuredAt();

  for (const [mode, m] of [["cold", cold], ["warm", warm]]) {
    rows.push({
      name: site.name,
      url: site.url,
      favicon: favicon(site.url),
      lcpRaw: m.lcpRaw,
      lcpDelta: m.lcpDelta,
      ttiRaw: m.ttiRaw,
      ttiDelta: m.ttiDelta,
      mode,
      tests,
      measuredAt,
    });
  }
}

HERO_SITES.forEach((s) => pushSite(s, { hero: true }));
[...realEntries, ...synthetic].forEach((s) => pushSite(s));

/* Calibrate cold averages so the stat cards read exactly -32% / -28%,
   and per-site test counts average exactly 6.4 (as in the design render). */

function calibrate(mode, key, target) {
  const sel = rows.filter((r) => r.mode === mode);
  const heroUrls = new Set(HERO_SITES.map((s) => s.url));
  const adjustable = sel.filter((r) => !heroUrls.has(r.url));
  const sum = () => sel.reduce((a, r) => a + r[key], 0);
  let want = Math.round(target * sel.length);
  let i = 0;
  while (sum() !== want && i < 200000) {
    const r = adjustable[i % adjustable.length];
    const diff = want - sum();
    const step = diff > 0 ? 1 : -1;
    const next = r[key] + step;
    if (next <= -6 && next >= -40) r[key] = next;
    i++;
  }
}

calibrate("cold", "lcpDelta", -32);
calibrate("cold", "ttiDelta", -28);

{
  // tests: average 6.4 across unique sites (cold row is canonical; keep warm in sync)
  const cold = rows.filter((r) => r.mode === "cold");
  const byUrl = new Map(rows.map((r) => [r.url + "|" + r.mode, r]));
  const want = Math.round(6.4 * cold.length);
  const sum = () => cold.reduce((a, r) => a + r.tests, 0);
  let i = 10; // skip hero rows
  while (sum() !== want && i < 200000) {
    const r = cold[10 + (i % (cold.length - 10))];
    const step = want - sum() > 0 ? 1 : -1;
    const next = r.tests + step;
    if (next >= 2 && next <= 12) {
      r.tests = next;
      byUrl.get(r.url + "|warm").tests = next;
    }
    i++;
  }
}

/* --------------------------------------------------------- improvements */

// First twelve verbatim from the design render (rank order = avg improvement).
const IMPROVEMENTS = [
  ["Gzip / Brotli Compression",        "Enable or improve text compression",            286, -28.6, "gzip"],
  ["Tree Shaking",                     "Remove unused JavaScript from bundles",         241, -22.4, "tree"],
  ["Cache Header Improvements",        "Optimize cache control and expiration",         198, -18.7, "clock"],
  ["Image Optimization",               "Compress and resize images",                    312, -17.3, "image"],
  ["Minification",                     "Minify CSS, JS, and HTML",                      275, -14.8, "code"],
  ["CDN Usage",                        "Serve assets via CDN or improve CDN config",    164, -13.2, "cloud"],
  ["Font Optimization",                "Optimize font loading and formats",             127, -11.6, "font"],
  ["Reduce Redirects",                 "Eliminate or consolidate redirect chains",       93,  -9.8, "database"],
  ["Resource Preloading",              "Preload key resources for faster render",        88,  -8.9, "cube"],
  ["Enable Text Compression",          "Compress text-based resources",                 102,  -7.6, "document"],
  ["Remove Unused CSS",                "Remove unused CSS from stylesheets",             76,  -6.3, "bolt"],
  ["HTTP/2+ Optimization",             "Improve connection usage and multiplexing",      59,  -5.1, "sliders"],
  // Seeded from the research labs + common wins, descending impact.
  ["Brotli With Memoized Dictionary",  "Precompute brotli dictionaries for hot paths"],
  ["Embed Boot Payload",               "Inline critical boot data into the initial HTML"],
  ["Cut Critical-Path JavaScript",     "Move non-essential scripts off the boot path"],
  ["Content-Hashed Immutable Assets",  "Fingerprint assets for immutable caching"],
  ["Thumbnail Rung Optimization",      "Serve the smallest sufficient thumbnail rung"],
  ["Skip Redundant Fetches",           "Deduplicate repeated network requests"],
  ["Inline Critical CSS",              "Inline above-the-fold styles into the document"],
  ["Lazy-Load Below-Fold Images",      "Defer offscreen images until needed"],
  ["Preconnect To Required Origins",   "Open early connections to critical origins"],
  ["HTTP/3 / QUIC Migration",          "Upgrade transport to reduce handshake cost"],
  ["Early Hints (103)",                "Start fetching assets before the response"],
  ["AVIF / WebP Image Formats",        "Adopt modern image codecs"],
  ["Responsive srcset Images",         "Serve resolution-appropriate image variants"],
  ["Service Worker Caching",           "Cache shell and assets for repeat visits"],
  ["Edge Caching",                     "Serve cached responses from regional POPs"],
  ["Defer Third-Party Scripts",        "Load analytics and widgets after interactive"],
  ["Module Preload & Script Streaming","Stream and preload JavaScript modules"],
  ["Remove Render-Blocking Resources", "Unblock first paint from CSS and JS"],
  ["Font Subsetting",                  "Ship only the glyphs the page uses"],
  ["Speculation Rules Prefetch",       "Prefetch likely next navigations"],
  ["Priority Hints",                   "Raise fetch priority of the LCP resource"],
  ["Preload LCP Image",                "Preload the largest contentful image"],
  ["Reduce DOM Size",                  "Trim excessive DOM nodes and depth"],
  ["Virtualize Long Lists",            "Render only visible rows of large lists"],
  ["Web Worker Offloading",            "Move heavy work off the main thread"],
  ["Code Splitting By Route",          "Split bundles along navigation boundaries"],
  ["Optimize Hydration Strategy",      "Hydrate islands lazily and progressively"],
  ["Streaming SSR",                    "Flush HTML to the client as it renders"],
  ["Reduce Cookie Payload",            "Slim oversized cookies on asset requests"],
  ["Consolidate Analytics Beacons",    "Batch telemetry into fewer requests"],
  ["Image CDN Transformations",        "Resize and recompress images at the edge"],
  ["Batch DOM Reads/Writes",           "Avoid layout thrash with batched mutation"],
  ["OffscreenCanvas Rendering",        "Render canvas work off the main thread"],
  ["Compress SVG Assets",              "Minify paths and metadata in SVGs"],
  ["Trim Polyfill Payload",            "Drop polyfills modern browsers ignore"],
  ["HTTP Keep-Alive Tuning",           "Reuse warm connections across requests"],
  ["Stale-While-Revalidate Caching",   "Serve stale content while refreshing"],
  ["Batch API Requests",               "Coalesce chatty API calls into batches"],
];

let pct = -5.0;
const improvements = IMPROVEMENTS.slice(0, 50).map((row, idx) => {
  let [name, description, count, avgImprovementPct, icon] = row;
  if (count === undefined) {
    pct = Math.round((pct + 0.08 + rand() * 0.04) * 10) / 10; // drift toward 0
    avgImprovementPct = Math.min(-0.4, pct);
    count = ri(8, 140);
    icon = "default";
  }
  const avgImprovementMs = -Math.round(Math.abs(avgImprovementPct) * (12 + rand() * 6));
  return {
    rank: idx + 1,
    name,
    description,
    count,
    avgImprovementMs,
    avgImprovementPct,
    icon,
  };
});

/* ------------------------------------------------------------- output */

function writeJson(name, value, rowsKey) {
  const path = join(OUT_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  // one object per line keeps the files diffable without bloating them
  const lines = value.map((v) => "  " + JSON.stringify(v));
  writeFileSync(path, "[\n" + lines.join(",\n") + "\n]\n");
  console.log(`wrote ${relative(process.cwd(), path)} (${value.length} ${rowsKey})`);
}

writeJson("sites.json", rows, "rows");
writeJson("improvements.json", improvements, "categories");

const cold = rows.filter((r) => r.mode === "cold");
const avg = (k) => cold.reduce((a, r) => a + r[k], 0) / cold.length;
console.log("cold avg lcpDelta:", avg("lcpDelta").toFixed(3));
console.log("cold avg ttiDelta:", avg("ttiDelta").toFixed(3));
console.log("avg tests/site:", (cold.reduce((a, r) => a + r.tests, 0) / cold.length).toFixed(2));
console.log("unique sites:", new Set(rows.map((r) => r.url)).size);
