// Package store is the MariaDB persistence layer for the two leaderboards.
//
// The files in SEED_DIR are the seed dataset: the first boot against an empty
// database copies them in, and the tables own the data from then on.
// GET /data/*.json always reads these tables, never the seed files, so the
// boards reflect submissions.
//
// The committed seed in data/ is deliberately empty, because the public boards
// carry real submissions only. Seeding therefore normally does nothing, and
// that is the point: a redeploy or a rebuilt database cannot republish rows
// nobody submitted. The mechanism stays because a local or self-hosted
// deployment can still point SEED_DIR at a populated pair of files.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"makefaster/internal/leaderboard"
)

type Store struct {
	db *sql.DB
}

func New(db *sql.DB) *Store {
	return &Store{db: db}
}

// Sites returns every site-leaderboard row in insertion order, so seeded rows
// keep their committed order and submissions land at the end.
func (s *Store) Sites(ctx context.Context) ([]leaderboard.SiteRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT name, url, pr_url, generic_keep_pct, site_specific_keep_pct, favicon, lcp_before, lcp_raw, lcp_delta, tti_before, tti_raw, tti_delta, mode, tests, measured_at
		FROM sites
		ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("query sites: %w", err)
	}
	defer rows.Close()

	out := []leaderboard.SiteRow{}
	for rows.Next() {
		var row leaderboard.SiteRow
		var measuredAt time.Time
		if err := rows.Scan(&row.Name, &row.URL, &row.PRURL, &row.GenericKeepPct, &row.SiteSpecificKeepPct, &row.Favicon, &row.LCPBefore, &row.LCPRaw, &row.LCPDelta,
			&row.TTIBefore, &row.TTIRaw, &row.TTIDelta, &row.Mode, &row.Tests, &measuredAt); err != nil {
			return nil, fmt.Errorf("scan site: %w", err)
		}
		row.MeasuredAt = leaderboard.FormatTimestamp(measuredAt)
		out = append(out, row)
	}
	return out, rows.Err()
}

// Categories returns the improvement leaderboard in rank order.
func (s *Store) Categories(ctx context.Context) ([]leaderboard.Category, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT `rank`, name, description, `count`, avg_improvement_ms, avg_improvement_pct, icon "+
		"FROM improvement_categories ORDER BY `rank`, id")
	if err != nil {
		return nil, fmt.Errorf("query categories: %w", err)
	}
	defer rows.Close()

	out := []leaderboard.Category{}
	for rows.Next() {
		var category leaderboard.Category
		if err := rows.Scan(&category.Rank, &category.Name, &category.Description, &category.Count,
			&category.AvgImprovementMs, &category.AvgImprovementPct, &category.Icon); err != nil {
			return nil, fmt.Errorf("scan category: %w", err)
		}
		out = append(out, category)
	}
	return out, rows.Err()
}

// UpsertSite folds one validated measurement into the (url, mode) row,
// creating it when it is new. The bool reports whether a row was created,
// which is the difference between a 201 and a 200 response.
//
// The read and the write share one transaction with a locking read, so two
// concurrent submissions for the same site cannot lose each other's test
// count.
func (s *Store) UpsertSite(ctx context.Context, submission leaderboard.SiteSubmission, now time.Time) (leaderboard.SiteRow, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return leaderboard.SiteRow{}, false, fmt.Errorf("begin upsert: %w", err)
	}
	defer tx.Rollback()

	var existing *leaderboard.SiteRow
	var current leaderboard.SiteRow
	var measuredAt time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT name, url, pr_url, generic_keep_pct, site_specific_keep_pct, favicon, lcp_before, lcp_raw, lcp_delta, tti_before, tti_raw, tti_delta, mode, tests, measured_at
		FROM sites WHERE url = ? AND mode = ? FOR UPDATE`,
		submission.URL, submission.Mode,
	).Scan(&current.Name, &current.URL, &current.PRURL, &current.GenericKeepPct, &current.SiteSpecificKeepPct, &current.Favicon, &current.LCPBefore, &current.LCPRaw, &current.LCPDelta,
		&current.TTIBefore, &current.TTIRaw, &current.TTIDelta, &current.Mode, &current.Tests, &measuredAt)
	switch {
	case err == nil:
		current.MeasuredAt = leaderboard.FormatTimestamp(measuredAt)
		existing = &current
	case err == sql.ErrNoRows:
		existing = nil
	default:
		return leaderboard.SiteRow{}, false, fmt.Errorf("load site: %w", err)
	}

	row := leaderboard.UpsertSite(existing, submission, now)
	created := existing == nil

	if created {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO sites (name, url, pr_url, generic_keep_pct, site_specific_keep_pct, favicon,
				lcp_before, lcp_raw, lcp_delta, tti_before, tti_raw, tti_delta, mode, tests, measured_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.Name, row.URL, row.PRURL, row.GenericKeepPct, row.SiteSpecificKeepPct,
			row.Favicon, row.LCPBefore, row.LCPRaw, row.LCPDelta,
			row.TTIBefore, row.TTIRaw, row.TTIDelta, row.Mode, row.Tests, now.UTC())
	} else {
		_, err = tx.ExecContext(ctx, `
			UPDATE sites SET name = ?, pr_url = ?, generic_keep_pct = ?, site_specific_keep_pct = ?,
				favicon = ?, lcp_before = ?, lcp_raw = ?, lcp_delta = ?,
				tti_before = ?, tti_raw = ?, tti_delta = ?, tests = ?, measured_at = ?
			WHERE url = ? AND mode = ?`,
			row.Name, row.PRURL, row.GenericKeepPct, row.SiteSpecificKeepPct,
			row.Favicon, row.LCPBefore, row.LCPRaw, row.LCPDelta,
			row.TTIBefore, row.TTIRaw, row.TTIDelta, row.Tests, now.UTC(), row.URL, row.Mode)
	}
	if err != nil {
		return leaderboard.SiteRow{}, false, fmt.Errorf("write site: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return leaderboard.SiteRow{}, false, fmt.Errorf("commit site: %w", err)
	}
	return row, created, nil
}

// SaveTips records the notes a run left for the catalog maintainers. Tips are
// write-only through the public API: nothing in this package serves them, no
// endpoint reads them, and neither seed file can contain them. They are read
// straight from the table by the people refining the catalog.
func (s *Store) SaveTips(ctx context.Context, url string, tips []leaderboard.Tip, now time.Time) error {
	if len(tips) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tips: %w", err)
	}
	defer tx.Rollback()

	statement, err := tx.PrepareContext(ctx, `
		INSERT INTO tips (url, about, text, created_at) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare tips: %w", err)
	}
	defer statement.Close()

	for _, tip := range tips {
		if _, err := statement.ExecContext(ctx, url, tip.About, tip.Text, now.UTC()); err != nil {
			return fmt.Errorf("insert tip: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tips: %w", err)
	}
	return nil
}

// ReplaceCategories swaps the whole improvement leaderboard for a freshly
// reranked one. Categorization rewrites every rank, so replacing the table in
// one transaction is both simpler and more faithful than diffing rows; the
// board is on the order of tens of rows.
func (s *Store) ReplaceCategories(ctx context.Context, categories []leaderboard.Category) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin categories: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, "DELETE FROM improvement_categories"); err != nil {
		return fmt.Errorf("clear categories: %w", err)
	}
	if err := insertCategories(ctx, tx, categories); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit categories: %w", err)
	}
	return nil
}

// Seed copies the seed files into empty tables. It is a no-op once a board
// holds data, and also when its seed file is missing or an empty array, so it
// is safe on every boot.
func (s *Store) Seed(ctx context.Context, seedDir string) error {
	if err := s.seedSites(ctx, seedDir); err != nil {
		return err
	}
	return s.seedCategories(ctx, seedDir)
}

func (s *Store) seedSites(ctx context.Context, seedDir string) error {
	empty, err := s.isEmpty(ctx, "sites")
	if err != nil || !empty {
		return err
	}

	var rows []leaderboard.SiteRow
	if err := readSeedFile(filepath.Join(seedDir, "sites.json"), &rows); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin seed sites: %w", err)
	}
	defer tx.Rollback()

	statement, err := tx.PrepareContext(ctx, `
		INSERT INTO sites (name, url, pr_url, generic_keep_pct, site_specific_keep_pct, favicon,
			lcp_before, lcp_raw, lcp_delta, tti_before, tti_raw, tti_delta, mode, tests, measured_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare seed sites: %w", err)
	}
	defer statement.Close()

	for _, row := range rows {
		measuredAt, err := time.Parse(time.RFC3339, row.MeasuredAt)
		if err != nil {
			measuredAt = time.Now()
		}
		// A seed file written before the board stored both ends of a run only
		// carries the after value and the delta; recover the baseline from them
		// rather than seeding a zero.
		if row.LCPBefore == 0 {
			row.LCPBefore = leaderboard.BaselineFromDelta(row.LCPRaw, row.LCPDelta)
		}
		if row.TTIBefore == 0 {
			row.TTIBefore = leaderboard.BaselineFromDelta(row.TTIRaw, row.TTIDelta)
		}
		if _, err := statement.ExecContext(ctx, row.Name, row.URL, row.PRURL, row.GenericKeepPct,
			row.SiteSpecificKeepPct, row.Favicon, row.LCPBefore, row.LCPRaw,
			row.LCPDelta, row.TTIBefore, row.TTIRaw, row.TTIDelta, row.Mode, row.Tests, measuredAt.UTC()); err != nil {
			return fmt.Errorf("seed site %q: %w", row.URL, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit seed sites: %w", err)
	}
	return nil
}

func (s *Store) seedCategories(ctx context.Context, seedDir string) error {
	empty, err := s.isEmpty(ctx, "improvement_categories")
	if err != nil || !empty {
		return err
	}

	var categories []leaderboard.Category
	if err := readSeedFile(filepath.Join(seedDir, "improvements.json"), &categories); err != nil {
		return err
	}
	if len(categories) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin seed categories: %w", err)
	}
	defer tx.Rollback()

	if err := insertCategories(ctx, tx, categories); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit seed categories: %w", err)
	}
	return nil
}

func insertCategories(ctx context.Context, tx *sql.Tx, categories []leaderboard.Category) error {
	if len(categories) == 0 {
		return nil
	}
	statement, err := tx.PrepareContext(ctx, "INSERT INTO improvement_categories "+
		"(`rank`, name, description, `count`, avg_improvement_ms, avg_improvement_pct, icon) "+
		"VALUES (?, ?, ?, ?, ?, ?, ?)")
	if err != nil {
		return fmt.Errorf("prepare categories: %w", err)
	}
	defer statement.Close()

	for _, category := range categories {
		if _, err := statement.ExecContext(ctx, category.Rank, category.Name, category.Description,
			category.Count, category.AvgImprovementMs, category.AvgImprovementPct, category.Icon); err != nil {
			return fmt.Errorf("insert category %q: %w", category.Name, err)
		}
	}
	return nil
}

func (s *Store) isEmpty(ctx context.Context, table string) (bool, error) {
	var count int
	// The table name is a package-internal constant, never request input.
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		return false, fmt.Errorf("count %s: %w", table, err)
	}
	return count == 0, nil
}

func readSeedFile(path string, target any) error {
	contents, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read seed %s: %w", path, err)
	}
	if err := json.Unmarshal(contents, target); err != nil {
		return fmt.Errorf("parse seed %s: %w", path, err)
	}
	return nil
}
