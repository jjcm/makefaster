package httpapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"

	"makefaster/internal/db"
	"makefaster/internal/leaderboard"
	"makefaster/internal/store"
)

// liveBoardBeforeTheRename is the improvement board as GET
// /data/improvements.json served it before this change: 22 rows, most of them
// naming one repo's files and components rather than a technique. It is the
// input the rename migration has to cope with.
var liveBoardBeforeTheRename = []leaderboard.Category{
	{Rank: 1, Name: "Static Welcome-screen Boot Shell", Description: "Inlined a static copy of the welcome-screen center into index.html", Count: 1, AvgImprovementMs: -3473, AvgImprovementPct: -63.9, Icon: "default"},
	{Rank: 2, Name: "ETag Conditional Responses for the Component Registry", Description: "The gzip helper behind /api/v1/all now emits a strong ETag", Count: 1, AvgImprovementMs: -810, AvgImprovementPct: -59.1, Icon: "default"},
	{Rank: 3, Name: "Gzip Compression for Static Bundle and API Responses", Description: "Added GZipMiddleware to the FastAPI app", Count: 1, AvgImprovementMs: -5894, AvgImprovementPct: -50.5, Icon: "default"},
	{Rank: 4, Name: "Lazy-load Hidden 262KB Changelog Rocket.gif", Description: "A 262KB animated GIF was eagerly fetched on every page view", Count: 1, AvgImprovementMs: -1500, AvgImprovementPct: -47.3, Icon: "default"},
	{Rank: 5, Name: "Version and Immutably Cache Shell Assets", Description: "Added mtime-versioned CSS and JavaScript URLs with immutable cache headers", Count: 3, AvgImprovementMs: -1632, AvgImprovementPct: -39.9, Icon: "default"},
	{Rank: 6, Name: "Enable Gzip Text Compression on the Production Server", Description: "The standalone server shipped every text asset uncompressed", Count: 1, AvgImprovementMs: -1344, AvgImprovementPct: -29.8, Icon: "default"},
	{Rank: 7, Name: "Gzip Dynamic API JSON Responses by Default", Description: "Enable the existing compress_body middleware unconditionally", Count: 2, AvgImprovementMs: -2371, AvgImprovementPct: -27.7, Icon: "default"},
	{Rank: 8, Name: "Gzip Precompress Frontend Static Assets", Description: "Generate .gz siblings for js/css/json/svg/html at startup", Count: 3, AvgImprovementMs: -3649, AvgImprovementPct: -25.8, Icon: "default"},
	{Rank: 9, Name: "Trim Preloaded Font Payload", Description: "Playfair Display cut from 4 weights x 2 styles to the single one used", Count: 1, AvgImprovementMs: -1176, AvgImprovementPct: -20.9, Icon: "default"},
	{Rank: 10, Name: "Remove Duplicate 1MB Basic_examples Fetch", Description: "AppInitPage refetched the ~1MB payload a second time", Count: 2, AvgImprovementMs: -868, AvgImprovementPct: -18.8, Icon: "default"},
	{Rank: 11, Name: "Hydrate Non-critical Islands on Idle Instead of Load", Description: "Switched the home-path islands from client:load to client:idle", Count: 2, AvgImprovementMs: -227, AvgImprovementPct: -18.3, Icon: "default"},
	{Rank: 12, Name: "Self-host Boot-path Fonts", Description: "The LCP heading paints in a font fetched from a cross-origin CDN", Count: 2, AvgImprovementMs: -304, AvgImprovementPct: -16.5, Icon: "default"},
	{Rank: 13, Name: "Defer Heavy Modal-only Libraries Off the Boot Bundle", Description: "Dynamic-imported the layout engine and the code editor modal", Count: 1, AvgImprovementMs: -629, AvgImprovementPct: -14.2, Icon: "default"},
	{Rank: 14, Name: "Deduplicate Render-blocking CSS Bundles", Description: "Every page shipped two near-identical Tailwind bundles", Count: 1, AvgImprovementMs: -606, AvgImprovementPct: -11.8, Icon: "default"},
	{Rank: 15, Name: "Minify Boot-shell SVG Paths", Description: "svgo on the inline boot-shell logo SVGs cut them 28.8KB to 11KB", Count: 1, AvgImprovementMs: -152, AvgImprovementPct: -11.2, Icon: "default"},
	{Rank: 16, Name: "Prefer Brotli Over Gzip", Description: "Enabled brotli at quality 5 for text responses", Count: 1, AvgImprovementMs: -147, AvgImprovementPct: -9.7, Icon: "default"},
	{Rank: 17, Name: "Lazy-load Mermaid Runtime", Description: "Removed a manualChunks pin that hoisted the mermaid chunk onto the boot path", Count: 2, AvgImprovementMs: -613, AvgImprovementPct: -9.6, Icon: "default"},
	{Rank: 18, Name: "Evict Remaining Non-boot JS From the Entry Bundle", Description: "Lazy ag-grid table impl and route-level lazy forms", Count: 1, AvgImprovementMs: -266, AvgImprovementPct: -9.5, Icon: "default"},
	{Rank: 19, Name: "Inline the Shared Stylesheet (re-test After Landscape Change)", Description: "build.inlineStylesheets:'always' removes both render-blocking CSS requests", Count: 1, AvgImprovementMs: -157, AvgImprovementPct: -9.4, Icon: "default"},
	{Rank: 20, Name: "Drop Dead Moment-timezone and Lazy-load the JSON Editor Cluster", Description: "Deleted an unused helper that shipped the full tz database", Count: 1, AvgImprovementMs: -233, AvgImprovementPct: -7.9, Icon: "default"},
	{Rank: 21, Name: "Lazy-load Chat Side-pane Components", Description: "Dynamically import the chat side-pane tabs only when opened", Count: 1, AvgImprovementMs: -222, AvgImprovementPct: -6.7, Icon: "default"},
	{Rank: 22, Name: "Highlight.js Common Subset", Description: "Import highlight.js/lib/common instead of the full build", Count: 1, AvgImprovementMs: -192, AvgImprovementPct: -5.5, Icon: "default"},
}

// databaseAtVersion drops everything and migrates only as far as `version`, so
// a test can load rows the way they existed before a later migration and then
// watch that migration run.
func databaseAtVersion(t *testing.T, version int64) *sql.DB {
	t.Helper()
	dsn := os.Getenv(testDSNEnv)
	if dsn == "" {
		t.Skipf("%s is not set; skipping the MariaDB-backed tests", testDSNEnv)
	}

	pool, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	for _, table := range []string{"sites", "improvement_categories", "goose_db_version"} {
		if _, err := pool.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			t.Fatalf("drop %s: %v", table, err)
		}
	}
	if err := goose.SetDialect("mysql"); err != nil {
		t.Fatalf("goose dialect: %v", err)
	}
	goose.SetLogger(goose.NopLogger())
	if err := goose.UpTo(pool, migrationsDir, version); err != nil {
		t.Fatalf("migrate to %d: %v", version, err)
	}
	return pool
}

func categoriesByName(categories []leaderboard.Category) map[string]leaderboard.Category {
	byName := make(map[string]leaderboard.Category, len(categories))
	for _, category := range categories {
		byName[category.Name] = category
	}
	return byName
}

// mergeOf is the weighted fold two merged rows must produce: counts add, and
// each average is re-weighted by the counts behind it, rounded the way
// foldIntoCategory rounds.
func mergeOf(sources ...leaderboard.Category) (int, int, float64) {
	var count, msWeighted, pctWeighted float64
	for _, source := range sources {
		count += float64(source.Count)
		msWeighted += float64(source.AvgImprovementMs) * float64(source.Count)
		pctWeighted += source.AvgImprovementPct * float64(source.Count)
	}
	if count == 0 {
		count = 1
	}
	return int(count),
		int(math.Floor(msWeighted/count + 0.5)),
		math.Floor(pctWeighted/count*10+0.5) / 10
}

func TestRenameMigrationFoldsTheLiveBoardOntoGenericNames(t *testing.T) {
	pool := databaseAtVersion(t, 1)

	// Load the board exactly as it stood before the rename.
	if err := store.New(pool).ReplaceCategories(context.Background(), liveBoardBeforeTheRename); err != nil {
		t.Fatalf("load the pre-rename board: %v", err)
	}

	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	after, err := store.New(pool).Categories(context.Background())
	if err != nil {
		t.Fatalf("read categories: %v", err)
	}
	byName := categoriesByName(after)

	source := categoriesByName(liveBoardBeforeTheRename)

	// 22 site-specific rows become 17 techniques: three gzip rows collapse into
	// one, three lazy-load rows into one, and two boot-bundle rows into one.
	if len(after) != 17 {
		names := make([]string, 0, len(after))
		for _, category := range after {
			names = append(names, category.Name)
		}
		t.Fatalf("expected 17 categories after the merge, got %d: %v", len(after), names)
	}

	// Nothing site-specific survived.
	for _, category := range after {
		if _, stale := source[category.Name]; stale {
			t.Errorf("%q was not renamed", category.Name)
		}
	}

	merges := map[string][]leaderboard.Category{
		"Enable Gzip Compression": {
			source["Gzip Compression for Static Bundle and API Responses"],
			source["Enable Gzip Text Compression on the Production Server"],
			source["Gzip Dynamic API JSON Responses by Default"],
		},
		"Lazy-Load Components": {
			source["Lazy-load Chat Side-pane Components"],
			source["Lazy-load Mermaid Runtime"],
			source["Drop Dead Moment-timezone and Lazy-load the JSON Editor Cluster"],
		},
		"Cut Critical-Path JavaScript": {
			source["Defer Heavy Modal-only Libraries Off the Boot Bundle"],
			source["Evict Remaining Non-boot JS From the Entry Bundle"],
		},
	}
	for name, sources := range merges {
		merged, found := byName[name]
		if !found {
			t.Errorf("merged category %q is missing", name)
			continue
		}
		count, ms, pct := mergeOf(sources...)
		if merged.Count != count {
			t.Errorf("%s count: got %d, want %d", name, merged.Count, count)
		}
		if merged.AvgImprovementMs != ms {
			t.Errorf("%s avgImprovementMs: got %d, want %d", name, merged.AvgImprovementMs, ms)
		}
		if merged.AvgImprovementPct != pct {
			t.Errorf("%s avgImprovementPct: got %v, want %v", name, merged.AvgImprovementPct, pct)
		}
	}

	// A row with nothing to merge into keeps its own numbers under the new name.
	renamed := map[string]string{
		"Inline Shared Stylesheets":        "Inline the Shared Stylesheet (re-test After Landscape Change)",
		"Lazy-Load Unseen Images":          "Lazy-load Hidden 262KB Changelog Rocket.gif",
		"Subset Syntax-Highlighter Bundle": "Highlight.js Common Subset",
		"Reduce Font Payload":              "Trim Preloaded Font Payload",
		"Precompress Static Assets":        "Gzip Precompress Frontend Static Assets",
		"Enable Brotli Compression":        "Prefer Brotli Over Gzip",
		"Content-Hashed Immutable Assets":  "Version and Immutably Cache Shell Assets",
		"Skip Redundant Fetches":           "Remove Duplicate 1MB Basic_examples Fetch",
		"Optimize Hydration Strategy":      "Hydrate Non-critical Islands on Idle Instead of Load",
		"Self-Host Critical Fonts":         "Self-host Boot-path Fonts",
		"Remove Duplicate CSS Bundles":     "Deduplicate Render-blocking CSS Bundles",
		"Compress SVG Assets":              "Minify Boot-shell SVG Paths",
		"Inline Critical HTML Shell":       "Static Welcome-screen Boot Shell",
		"ETag Conditional Responses":       "ETag Conditional Responses for the Component Registry",
	}
	for generic, original := range renamed {
		row, found := byName[generic]
		if !found {
			t.Errorf("renamed category %q is missing", generic)
			continue
		}
		was := source[original]
		if row.Count != was.Count || row.AvgImprovementMs != was.AvgImprovementMs || row.AvgImprovementPct != was.AvgImprovementPct {
			t.Errorf("%q kept the wrong numbers: got %+v, want count=%d ms=%d pct=%v",
				generic, row, was.Count, was.AvgImprovementMs, was.AvgImprovementPct)
		}
		// The rename keeps whatever the row said; the description backfill that
		// follows it (migration 00004) replaces the ones it recognizes with the
		// technique blurb. Anything else means a row lost its text.
		if row.Description != was.Description && row.Description != leaderboard.CatalogDescription(generic) {
			t.Errorf("%q lost its description: got %q", generic, row.Description)
		}
	}

	// The board comes out ranked the way RerankCategories ranks it: times
	// improved first, then the biggest average improvement, then the name.
	for i, category := range after {
		if category.Rank != i+1 {
			t.Errorf("position %d has rank %d; ranks must be 1..n in order", i, category.Rank)
		}
		if i == 0 {
			continue
		}
		previous := after[i-1]
		switch {
		case previous.Count > category.Count:
		case previous.Count < category.Count:
			t.Errorf("%q (count %d) ranks above %q (count %d)",
				previous.Name, previous.Count, category.Name, category.Count)
		case previous.AvgImprovementPct > category.AvgImprovementPct:
			t.Errorf("%q (%v%%) ranks above %q (%v%%) at equal count",
				previous.Name, previous.AvgImprovementPct, category.Name, category.AvgImprovementPct)
		}
	}
}

// Site rows written before the board stored both ends of a run only carry the
// after value and the percent change. The migration has to recover the
// baseline from those two, because that is the only relationship the data
// records — nothing may be invented.
func TestBeforeMetricsMigrationBackfillsFromTheRecordedDelta(t *testing.T) {
	pool := databaseAtVersion(t, 2)

	// Written the way the pre-migration schema stored them.
	rows := []struct {
		url                string
		lcpRaw             int
		lcpDelta, ttiDelta float64
		ttiRaw             int
	}{
		{"excalidraw.com", 1202, -82, -20.8, 5325},
		{"roadmap.sh", 908, -82.3, -77.7, 1200},
		{"dave.com", 906, 0.4, 0.4, 906},
	}
	for _, row := range rows {
		if _, err := pool.Exec(`
			INSERT INTO sites (name, url, favicon, lcp_raw, lcp_delta, tti_raw, tti_delta, mode, tests, measured_at)
			VALUES (?, ?, '', ?, ?, ?, ?, 'cold', 1, NOW())`,
			row.url, row.url, row.lcpRaw, row.lcpDelta, row.ttiRaw, row.ttiDelta); err != nil {
			t.Fatalf("insert %s: %v", row.url, err)
		}
	}

	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	stored, err := store.New(pool).Sites(context.Background())
	if err != nil {
		t.Fatalf("read sites: %v", err)
	}
	byURL := make(map[string]leaderboard.SiteRow, len(stored))
	for _, row := range stored {
		byURL[row.URL] = row
	}

	for _, row := range rows {
		got, found := byURL[row.url]
		if !found {
			t.Errorf("%s is missing after the migration", row.url)
			continue
		}
		if want := leaderboard.BaselineFromDelta(row.lcpRaw, row.lcpDelta); got.LCPBefore != want {
			t.Errorf("%s lcpBefore: got %d, want %d", row.url, got.LCPBefore, want)
		}
		if want := leaderboard.BaselineFromDelta(row.ttiRaw, row.ttiDelta); got.TTIBefore != want {
			t.Errorf("%s ttiBefore: got %d, want %d", row.url, got.TTIBefore, want)
		}
		if got.LCPRaw != row.lcpRaw || got.TTIRaw != row.ttiRaw {
			t.Errorf("%s lost its after values: %+v", row.url, got)
		}
	}
}

// liveDescriptions is backend/testdata/category_descriptions.json: every row of
// GET /data/improvements.json with the changelog it carried and the technique
// blurb migration 00004 replaces it with.
func liveDescriptions(t *testing.T) []struct {
	Name string `json:"name"`
	Was  string `json:"was"`
	Now  string `json:"now"`
} {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "category_descriptions.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var rows []struct {
		Name string `json:"name"`
		Was  string `json:"was"`
		Now  string `json:"now"`
	}
	if err := json.Unmarshal(contents, &rows); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return rows
}

// The live board, rewritten. Names, counts and averages are what the board
// earned across every site that reported the technique, so the backfill must
// touch nothing but the description.
func TestDescriptionMigrationRewritesTheLiveBoard(t *testing.T) {
	pool := databaseAtVersion(t, 3)
	rows := liveDescriptions(t)

	before := make([]leaderboard.Category, 0, len(rows))
	for i, row := range rows {
		before = append(before, leaderboard.Category{
			Rank: i + 1, Name: row.Name, Description: row.Was,
			Count: len(rows) - i, AvgImprovementMs: -100 * (i + 1),
			AvgImprovementPct: -1.5 * float64(i+1), Icon: "default",
		})
	}
	if err := store.New(pool).ReplaceCategories(context.Background(), before); err != nil {
		t.Fatalf("load the pre-backfill board: %v", err)
	}

	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	after, err := store.New(pool).Categories(context.Background())
	if err != nil {
		t.Fatalf("read categories: %v", err)
	}
	if len(after) != len(before) {
		t.Fatalf("expected %d categories, got %d", len(before), len(after))
	}

	byName := categoriesByName(after)
	for i, row := range rows {
		got, found := byName[row.Name]
		if !found {
			t.Errorf("%q is missing after the backfill", row.Name)
			continue
		}
		if got.Description != row.Now {
			t.Errorf("%q description: got %q, want %q", row.Name, got.Description, row.Now)
		}
		if got != (leaderboard.Category{
			Rank: got.Rank, Name: before[i].Name, Description: row.Now,
			Count: before[i].Count, AvgImprovementMs: before[i].AvgImprovementMs,
			AvgImprovementPct: before[i].AvgImprovementPct, Icon: before[i].Icon,
		}) {
			t.Errorf("%q changed more than its description: got %+v, want %+v", row.Name, got, before[i])
		}
	}
}

// A row someone has already described as a technique is not rewritten, so
// re-running the backfill — or running it after ingest has upgraded a row — is
// a no-op.
func TestDescriptionMigrationLeavesGenericDescriptionsAlone(t *testing.T) {
	pool := databaseAtVersion(t, 3)
	leaderboards := store.New(pool)

	original := []leaderboard.Category{
		{Rank: 1, Name: "Lazy-Load Components", Description: "Load panes, modals, and editors only when opened", Count: 118, AvgImprovementMs: -59, AvgImprovementPct: -4.9, Icon: "default"},
		{Rank: 2, Name: "Enable Gzip Compression", Description: leaderboard.CatalogDescription("Enable Gzip Compression"), Count: 4, AvgImprovementMs: -2995, AvgImprovementPct: -33.9, Icon: "default"},
		{Rank: 3, Name: "Image Optimization", Description: "Compress and resize images", Count: 312, AvgImprovementMs: -265, AvgImprovementPct: -17.3, Icon: "image"},
	}
	if err := leaderboards.ReplaceCategories(context.Background(), original); err != nil {
		t.Fatalf("load board: %v", err)
	}
	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	after, err := leaderboards.Categories(context.Background())
	if err != nil {
		t.Fatalf("read categories: %v", err)
	}
	for i, category := range after {
		if category != original[i] {
			t.Errorf("row %d changed: got %+v, want %+v", i, category, original[i])
		}
	}
}

// Rolling the backfill back puts the original text on every row that still
// carries the blurb it wrote.
func TestDescriptionMigrationRollsBack(t *testing.T) {
	pool := databaseAtVersion(t, 3)
	rows := liveDescriptions(t)

	before := make([]leaderboard.Category, 0, len(rows))
	for i, row := range rows {
		before = append(before, leaderboard.Category{
			Rank: i + 1, Name: row.Name, Description: row.Was, Count: 1, Icon: "default",
		})
	}
	if err := store.New(pool).ReplaceCategories(context.Background(), before); err != nil {
		t.Fatalf("load the pre-backfill board: %v", err)
	}
	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := goose.Down(pool, migrationsDir); err != nil {
		t.Fatalf("roll back: %v", err)
	}

	byName := categoriesByName(mustCategories(t, pool))
	for _, row := range rows {
		if got := byName[row.Name].Description; got != strings.TrimSpace(row.Was) {
			t.Errorf("%q was not restored: got %q, want %q", row.Name, got, strings.TrimSpace(row.Was))
		}
	}
}

func mustCategories(t *testing.T, pool *sql.DB) []leaderboard.Category {
	t.Helper()
	categories, err := store.New(pool).Categories(context.Background())
	if err != nil {
		t.Fatalf("read categories: %v", err)
	}
	return categories
}

// Running the rename against a board that holds nothing to rename must be a
// no-op, which is what every fresh deploy and every already-migrated database
// will do.
func TestRenameMigrationLeavesGenericBoardsAlone(t *testing.T) {
	pool := databaseAtVersion(t, 1)
	leaderboards := store.New(pool)

	original := []leaderboard.Category{
		{Rank: 1, Name: "Image Optimization", Description: "Compress and resize images", Count: 312, AvgImprovementMs: -265, AvgImprovementPct: -17.3, Icon: "image"},
		{Rank: 2, Name: "Tree Shaking", Description: "Remove unused JavaScript from bundles", Count: 241, AvgImprovementMs: -336, AvgImprovementPct: -22.4, Icon: "tree"},
		{Rank: 3, Name: "Lazy-Load Components", Description: "Load panes, modals, and editors only when opened", Count: 118, AvgImprovementMs: -59, AvgImprovementPct: -4.9, Icon: "default"},
	}
	if err := leaderboards.ReplaceCategories(context.Background(), original); err != nil {
		t.Fatalf("load board: %v", err)
	}
	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	after, err := leaderboards.Categories(context.Background())
	if err != nil {
		t.Fatalf("read categories: %v", err)
	}
	if len(after) != len(original) {
		t.Fatalf("expected %d categories, got %d", len(original), len(after))
	}
	for i, category := range after {
		if category != original[i] {
			t.Errorf("row %d changed: got %+v, want %+v", i, category, original[i])
		}
	}
}
