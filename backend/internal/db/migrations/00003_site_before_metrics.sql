-- +goose Up
-- The site board only ever stored the measurement taken after the loop
-- (`lcp_raw`, `tti_raw`) plus the percent change from the pre-loop baseline
-- (`lcp_delta`, `tti_delta`), so it could show "1,202 ms, 82% faster" but not
-- what the site actually cost before. These two columns hold the baseline, so
-- both ends of the run are on the board.
ALTER TABLE sites
  ADD COLUMN lcp_before INT NOT NULL DEFAULT 0 AFTER favicon,
  ADD COLUMN tti_before INT NOT NULL DEFAULT 0 AFTER lcp_delta;

-- Existing rows get their baseline recovered from the relationship that
-- produced the delta in the first place: the CLI submits
-- delta = (after - before) / before * 100, so before = after / (1 + delta/100).
-- Nothing is invented — a delta of -100% or worse has no recoverable baseline,
-- so those rows keep before = after and read as "no improvement recorded".
UPDATE sites
SET lcp_before = FLOOR(lcp_raw / (1 + lcp_delta / 100) + 0.5)
WHERE 1 + lcp_delta / 100 > 0;

UPDATE sites
SET tti_before = FLOOR(tti_raw / (1 + tti_delta / 100) + 0.5)
WHERE 1 + tti_delta / 100 > 0;

UPDATE sites SET lcp_before = lcp_raw WHERE lcp_before = 0 AND lcp_raw > 0;
UPDATE sites SET tti_before = tti_raw WHERE tti_before = 0 AND tti_raw > 0;

-- +goose Down
ALTER TABLE sites
  DROP COLUMN lcp_before,
  DROP COLUMN tti_before;
