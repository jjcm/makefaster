-- +goose Up
-- Tips: short notes a run may leave for the Speed Lab about the catalog itself
-- — "this row duplicates rank 2", "skip the SPA rows when the bundle is
-- prebuilt". They are the raw material for folds like migration 00008, and
-- they are deliberately write-only from the outside: no endpoint serves them,
-- no board renders them, and the CLI's imported checklist never contains them.
-- They are read straight from this table by the people refining the catalog.
CREATE TABLE tips (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  url        VARCHAR(253)    NOT NULL DEFAULT '',
  about      VARCHAR(80)     NOT NULL DEFAULT '',
  text       VARCHAR(280)    NOT NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- +goose Down
DROP TABLE tips;
