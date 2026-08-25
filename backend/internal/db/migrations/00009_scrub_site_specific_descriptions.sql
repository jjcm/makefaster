-- +goose Up
-- Three rows on the live improvement board still describe one repo instead of
-- one technique, because they were created before ingest genericized
-- descriptions (internal/leaderboard/describe.go):
--
--   Defer Analytics Loading   names posthog-js and a byte size
--   Minify JavaScript         lists one repo's vendored libraries and its Go
--                             build script
--   Remove Unused CSS         narrates one app's tooltip provider wrapper
--
-- A weaker agent walking the checklist reads those lines as recipes — "find
-- posthog-js" — instead of as techniques. This migration is the same shape as
-- 00004: description only, guarded by the text it replaces, snapshotted in
-- backend/testdata/scrubbed_descriptions.json so the Down is an exact restore.

CREATE TEMPORARY TABLE scrubbed_descriptions (
  name            VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_description VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_description VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (name)
) ENGINE = InnoDB;

INSERT INTO scrubbed_descriptions (name, old_description, new_description) VALUES
  ('Defer Analytics Loading',
   'posthog-js was statically imported by the shared telemetry wrapper, shipping ~50KB gzip of analytics SDK in the critical path of every page even when telemetry',
   'Load analytics, telemetry and tag managers after the page is interactive, never on the critical path.'),
  ('Minify JavaScript',
   'Minified vendored JS libraries (AngularJS, jQuery, moment, fancytree, bootstrap, daterangepicker) at asset-embed time in the Go build script using tdewolff/mini',
   'Serve minified JS bundles and vendored scripts so the same code costs fewer bytes on the critical path.'),
  ('Remove Unused CSS',
   'The app shipped a tooltip provider wrapper and ~13 KB of tooltip utility CSS (now inlined into every SSR response) although no tooltip ever renders. Removed the',
   'Strip stylesheet rules and style payloads nothing on the page uses so render-blocking CSS costs fewer bytes.');

-- Guarded by the text each rewrite replaces, so a row that has since been
-- described generically is left alone and re-running this changes nothing.
UPDATE improvement_categories c
JOIN scrubbed_descriptions d ON d.name = c.name
SET c.description = d.new_description
WHERE c.description = d.old_description
   OR c.description LIKE CONCAT(LEFT(d.old_description, 40), '%');

DROP TEMPORARY TABLE scrubbed_descriptions;

-- +goose Down
-- Reversible: the text each row carried is snapshotted here, so rolling back
-- puts the original description on any row that still holds the generic one.

CREATE TEMPORARY TABLE scrubbed_descriptions (
  name            VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_description VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_description VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (name)
) ENGINE = InnoDB;

INSERT INTO scrubbed_descriptions (name, old_description, new_description) VALUES
  ('Defer Analytics Loading',
   'posthog-js was statically imported by the shared telemetry wrapper, shipping ~50KB gzip of analytics SDK in the critical path of every page even when telemetry',
   'Load analytics, telemetry and tag managers after the page is interactive, never on the critical path.'),
  ('Minify JavaScript',
   'Minified vendored JS libraries (AngularJS, jQuery, moment, fancytree, bootstrap, daterangepicker) at asset-embed time in the Go build script using tdewolff/mini',
   'Serve minified JS bundles and vendored scripts so the same code costs fewer bytes on the critical path.'),
  ('Remove Unused CSS',
   'The app shipped a tooltip provider wrapper and ~13 KB of tooltip utility CSS (now inlined into every SSR response) although no tooltip ever renders. Removed the',
   'Strip stylesheet rules and style payloads nothing on the page uses so render-blocking CSS costs fewer bytes.');

UPDATE improvement_categories c
JOIN scrubbed_descriptions d ON d.name = c.name
SET c.description = LEFT(d.old_description, 160)
WHERE c.description = d.new_description;

DROP TEMPORARY TABLE scrubbed_descriptions;
