-- +goose Up
-- The site leaderboard: one row per (site, load mode). Metrics are the latest
-- measured run; `tests` counts how many runs have been folded in.
CREATE TABLE sites (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL,
  url         VARCHAR(253)    NOT NULL,
  favicon     VARCHAR(500)    NOT NULL,
  lcp_raw     INT             NOT NULL,
  lcp_delta   DECIMAL(6, 1)   NOT NULL,
  tti_raw     INT             NOT NULL,
  tti_delta   DECIMAL(6, 1)   NOT NULL,
  mode        ENUM('cold', 'warm') NOT NULL,
  tests       INT UNSIGNED    NOT NULL DEFAULT 1,
  measured_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sites_url_mode (url, mode)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- The improvement leaderboard: what people sped up, folded into categories by
-- embedding similarity. `rank` is recomputed on every submission.
CREATE TABLE improvement_categories (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `rank`              INT UNSIGNED    NOT NULL,
  name                VARCHAR(80)     NOT NULL,
  description         VARCHAR(160)    NOT NULL,
  count               INT UNSIGNED    NOT NULL DEFAULT 1,
  avg_improvement_ms  INT             NOT NULL DEFAULT 0,
  avg_improvement_pct DECIMAL(6, 1)   NOT NULL DEFAULT 0,
  icon                VARCHAR(40)     NOT NULL DEFAULT 'default',
  PRIMARY KEY (id),
  KEY idx_improvement_categories_rank (`rank`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- +goose Down
DROP TABLE improvement_categories;
DROP TABLE sites;
