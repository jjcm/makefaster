-- +goose Up
-- Migration 00002 gave every row on the improvement board a generic technique
-- name. Their descriptions stayed changelogs of the one repo that first
-- submitted them:
--
--   Reduce Font Payload
--     "Playfair Display cut from 4 weights x 2 styles to the single 400-italic
--      actually used; disabled preload for Playfair, Geist Mono and Noto Sans…"
--
-- The name promises a technique, the line under it describes one afternoon in
-- one source tree, and the next site reading the board gets nothing it can act
-- on. Ingest now genericizes the description the same way it genericizes the
-- name (see internal/leaderboard/describe.go), so this migration rewrites the
-- rows that were created before that as the techniques they are named after.
--
-- Description only: no name, count, average or rank is touched. Every row here
-- is a live row of GET /data/improvements.json as of 2026-08-25, snapshotted
-- with its old text in backend/testdata/category_descriptions.json, which is
-- what makes the Down below an exact restore.

CREATE TEMPORARY TABLE generic_category_descriptions (
  name            VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_description VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_description VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (name)
) ENGINE = InnoDB;

INSERT INTO generic_category_descriptions (name, old_description, new_description) VALUES
  ('Lazy-Load Components',
   'Removed a manualChunks pin and a stray static import that hoisted the ~170KB-gzip mermaid-to-excalidraw chunk onto the boot critical path; it is now a naturally',
   'Import optional UI (editors, diagrams, modals, viewers) only from the surfaces that need them so they stay off the first-load bundle.'),
  ('Enable Gzip Compression',
   'Enable the existing compress_body middleware unconditionally (was behind --enable-compress-response-body). /api/object_info 1.64MB -> 184KB; subgraph JSON respo',
   'Compress text responses (HTML, JS, CSS, JSON) with gzip so first-load transfer is smaller.'),
  ('Content-Hashed Immutable Assets',
   'Added mtime-versioned CSS and JavaScript URLs with immutable cache headers, eliminating both static-asset transfers on repeat visits',
   'Serve content-hashed static files with long-lived immutable cache headers so repeat visits skip the transfer.'),
  ('Reduce Font Payload',
   'Playfair Display cut from 4 weights x 2 styles to the single 400-italic actually used; disabled preload for Playfair, Geist Mono and Noto Sans Arabic so only th',
   'Ship only the font files, weights, and subsets the entry page actually paints, and drop preloads for fonts it never uses.'),
  ('Precompress Static Assets',
   'Generate .gz siblings for js/css/json/svg/html in the frontend web root at startup; aiohttp FileResponse serves them to gzip-accepting clients. Total bytes 21.1',
   'Pre-generate gzip/brotli siblings for static text assets and serve them to clients that accept those encodings.'),
  ('Cut Critical-Path JavaScript',
   'Dynamic-imported elkjs (auto-layout), lazy-loaded react-ace + ace-builds in the code editor modal (and dropped dead ace imports in two other modals), switched r',
   'Move non-boot code (editors, layout engines, unused languages) off the entry bundle so less JS runs before LCP.'),
  ('Inline Critical HTML Shell',
   'Inlined a pixel-aligned static copy of the welcome-screen center (logo + heading) into index.html so the LCP element paints from HTML+CSS instead of waiting for',
   'Paint the LCP heading/logo from static HTML+CSS instead of waiting for the app bundle to mount it.'),
  ('Skip Redundant Fetches',
   'AppInitPage refetched the ~1MB /api/v1/flows/basic_examples payload a second time whenever the config query landed; removed the redundant refetch (the query key',
   'Do not download the same payload twice during boot; reuse the in-flight or cached response.'),
  ('Optimize Hydration Strategy',
   'Switched the home-path Astro islands (nav dropdowns, announcements, sponsors, login form, page-visit tracker) from client:load to client:idle so their ~18 chunk',
   'Hydrate non-critical islands on idle or interaction instead of blocking first paint with eager client hydration.'),
  ('Self-Host Critical Fonts',
   'The LCP heading paints in Excalifont which was fetched from a cross-origin fonts CDN (extra DNS+TCP+TLS on the critical path); the build already emits fonts loc',
   'Host LCP fonts on the same origin so the heading does not wait on extra DNS/TLS to a font CDN.'),
  ('ETag Conditional Responses',
   'The gzip helper behind /api/v1/all now emits a strong ETag (md5 of the serialized payload) with Cache-Control: no-cache and honours If-None-Match with a 304, so',
   'Send ETags on large JSON/API payloads and honor If-None-Match with 304 so warm loads skip the body.'),
  ('Lazy-Load Unseen Images',
   'A 512x512 262KB animated GIF was eagerly fetched on every page view to paint a 48x48 decoration that is display:none on mobile and below the fold on desktop; lo',
   'Do not eagerly download images that are hidden, below the fold, or unused on the current viewport.'),
  ('Remove Entrance Animation From LCP Element',
   'The boot screen lockup animated from opacity 0, so the first contentful/largest paint was not recorded (or visible) until the fade-in progressed. Served a style',
   'Do not fade or slide the LCP element in; paint it at full opacity so the largest paint lands as soon as it renders.'),
  ('Merge Small JS Chunks',
   'The client build emitted ~270 chunks (~125 fetched at boot) over HTTP/1.1, so request count and round trips dominated. Grouped tiny shared chunks via rolldown c',
   'Combine tiny boot-time JS chunks so HTTP/1.1 request count and round trips stop dominating LCP.'),
  ('WebSocket-first Realtime Transport',
   'The realtime client used the default transport order (HTTP long-polling handshake, then WebSocket upgrade), adding round-trips before the first data payload tha',
   'Open the realtime connection on WebSocket first (with polling fallback) instead of a long-poll handshake before first data.'),
  ('Remove Duplicate CSS Bundles',
   'Every page shipped two near-identical ~160KB Tailwind bundles (one a strict subset of the other) as render-blocking CSS; vite build.cssCodeSplit:false emits a s',
   'Do not ship two overlapping CSS bundles as render-blocking; emit one shared stylesheet.'),
  ('Compress SVG Assets',
   'svgo (precision 1) on the inline boot-shell logo SVGs cut them 28.8KB->11KB raw with no visible difference, shrinking index.html 16.3KB->8.6KB gzip — enough to',
   'Minify inline and static SVGs so the document and images cost fewer bytes on the critical path.'),
  ('Enable Brotli Compression',
   'compression 1.8 supports brotli; enabled it at quality 5 for text responses. Home document 46.7KB -> 41.1KB on the wire',
   'Prefer brotli for text responses when the client accepts it, falling back to gzip.'),
  ('Inline Shared Stylesheets',
   'Same change as iteration 4, re-tested after the GIF fix shortened the critical path: build.inlineStylesheets:''always'' removes both render-blocking CSS requests.',
   'Inline the shared render-blocking stylesheet so first paint does not wait on a CSS round trip.'),
  ('Subset Syntax-Highlighter Bundle',
   'Import highlight.js/lib/common (core + ~35 languages) instead of the full build with all ~190 languages in utils/index.ts, CodeBlock.svelte, RichTextInput.svelt',
   'Import only the languages the product actually highlights instead of the full highlighter with every grammar.');

-- Each rewrite is guarded by the text it replaces, so a row someone has already
-- described generically is left alone and re-running this changes nothing. The
-- prefix match is the same guard for a row whose text was stored longer than the
-- 160 characters the board serves.
UPDATE improvement_categories c
JOIN generic_category_descriptions d ON d.name = c.name
SET c.description = d.new_description
WHERE c.description = d.old_description
   OR c.description LIKE CONCAT(LEFT(d.old_description, 40), '%');

DROP TEMPORARY TABLE generic_category_descriptions;

-- +goose Down
-- Reversible: the text each row carried is snapshotted here, so rolling back
-- puts the original description back on any row that still holds the generic
-- one. A row described by hand since the Up ran keeps that description. The
-- table is spelled out a second time because the Up's temporary table is gone
-- by the time this runs — goose executes the two directions as separate
-- sessions.

CREATE TEMPORARY TABLE generic_category_descriptions (
  name            VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_description VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_description VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (name)
) ENGINE = InnoDB;

INSERT INTO generic_category_descriptions (name, old_description, new_description) VALUES
  ('Lazy-Load Components',
   'Removed a manualChunks pin and a stray static import that hoisted the ~170KB-gzip mermaid-to-excalidraw chunk onto the boot critical path; it is now a naturally',
   'Import optional UI (editors, diagrams, modals, viewers) only from the surfaces that need them so they stay off the first-load bundle.'),
  ('Enable Gzip Compression',
   'Enable the existing compress_body middleware unconditionally (was behind --enable-compress-response-body). /api/object_info 1.64MB -> 184KB; subgraph JSON respo',
   'Compress text responses (HTML, JS, CSS, JSON) with gzip so first-load transfer is smaller.'),
  ('Content-Hashed Immutable Assets',
   'Added mtime-versioned CSS and JavaScript URLs with immutable cache headers, eliminating both static-asset transfers on repeat visits',
   'Serve content-hashed static files with long-lived immutable cache headers so repeat visits skip the transfer.'),
  ('Reduce Font Payload',
   'Playfair Display cut from 4 weights x 2 styles to the single 400-italic actually used; disabled preload for Playfair, Geist Mono and Noto Sans Arabic so only th',
   'Ship only the font files, weights, and subsets the entry page actually paints, and drop preloads for fonts it never uses.'),
  ('Precompress Static Assets',
   'Generate .gz siblings for js/css/json/svg/html in the frontend web root at startup; aiohttp FileResponse serves them to gzip-accepting clients. Total bytes 21.1',
   'Pre-generate gzip/brotli siblings for static text assets and serve them to clients that accept those encodings.'),
  ('Cut Critical-Path JavaScript',
   'Dynamic-imported elkjs (auto-layout), lazy-loaded react-ace + ace-builds in the code editor modal (and dropped dead ace imports in two other modals), switched r',
   'Move non-boot code (editors, layout engines, unused languages) off the entry bundle so less JS runs before LCP.'),
  ('Inline Critical HTML Shell',
   'Inlined a pixel-aligned static copy of the welcome-screen center (logo + heading) into index.html so the LCP element paints from HTML+CSS instead of waiting for',
   'Paint the LCP heading/logo from static HTML+CSS instead of waiting for the app bundle to mount it.'),
  ('Skip Redundant Fetches',
   'AppInitPage refetched the ~1MB /api/v1/flows/basic_examples payload a second time whenever the config query landed; removed the redundant refetch (the query key',
   'Do not download the same payload twice during boot; reuse the in-flight or cached response.'),
  ('Optimize Hydration Strategy',
   'Switched the home-path Astro islands (nav dropdowns, announcements, sponsors, login form, page-visit tracker) from client:load to client:idle so their ~18 chunk',
   'Hydrate non-critical islands on idle or interaction instead of blocking first paint with eager client hydration.'),
  ('Self-Host Critical Fonts',
   'The LCP heading paints in Excalifont which was fetched from a cross-origin fonts CDN (extra DNS+TCP+TLS on the critical path); the build already emits fonts loc',
   'Host LCP fonts on the same origin so the heading does not wait on extra DNS/TLS to a font CDN.'),
  ('ETag Conditional Responses',
   'The gzip helper behind /api/v1/all now emits a strong ETag (md5 of the serialized payload) with Cache-Control: no-cache and honours If-None-Match with a 304, so',
   'Send ETags on large JSON/API payloads and honor If-None-Match with 304 so warm loads skip the body.'),
  ('Lazy-Load Unseen Images',
   'A 512x512 262KB animated GIF was eagerly fetched on every page view to paint a 48x48 decoration that is display:none on mobile and below the fold on desktop; lo',
   'Do not eagerly download images that are hidden, below the fold, or unused on the current viewport.'),
  ('Remove Entrance Animation From LCP Element',
   'The boot screen lockup animated from opacity 0, so the first contentful/largest paint was not recorded (or visible) until the fade-in progressed. Served a style',
   'Do not fade or slide the LCP element in; paint it at full opacity so the largest paint lands as soon as it renders.'),
  ('Merge Small JS Chunks',
   'The client build emitted ~270 chunks (~125 fetched at boot) over HTTP/1.1, so request count and round trips dominated. Grouped tiny shared chunks via rolldown c',
   'Combine tiny boot-time JS chunks so HTTP/1.1 request count and round trips stop dominating LCP.'),
  ('WebSocket-first Realtime Transport',
   'The realtime client used the default transport order (HTTP long-polling handshake, then WebSocket upgrade), adding round-trips before the first data payload tha',
   'Open the realtime connection on WebSocket first (with polling fallback) instead of a long-poll handshake before first data.'),
  ('Remove Duplicate CSS Bundles',
   'Every page shipped two near-identical ~160KB Tailwind bundles (one a strict subset of the other) as render-blocking CSS; vite build.cssCodeSplit:false emits a s',
   'Do not ship two overlapping CSS bundles as render-blocking; emit one shared stylesheet.'),
  ('Compress SVG Assets',
   'svgo (precision 1) on the inline boot-shell logo SVGs cut them 28.8KB->11KB raw with no visible difference, shrinking index.html 16.3KB->8.6KB gzip — enough to',
   'Minify inline and static SVGs so the document and images cost fewer bytes on the critical path.'),
  ('Enable Brotli Compression',
   'compression 1.8 supports brotli; enabled it at quality 5 for text responses. Home document 46.7KB -> 41.1KB on the wire',
   'Prefer brotli for text responses when the client accepts it, falling back to gzip.'),
  ('Inline Shared Stylesheets',
   'Same change as iteration 4, re-tested after the GIF fix shortened the critical path: build.inlineStylesheets:''always'' removes both render-blocking CSS requests.',
   'Inline the shared render-blocking stylesheet so first paint does not wait on a CSS round trip.'),
  ('Subset Syntax-Highlighter Bundle',
   'Import highlight.js/lib/common (core + ~35 languages) instead of the full build with all ~190 languages in utils/index.ts, CodeBlock.svelte, RichTextInput.svelt',
   'Import only the languages the product actually highlights instead of the full highlighter with every grammar.');

UPDATE improvement_categories c
JOIN generic_category_descriptions d ON d.name = c.name
SET c.description = LEFT(d.old_description, 160)
WHERE c.description = d.new_description;

DROP TEMPORARY TABLE generic_category_descriptions;
