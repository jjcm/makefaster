#!/usr/bin/env node
/**
 * The Makefaster leaderboard server — a single zero-dependency Node process.
 *
 *   node server/server.mjs            # http://localhost:8787
 *
 * It serves three things:
 *   1. the static marketing site (repo root), unchanged;
 *   2. live leaderboard data:  GET /data/sites.json, GET /data/improvements.json
 *      (served from the persistent store, seeded from the committed data/);
 *   3. the write APIs:         POST /api/submit-site, POST /api/submit-improvements.
 *
 * The static pages also work under any dumb file server (python3 -m
 * http.server) — they just read the committed JSON and never POST. This
 * process is only required for live submissions. See server/README.md for
 * configuration and deploy notes.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/store.mjs";
import { createEmbedder } from "./lib/embedding.mjs";
import { categorizeImprovements } from "./lib/categorize.mjs";
import { upsertSite } from "./lib/sites.mjs";
import { validateImprovementsPayload, validateSitePayload } from "./lib/validate.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8787;
const BODY_LIMIT_BYTES = 256 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_POSTS = 60;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 1);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > BODY_LIMIT_BYTES) {
        rejectPromise(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        rejectPromise(Object.assign(new Error("body must be valid JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", rejectPromise);
  });
}

function createRateLimiter() {
  const buckets = new Map();
  return function allow(ip) {
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      buckets.set(ip, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    if (buckets.size > 10_000) buckets.clear(); // crude memory ceiling
    return bucket.count <= RATE_LIMIT_MAX_POSTS;
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.rootDir] static-site root (defaults to repo root)
 * @param {string} [options.dataDir] writable store dir (default server/.data)
 * @param {object} [options.env]     environment (embedding config)
 * @param {object} [options.logger]
 */
export function createMakefasterServer(options = {}) {
  const rootDir = resolve(options.rootDir || join(SERVER_DIR, ".."));
  const dataDir = resolve(
    options.dataDir || options.env?.MAKEFASTER_DATA_DIR || process.env.MAKEFASTER_DATA_DIR || join(SERVER_DIR, ".data"),
  );
  const env = options.env || process.env;
  const logger = options.logger || console;

  const store = new Store({ dataDir, seedDir: join(rootDir, "data") });
  const { embedder, threshold } = createEmbedder(env, logger);
  const allowPost = createRateLimiter();

  // Serialize writes: one request folds into the store at a time so two
  // concurrent submissions cannot lose each other's rows.
  let writeChain = Promise.resolve();
  function serialized(task) {
    const next = writeChain.then(task, task);
    writeChain = next.catch(() => {});
    return next;
  }

  async function handleSubmitSite(req, res) {
    const body = await readJsonBody(req);
    const validated = validateSitePayload(body);
    if (!validated.ok) {
      sendJson(res, 400, { ok: false, errors: validated.errors });
      return;
    }
    const result = await serialized(async () => {
      const outcome = upsertSite(store.getSites(), validated.value, new Date().toISOString());
      store.replaceSites(outcome.rows);
      return outcome;
    });
    logger.info?.(`submit-site: ${result.created ? "created" : "updated"} ${validated.value.url} (${validated.value.mode})`);
    sendJson(res, result.created ? 201 : 200, { ok: true, created: result.created, row: result.row });
  }

  async function handleSubmitImprovements(req, res) {
    const body = await readJsonBody(req);
    const validated = validateImprovementsPayload(body);
    if (!validated.ok) {
      sendJson(res, 400, { ok: false, errors: validated.errors });
      return;
    }
    const outcome = await serialized(async () => {
      const { categories, results } = await categorizeImprovements({
        improvements: validated.value,
        categories: store.getImprovements(),
        embedder,
        threshold,
      });
      store.replaceImprovements(categories);
      return results;
    });
    logger.info?.(
      `submit-improvements: ${outcome.filter((r) => r.action === "matched").length} matched, ` +
      `${outcome.filter((r) => r.action === "created").length} new categories (embedder ${embedder.id})`,
    );
    sendJson(res, 200, { ok: true, results: outcome, embedder: embedder.id, threshold });
  }

  async function handleStatic(req, res, pathname) {
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const filePath = normalize(join(rootDir, relative));
    if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
      sendJson(res, 404, { ok: false, errors: ["not found"] });
      return;
    }
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      sendJson(res, 404, { ok: false, errors: ["not found"] });
      return;
    }
    if (stats.isDirectory()) {
      sendJson(res, 404, { ok: false, errors: ["not found"] });
      return;
    }
    const type = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "cache-control": type.startsWith("text/html") ? "no-cache" : "public, max-age=300",
      ...corsHeaders(),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (req.method === "POST") {
        const ip = req.socket.remoteAddress || "unknown";
        if (!allowPost(ip)) {
          sendJson(res, 429, { ok: false, errors: ["rate limit exceeded — try again in a minute"] });
          return;
        }
        if (pathname === "/api/submit-site") {
          await handleSubmitSite(req, res);
          return;
        }
        if (pathname === "/api/submit-improvements") {
          await handleSubmitImprovements(req, res);
          return;
        }
        sendJson(res, 404, { ok: false, errors: ["unknown endpoint"] });
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        // Live leaderboard data always comes from the store, never the
        // committed seed files, so the tables reflect submissions.
        if (pathname === "/data/sites.json") {
          sendJson(res, 200, store.getSites());
          return;
        }
        if (pathname === "/data/improvements.json") {
          sendJson(res, 200, store.getImprovements());
          return;
        }
        if (pathname === "/api/health") {
          sendJson(res, 200, { ok: true, embedder: embedder.id, threshold });
          return;
        }
        await handleStatic(req, res, pathname);
        return;
      }

      sendJson(res, 405, { ok: false, errors: ["method not allowed"] });
    } catch (err) {
      const status = err?.statusCode || 500;
      if (status >= 500) logger.error?.(`request failed: ${err?.stack || err}`);
      if (!res.headersSent) {
        sendJson(res, status, { ok: false, errors: [status >= 500 ? "internal error" : err.message] });
      } else {
        res.destroy();
      }
    }
  });

  return { server, store, dataDir, embedder, threshold };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.env.PORT || "", 10) || DEFAULT_PORT;
  const host = process.env.HOST || "0.0.0.0";
  const { server, dataDir, embedder } = createMakefasterServer();
  server.listen(port, host, () => {
    console.log(`makefaster server listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    console.log(`  store:    ${dataDir}`);
    console.log(`  embedder: ${embedder.id}`);
  });
}
