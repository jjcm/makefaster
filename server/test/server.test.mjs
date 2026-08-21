import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMakefasterServer } from "../server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const quiet = { info() {}, warn() {}, error(msg) { console.error(msg); } };

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withServer(dataDir, fn) {
  const created = createMakefasterServer({ rootDir: ROOT, dataDir, env: {}, logger: quiet });
  const base = await listen(created.server);
  try {
    await fn(base, created);
  } finally {
    await close(created.server);
  }
}

test("serves the static marketing pages and live data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-store-"));
  try {
    await withServer(dataDir, async (base) => {
      const index = await fetch(`${base}/`);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /npx makefaster/);

      const css = await fetch(`${base}/css/style.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get("content-type"), /text\/css/);

      const improvements = await (await fetch(`${base}/data/improvements.json`)).json();
      assert.equal(improvements.length, 50);

      const sites = await (await fetch(`${base}/data/sites.json`)).json();
      assert.ok(Array.isArray(sites) && sites.length > 0);

      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.embedder, "local-hash-v1");

      const missing = await fetch(`${base}/nope.html`);
      assert.equal(missing.status, 404);

      const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
      assert.equal(traversal.status, 404);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("submit-site inserts then upserts, and persists across restarts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-store-"));
  const payload = {
    url: "https://speedy.example.com", mode: "cold",
    lcpRaw: 1400, lcpDelta: -22, ttiRaw: 2300, ttiDelta: -17,
  };
  try {
    await withServer(dataDir, async (base) => {
      const first = await fetch(`${base}/api/submit-site`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      assert.equal(first.status, 201);
      const firstJson = await first.json();
      assert.equal(firstJson.created, true);
      assert.equal(firstJson.row.url, "speedy.example.com");
      assert.equal(firstJson.row.tests, 1);
      assert.equal(firstJson.row.favicon, "https://icons.duckduckgo.com/ip3/speedy.example.com.ico");

      const second = await fetch(`${base}/api/submit-site`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, lcpRaw: 1300, lcpDelta: -28 }),
      });
      assert.equal(second.status, 200);
      const secondJson = await second.json();
      assert.equal(secondJson.created, false);
      assert.equal(secondJson.row.tests, 2);
      assert.equal(secondJson.row.lcpRaw, 1300);

      const rows = await (await fetch(`${base}/data/sites.json`)).json();
      const mine = rows.filter((r) => r.url === "speedy.example.com");
      assert.equal(mine.length, 1);

      const bad = await fetch(`${base}/api/submit-site`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, mode: "hot" }),
      });
      assert.equal(bad.status, 400);
      assert.match(JSON.stringify(await bad.json()), /mode/);
    });

    // Restart on the same data dir: the submission must still be there.
    await withServer(dataDir, async (base) => {
      const rows = await (await fetch(`${base}/data/sites.json`)).json();
      const mine = rows.find((r) => r.url === "speedy.example.com" && r.mode === "cold");
      assert.ok(mine, "row lost across restart");
      assert.equal(mine.tests, 2);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("submit-improvements folds matches and creates novel categories, live table refreshes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-store-"));
  try {
    await withServer(dataDir, async (base, { store }) => {
      const beforeCount = store.getImprovements().find((c) => c.name === "Image Optimization").count;
      const res = await fetch(`${base}/api/submit-improvements`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          improvements: [
            { name: "Compress hero images", description: "Compressed and resized the oversized hero images", deltaMs: -420, deltaPct: -19 },
            { name: "Rewrite ORM in Rust", description: "Rewrote the ORM data layer in Rust", deltaMs: -900, deltaPct: -33 },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.results[0].action, "matched");
      assert.equal(json.results[0].category, "Image Optimization");
      assert.equal(json.results[1].action, "created");

      const live = await (await fetch(`${base}/data/improvements.json`)).json();
      assert.equal(live.length, 51);
      assert.equal(live.find((c) => c.name === "Image Optimization").count, beforeCount + 1);
      const created = live.find((c) => c.name === "Rewrite ORM in Rust");
      assert.ok(created, "novel category missing from live data");
      assert.equal(created.count, 1);
      // -33% average puts it at the top of the board
      assert.equal(created.rank, 1);

      // ranks must be a permutation of 1..51
      const ranks = live.map((c) => c.rank).sort((a, b) => a - b);
      assert.deepEqual(ranks, Array.from({ length: 51 }, (_, i) => i + 1));

      // persisted file matches the live response
      const onDisk = JSON.parse(readFileSync(join(dataDir, "improvements.json"), "utf8"));
      assert.equal(onDisk.length, 51);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CORS preflight and headers are present for cross-origin static hosting", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-store-"));
  try {
    await withServer(dataDir, async (base) => {
      const preflight = await fetch(`${base}/api/submit-site`, { method: "OPTIONS" });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);

      const bad = await fetch(`${base}/api/submit-site`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "not json",
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.headers.get("access-control-allow-origin"), "*");
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
