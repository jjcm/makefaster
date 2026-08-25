-- +goose Up
-- The improvement board accumulated one row per site instead of one row per
-- technique: "Lazy-load Chat Side-pane Components", "Lazy-load Hidden 262KB
-- Changelog Rocket.gif" and "Inline the Shared Stylesheet (re-test After
-- Landscape Change)" are three sites describing three techniques the next site
-- can never match. Ingest now normalizes submitted names (see
-- internal/leaderboard/genericize.go), so this migration brings the rows that
-- landed before that onto the same generic names — merging the ones that
-- collide, because several of these are the same technique.
--
-- Merging folds two rows the way foldIntoCategory folds a submission: counts
-- add, and each average is re-weighted by the counts behind it.

-- The rename map. Collation is pinned to the column's so the joins below do
-- not hit an illegal mix of collations, and matching stays case-insensitive.
CREATE TEMPORARY TABLE generic_category_names (
  old_name VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_name VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (old_name)
) ENGINE = InnoDB;

-- Every name currently on the public board, mapped onto the generic name
-- GenericCategoryName() produces for it. Three renames collapse onto
-- "Enable Gzip Compression", three onto "Lazy-Load Components", and two onto
-- "Cut Critical-Path JavaScript".
INSERT INTO generic_category_names (old_name, new_name) VALUES
  ('Static Welcome-screen Boot Shell',                                'Inline Critical HTML Shell'),
  ('ETag Conditional Responses for the Component Registry',           'ETag Conditional Responses'),
  ('Gzip Compression for Static Bundle and API Responses',            'Enable Gzip Compression'),
  ('Enable Gzip Text Compression on the Production Server',           'Enable Gzip Compression'),
  ('Gzip Dynamic API JSON Responses by Default',                      'Enable Gzip Compression'),
  ('Gzip Precompress Frontend Static Assets',                         'Precompress Static Assets'),
  ('Prefer Brotli Over Gzip',                                         'Enable Brotli Compression'),
  ('Lazy-load Hidden 262KB Changelog Rocket.gif',                     'Lazy-Load Unseen Images'),
  ('Lazy-load Chat Side-pane Components',                             'Lazy-Load Components'),
  ('Lazy-load Mermaid Runtime',                                       'Lazy-Load Components'),
  ('Drop Dead Moment-timezone and Lazy-load the JSON Editor Cluster', 'Lazy-Load Components'),
  ('Defer Heavy Modal-only Libraries Off the Boot Bundle',            'Cut Critical-Path JavaScript'),
  ('Evict Remaining Non-boot JS From the Entry Bundle',               'Cut Critical-Path JavaScript'),
  ('Inline the Shared Stylesheet (re-test After Landscape Change)',   'Inline Shared Stylesheets'),
  ('Highlight.js Common Subset',                                      'Subset Syntax-Highlighter Bundle'),
  ('Trim Preloaded Font Payload',                                     'Reduce Font Payload'),
  ('Self-host Boot-path Fonts',                                       'Self-Host Critical Fonts'),
  ('Version and Immutably Cache Shell Assets',                        'Content-Hashed Immutable Assets'),
  ('Remove Duplicate 1MB Basic_examples Fetch',                       'Skip Redundant Fetches'),
  ('Hydrate Non-critical Islands on Idle Instead of Load',            'Optimize Hydration Strategy'),
  ('Deduplicate Render-blocking CSS Bundles',                         'Remove Duplicate CSS Bundles'),
  ('Minify Boot-shell SVG Paths',                                     'Compress SVG Assets');

-- The same families keyed on the product, file and component names they were
-- submitted under, for rows that folded differently than the board showed when
-- this was written, or that land between now and the deploy. Every pattern
-- names a specific product or file, so it cannot rename a row that is already
-- generic, and a pattern that matches nothing is simply a no-op. INSERT IGNORE
-- leaves the exact renames above authoritative.
INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Lazy-Load Components' FROM improvement_categories
WHERE name LIKE '%mermaid%' OR name LIKE '%emoji-mart%' OR name LIKE '%emoji mart%'
   OR name LIKE '%moment-timezone%' OR name LIKE '%moment timezone%'
   OR name LIKE '%side pane%' OR name LIKE '%side-pane%'
   OR name LIKE '%pyodide%' OR name LIKE '%xterm%' OR name LIKE '%ag-grid%'
   OR name LIKE '%elkjs%' OR name LIKE '%react-ace%' OR name LIKE '%ace-builds%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Lazy-Load Unseen Images' FROM improvement_categories
WHERE name LIKE '%rocket.gif%' OR name LIKE '%rocket gif%' OR name LIKE '%.gif%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Lazy-Load Third-Party SDKs' FROM improvement_categories
WHERE name LIKE '%firebase%' OR name LIKE '%recaptcha%' OR name LIKE '%intercom%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Defer Analytics Loading' FROM improvement_categories
WHERE name LIKE '%amplitude%' OR name LIKE '%mixpanel%' OR name LIKE '%segment.io%'
   OR name LIKE '%posthog%' OR name LIKE '%google tag%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Defer Unused Data Fetches' FROM improvement_categories
WHERE name LIKE '%app-list prefetch%' OR name LIKE '%app list prefetch%'
   OR name LIKE '%community-node-types%' OR name LIKE '%node-types%' OR name LIKE '%node types%'
   OR name LIKE '%i18n%' OR name LIKE '%namespace%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Subset Syntax-Highlighter Bundle' FROM improvement_categories
WHERE name LIKE '%highlight.js%' OR name LIKE '%highlight js%' OR name LIKE '%hljs%'
   OR name LIKE '%prismjs%' OR name LIKE '%shiki%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Reduce Font Payload' FROM improvement_categories
WHERE name LIKE '%playfair%' OR name LIKE '%geist mono%' OR name LIKE '%noto sans%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Self-Host Critical Fonts' FROM improvement_categories
WHERE name LIKE '%excalifont%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Inline Critical HTML Shell' FROM improvement_categories
WHERE name LIKE '%welcome screen%' OR name LIKE '%welcome-screen%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Skip Redundant Fetches' FROM improvement_categories
WHERE name LIKE '%basic_examples%';

INSERT IGNORE INTO generic_category_names (old_name, new_name)
SELECT name, 'Cut Critical-Path JavaScript' FROM improvement_categories
WHERE name LIKE '%chunk merge%' OR name LIKE '%merge%chunk%';

UPDATE improvement_categories c
JOIN generic_category_names m ON m.old_name = c.name
SET c.name = m.new_name;

-- One survivor per name: the row with the most sightings behind it, so the
-- description that is kept is the one that already represented the most runs.
CREATE TEMPORARY TABLE generic_category_survivors (
  PRIMARY KEY (keep_id)
) ENGINE = InnoDB AS
SELECT id AS keep_id
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY `count` DESC, id ASC) AS position
  FROM improvement_categories
) ranked
WHERE position = 1;

-- The folded totals for every name. GREATEST(..., 1) only guards a divide by
-- zero; a group whose counts are all zero contributes zero to both numerators.
CREATE TEMPORARY TABLE generic_category_totals (
  PRIMARY KEY (name)
) ENGINE = InnoDB AS
SELECT
  name,
  SUM(`count`) AS merged_count,
  FLOOR(SUM(avg_improvement_ms * CAST(`count` AS SIGNED))
        / GREATEST(SUM(CAST(`count` AS SIGNED)), 1) + 0.5) AS merged_ms,
  FLOOR(SUM(avg_improvement_pct * CAST(`count` AS SIGNED))
        / GREATEST(SUM(CAST(`count` AS SIGNED)), 1) * 10 + 0.5) / 10 AS merged_pct
FROM improvement_categories
GROUP BY name;

UPDATE improvement_categories c
JOIN generic_category_survivors s ON s.keep_id = c.id
JOIN generic_category_totals t ON t.name = c.name
SET c.`count` = t.merged_count,
    c.avg_improvement_ms = t.merged_ms,
    c.avg_improvement_pct = t.merged_pct;

DELETE c FROM improvement_categories c
LEFT JOIN generic_category_survivors s ON s.keep_id = c.id
WHERE s.keep_id IS NULL;

-- Re-rank exactly the way RerankCategories does now: times improved first,
-- then the biggest average improvement, then the name.
UPDATE improvement_categories c
JOIN (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY `count` DESC, avg_improvement_pct ASC, name ASC
  ) AS position
  FROM improvement_categories
) ranked ON ranked.id = c.id
SET c.`rank` = ranked.position;

DROP TEMPORARY TABLE generic_category_totals;
DROP TEMPORARY TABLE generic_category_survivors;
DROP TEMPORARY TABLE generic_category_names;

-- +goose Down
-- Not reversible: merging summed the counts and re-weighted the averages of
-- rows that no longer exist separately, and the site-specific names they were
-- submitted under are gone. Rolling back leaves the generic board in place.
SELECT 1;
