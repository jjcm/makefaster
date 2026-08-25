-- +goose Up
-- A row on the site board says a site got 41% faster, but not what kind of work
-- that took. Some loops win by applying techniques the whole board can reuse —
-- gzip, lazy-loaded components, a smaller font payload — and some win by finding
-- one bug that could only ever have existed in that product. Both are real
-- speedups and both belong on the site board; only the first belongs on the
-- improvement board.
--
-- These two columns record that split for the run: the percentage of the run's
-- kept changes that were reusable techniques, and the percentage that were
-- findings specific to the site. They sum to 100 when the run kept anything.
--
-- Existing rows get 0/0 and stay that way. The split is not recoverable from
-- what was stored — the board never held the individual iterations, only their
-- folded categories — so nothing here guesses at one. Both zero also means "the
-- run kept nothing", and the board shows no split for either case, which is the
-- honest reading of both.
ALTER TABLE sites
  ADD COLUMN generic_keep_pct       TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER pr_url,
  ADD COLUMN site_specific_keep_pct TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER generic_keep_pct;

-- +goose Down
ALTER TABLE sites
  DROP COLUMN generic_keep_pct,
  DROP COLUMN site_specific_keep_pct;
