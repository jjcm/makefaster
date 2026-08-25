-- +goose Up
-- The live improvement board carried the same technique as three rows:
--
--   Precompress Static Assets   (16 keeps — the real one)
--   Enable Gzip Compression     (5 keeps)
--   Enable Brotli Compression   (3 keeps)
--
-- "Serve text compressed" is one idea whether the bytes are compressed at
-- build time or at request time, and splitting it three ways cost the board
-- twice: the technique's count — its rank, the whole point of the board — was
-- divided across three rows, and every checklist walk spent three iterations
-- proving one thing. Ingest now folds the whole compression family onto
-- "Precompress Static Assets" (see internal/leaderboard/genericize.go); this
-- migration brings the rows that landed before that onto the same fold.
--
-- Merging is the same weighted fold migration 00002 used: counts add, and each
-- average is re-weighted by the counts behind it. The surviving row is then
-- re-described so the blurb covers both halves of the technique — build-time
-- siblings, runtime compression as the fallback — but only when the text it
-- holds is one the catalog wrote; a description a person typed is not touched.

CREATE TEMPORARY TABLE compression_fold_names (
  old_name VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (old_name)
) ENGINE = InnoDB;

-- The two live rows, plus the bundled catalog's own spelling of the runtime
-- pair in case a board was seeded from it.
INSERT INTO compression_fold_names (old_name) VALUES
  ('Enable Gzip Compression'),
  ('Enable Brotli Compression'),
  ('Gzip / Brotli Compression');

UPDATE improvement_categories c
JOIN compression_fold_names m ON m.old_name = c.name
SET c.name = 'Precompress Static Assets';

-- One survivor per name: the row with the most sightings behind it.
CREATE TEMPORARY TABLE compression_fold_survivors (
  PRIMARY KEY (keep_id)
) ENGINE = InnoDB AS
SELECT id AS keep_id
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY `count` DESC, id ASC) AS position
  FROM improvement_categories
) ranked
WHERE position = 1;

CREATE TEMPORARY TABLE compression_fold_totals (
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
JOIN compression_fold_survivors s ON s.keep_id = c.id
JOIN compression_fold_totals t ON t.name = c.name
SET c.`count` = t.merged_count,
    c.avg_improvement_ms = t.merged_ms,
    c.avg_improvement_pct = t.merged_pct;

DELETE c FROM improvement_categories c
LEFT JOIN compression_fold_survivors s ON s.keep_id = c.id
WHERE s.keep_id IS NULL;

-- Re-describe the merged row so it covers the whole family. Guarded by the
-- text it replaces: every description here is one the catalog itself wrote —
-- the three blurbs migration 00004 backfilled and ingest stored, the two
-- bundled-catalog lines, the pre-00004 changelogs by their prefixes, and the
-- placeholder. A row whose description matches none of them was described by
-- hand and keeps its text.
UPDATE improvement_categories
SET description = 'Serve compressed text: pre-generate gzip/brotli siblings for static assets, and compress responses at runtime when prebuilt siblings are not an option.'
WHERE name = 'Precompress Static Assets'
  AND (
    description IN (
      'Pre-generate gzip/brotli siblings for static text assets and serve them to clients that accept those encodings.',
      'Compress text responses (HTML, JS, CSS, JSON) with gzip so first-load transfer is smaller.',
      'Prefer brotli for text responses when the client accepts it, falling back to gzip.',
      'Ship prebuilt .gz and .br siblings for static files',
      'Enable or improve text compression'
    )
    OR description LIKE 'Generate .gz siblings for js/css/json/svg/html%'
    OR description LIKE 'Enable the existing compress_body middleware%'
    OR description LIKE 'compression 1.8 supports brotli%'
    OR description LIKE 'Community-submitted:%'
  );

-- Re-rank exactly the way RerankCategories does: times improved first, then
-- the biggest average improvement, then the name.
UPDATE improvement_categories c
JOIN (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY `count` DESC, avg_improvement_pct ASC, name ASC
  ) AS position
  FROM improvement_categories
) ranked ON ranked.id = c.id
SET c.`rank` = ranked.position;

DROP TEMPORARY TABLE compression_fold_totals;
DROP TEMPORARY TABLE compression_fold_survivors;
DROP TEMPORARY TABLE compression_fold_names;

-- +goose Down
-- Not reversible: merging summed the counts and re-weighted the averages of
-- rows that no longer exist separately. Rolling back leaves the folded board
-- in place, exactly like migration 00002.
SELECT 1;
