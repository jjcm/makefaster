-- +goose Up
-- Traces: the index of the curated reasoning traces a run may submit after its
-- results, for post-training a small model on how the makefaster loop reasons.
--
-- This table is the catalog, not the content: the thinking blocks themselves
-- live as one JSON document per run under the server's private trace directory
-- (MAKEFASTER_TRACE_DIR, e.g. /var/lib/makefaster/traces), which no HTTP route
-- serves. `path` is that document, relative to the directory root.
--
-- Nothing here is public. No endpoint reads this table, no board renders it,
-- and it is not the source of the checklist the CLI imports — the same posture
-- as `tips` (migration 00010), for the same reason: a trace is only ever
-- submitted on an explicit, separate yes, and publishing it would be an upload
-- the user never made.
CREATE TABLE traces (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The run the trace came from. Unique, so a resubmitted run replaces its
  -- trace instead of adding a second copy to the training set.
  run_id            VARCHAR(64)     NOT NULL,
  -- 'cli' for a submission through POST /api/submit-trace, 'import' for a
  -- backfill of already-packed runs (cmd/traces import).
  source            VARCHAR(16)     NOT NULL DEFAULT 'cli',
  product           VARCHAR(200)    NOT NULL DEFAULT '',
  pr_url            VARCHAR(500)    NOT NULL DEFAULT '',
  agent             VARCHAR(40)     NOT NULL DEFAULT '',
  model             VARCHAR(120)    NOT NULL DEFAULT '',
  round             INT             NOT NULL DEFAULT 0,
  thinking_blocks   INT             NOT NULL DEFAULT 0,
  thinking_chars    INT             NOT NULL DEFAULT 0,
  iterations        INT             NOT NULL DEFAULT 0,
  has_results       TINYINT(1)      NOT NULL DEFAULT 0,
  has_diff          TINYINT(1)      NOT NULL DEFAULT 0,
  -- Whether the same run also submitted its results to the public boards, so a
  -- trace can be lined up with the site row it belongs to.
  results_submitted TINYINT(1)      NOT NULL DEFAULT 0,
  path              VARCHAR(255)    NOT NULL,
  started_at        DATETIME(3)     NULL,
  submitted_at      DATETIME(3)     NULL,
  created_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY traces_run_id (run_id),
  KEY traces_created_at (created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- +goose Down
DROP TABLE traces;
