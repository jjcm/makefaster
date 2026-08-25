-- +goose Up
-- Every row on the site board is a loop that changed somebody's fork, and the
-- diff that produced the numbers was opened as a pull request. Nothing linked
-- to it, so the board could say a site got 41% faster without showing what was
-- done. This column holds that link, and the site name on the board points at
-- it.
--
-- Empty string rather than NULL: the row shape has no other nullable text
-- column, and "no PR" reads the same as "no favicon" everywhere else in the
-- code. The API omits the key entirely when it is empty, so a row without a
-- pull request cannot render a dead link.
ALTER TABLE sites
  ADD COLUMN pr_url VARCHAR(500) NOT NULL DEFAULT '' AFTER url;

-- +goose Down
ALTER TABLE sites
  DROP COLUMN pr_url;
