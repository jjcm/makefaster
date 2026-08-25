package leaderboard_test

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"makefaster/internal/embedding"
	"makefaster/internal/leaderboard"
)

// fixtureCategories loads backend/testdata/categories.json: a frozen 50-row
// board that gives these tests a realistic list to categorize against. It is
// test-only — the committed public seed in data/ is empty, and nothing serves
// this file.
func fixtureCategories(t *testing.T) []leaderboard.Category {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "categories.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var categories []leaderboard.Category
	if err := json.Unmarshal(contents, &categories); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return categories
}

func localEmbedder() (embedding.Embedder, float64) {
	return embedding.New(embedding.Options{}, nil)
}

func findCategory(t *testing.T, categories []leaderboard.Category, name string) leaderboard.Category {
	t.Helper()
	for _, category := range categories {
		if category.Name == name {
			return category
		}
	}
	t.Fatalf("category %q not found", name)
	return leaderboard.Category{}
}

func TestMatchedImprovementIncrementsCountAndFoldsAverages(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()
	before := findCategory(t, categories, "Image Optimization")

	updated, results := leaderboard.Categorize([]leaderboard.Improvement{{
		Name:        "Compress hero images",
		Description: "Compressed and resized the oversized hero images",
		DeltaMs:     -600,
		HasDeltaMs:  true,
		DeltaPct:    -30,
		HasDeltaPct: true,
	}}, categories, embedder, threshold)

	if len(results) != 1 || results[0].Action != "matched" || results[0].Category != "Image Optimization" {
		t.Fatalf("expected one match against Image Optimization, got %+v", results)
	}

	after := findCategory(t, updated, "Image Optimization")
	if after.Count != before.Count+1 {
		t.Errorf("count: got %d, want %d", after.Count, before.Count+1)
	}
	expectedMs := int(math.Floor((float64(before.AvgImprovementMs)*float64(before.Count)-600)/float64(before.Count+1) + 0.5))
	expectedPct := math.Floor((before.AvgImprovementPct*float64(before.Count)-30)/float64(before.Count+1)*10+0.5) / 10
	if after.AvgImprovementMs != expectedMs {
		t.Errorf("avgImprovementMs: got %d, want %d", after.AvgImprovementMs, expectedMs)
	}
	if after.AvgImprovementPct != expectedPct {
		t.Errorf("avgImprovementPct: got %v, want %v", after.AvgImprovementPct, expectedPct)
	}

	if reread := findCategory(t, categories, "Image Optimization"); reread.Count != before.Count {
		t.Errorf("input categories were mutated: count %d, want %d", reread.Count, before.Count)
	}
}

func TestNovelImprovementCreatesTitleCasedCategory(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()

	updated, results := leaderboard.Categorize([]leaderboard.Improvement{{
		Name:        "rewrite the ORM in rust",
		Description: "Rewrote the ORM data layer in Rust",
		DeltaMs:     -350,
		HasDeltaMs:  true,
		DeltaPct:    -12.34,
		HasDeltaPct: true,
	}}, categories, embedder, threshold)

	if results[0].Action != "created" {
		t.Fatalf("expected a created category, got %+v", results[0])
	}
	if len(updated) != len(categories)+1 {
		t.Fatalf("expected %d categories, got %d", len(categories)+1, len(updated))
	}

	created := findCategory(t, updated, "Rewrite the ORM in Rust")
	if created.Count != 1 {
		t.Errorf("count: got %d, want 1", created.Count)
	}
	if created.AvgImprovementMs != -350 {
		t.Errorf("avgImprovementMs: got %d, want -350", created.AvgImprovementMs)
	}
	if created.AvgImprovementPct != -12.3 {
		t.Errorf("avgImprovementPct: got %v, want -12.3", created.AvgImprovementPct)
	}
	if created.Icon != "default" {
		t.Errorf("icon: got %q, want %q", created.Icon, "default")
	}
	if created.Rank < 1 {
		t.Errorf("rank: got %d, want >= 1", created.Rank)
	}
}

func TestTwoSimilarNovelEntriesCreateOneCategory(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()

	updated, results := leaderboard.Categorize([]leaderboard.Improvement{
		{Name: "Precompile route manifests", Description: "Precompiled the route manifest lookup table at build time",
			DeltaMs: -80, HasDeltaMs: true, DeltaPct: -4, HasDeltaPct: true},
		{Name: "Precompile the route manifest", Description: "Route manifest lookup table now precompiled at build time",
			DeltaMs: -60, HasDeltaMs: true, DeltaPct: -3, HasDeltaPct: true},
	}, categories, embedder, threshold)

	if results[0].Action != "created" {
		t.Fatalf("first entry should create a category, got %+v", results[0])
	}
	if results[1].Action != "matched" {
		t.Fatalf("second entry should fold into the first's new category, got %+v", results[1])
	}
	if results[1].Category != results[0].Category {
		t.Fatalf("second entry landed in %q, expected %q", results[1].Category, results[0].Category)
	}
	if len(updated) != len(categories)+1 {
		t.Fatalf("expected %d categories, got %d", len(categories)+1, len(updated))
	}

	created := findCategory(t, updated, results[0].Category)
	if created.Count != 2 {
		t.Errorf("count: got %d, want 2", created.Count)
	}
	if created.AvgImprovementMs != -70 {
		t.Errorf("avgImprovementMs: got %d, want -70", created.AvgImprovementMs)
	}
	if created.AvgImprovementPct != -3.5 {
		t.Errorf("avgImprovementPct: got %v, want -3.5", created.AvgImprovementPct)
	}
}

func TestMissingDeltaMsLeavesThatAverageAlone(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()
	before := findCategory(t, categories, "Tree Shaking")

	updated, _ := leaderboard.Categorize([]leaderboard.Improvement{{
		Name:        "Remove unused JavaScript",
		Description: "Tree-shook the main bundle and dropped dead code",
		DeltaPct:    -10,
		HasDeltaPct: true,
	}}, categories, embedder, threshold)

	after := findCategory(t, updated, "Tree Shaking")
	if after.Count != before.Count+1 {
		t.Errorf("count: got %d, want %d", after.Count, before.Count+1)
	}
	if after.AvgImprovementMs != before.AvgImprovementMs {
		t.Errorf("avgImprovementMs moved: got %d, want %d", after.AvgImprovementMs, before.AvgImprovementMs)
	}
	if after.AvgImprovementPct == before.AvgImprovementPct {
		t.Errorf("avgImprovementPct should have moved from %v", before.AvgImprovementPct)
	}
}

// The default order is times improved, count descending: how often a
// technique has worked matters more than how well it worked once. Average
// improvement only breaks a tie, and the name settles the rest.
func TestRerankCategoriesOrdersByTimesImproved(t *testing.T) {
	categories := []leaderboard.Category{
		{Name: "B", AvgImprovementPct: -5, Count: 10},
		{Name: "A", AvgImprovementPct: -20, Count: 1},
		{Name: "C", AvgImprovementPct: -5, Count: 20},
	}
	leaderboard.RerankCategories(categories)

	for i, expected := range []string{"C", "B", "A"} {
		if categories[i].Name != expected {
			t.Fatalf("position %d: got %q, want %q", i, categories[i].Name, expected)
		}
		if categories[i].Rank != i+1 {
			t.Errorf("rank at position %d: got %d, want %d", i, categories[i].Rank, i+1)
		}
	}
}

func TestRerankCategoriesBreaksTiesOnImprovementThenName(t *testing.T) {
	categories := []leaderboard.Category{
		{Name: "Zebra", AvgImprovementPct: -4, Count: 7},
		{Name: "Alpha", AvgImprovementPct: -4, Count: 7},
		{Name: "Middle", AvgImprovementPct: -9, Count: 7},
	}
	leaderboard.RerankCategories(categories)

	for i, expected := range []string{"Middle", "Alpha", "Zebra"} {
		if categories[i].Name != expected {
			t.Fatalf("position %d: got %q, want %q", i, categories[i].Name, expected)
		}
	}
}

// The disease this replaced: a row per widget. Five submissions that are all
// "lazy-load one thing on my site" must land on one row, and the row must be
// named after the technique.
func TestSiteSpecificLazyLoadSubmissionsShareOneCategory(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()
	before := findCategory(t, categories, "Lazy-Load Components")

	submitted := []leaderboard.Improvement{
		{Name: "Lazy-load Chat Side-pane Components", Description: "Dynamically import Overview, FileNav and CallOverlay in the chat controls",
			DeltaMs: -222, HasDeltaMs: true, DeltaPct: -6.7, HasDeltaPct: true},
		{Name: "Lazy-load Mermaid Runtime", Description: "The mermaid-to-excalidraw chunk is no longer on the boot critical path",
			DeltaMs: -613, HasDeltaMs: true, DeltaPct: -9.6, HasDeltaPct: true},
		{Name: "Lazy-load the Settings Modal", Description: "The settings modal and its form library load when opened",
			DeltaMs: -100, HasDeltaMs: true, DeltaPct: -2.9, HasDeltaPct: true},
	}
	updated, results := leaderboard.Categorize(submitted, categories, embedder, threshold)

	for i, result := range results {
		if result.Category != "Lazy-Load Components" {
			t.Errorf("results[%d] (%q) landed on %q, want %q", i, result.Input, result.Category, "Lazy-Load Components")
		}
		if result.Action != "matched" {
			t.Errorf("%q should fold into the existing bucket, got %q", result.Input, result.Action)
		}
	}
	if len(updated) != len(categories) {
		t.Fatalf("three lazy-load submissions created %d categories, want 0", len(updated)-len(categories))
	}

	after := findCategory(t, updated, "Lazy-Load Components")
	if after.Count != before.Count+len(submitted) {
		t.Errorf("count: got %d, want %d", after.Count, before.Count+len(submitted))
	}
	expectedMs, expectedPct := foldAll(before, submitted)
	if after.AvgImprovementMs != expectedMs {
		t.Errorf("avgImprovementMs: got %d, want %d", after.AvgImprovementMs, expectedMs)
	}
	if after.AvgImprovementPct != expectedPct {
		t.Errorf("avgImprovementPct: got %v, want %v", after.AvgImprovementPct, expectedPct)
	}
}

// foldAll mirrors the running-average fold the leaderboard applies, so a test
// can predict where a series of submissions lands without hardcoding it.
func foldAll(start leaderboard.Category, improvements []leaderboard.Improvement) (int, float64) {
	count := float64(start.Count)
	ms, pct := float64(start.AvgImprovementMs), start.AvgImprovementPct
	for _, improvement := range improvements {
		if improvement.HasDeltaMs {
			ms = math.Floor((ms*count+improvement.DeltaMs)/(count+1) + 0.5)
		}
		if improvement.HasDeltaPct {
			pct = math.Floor((pct*count+improvement.DeltaPct)/(count+1)*10+0.5) / 10
		}
		count++
	}
	return int(ms), pct
}

// Jacob's three examples, end to end through ingest.
func TestSubmittedNamesAreStoredAsGenericTechniques(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()

	_, results := leaderboard.Categorize([]leaderboard.Improvement{
		{Name: "Inline the Shared Stylesheet (re-test After Landscape Change)",
			Description: "build.inlineStylesheets:'always' removes both render-blocking CSS requests",
			DeltaPct:    -9.4, HasDeltaPct: true},
		{Name: "Lazy-load Hidden 262KB Changelog Rocket.gif",
			Description: "A 512x512 262KB animated GIF was eagerly fetched to paint a 48x48 decoration",
			DeltaPct:    -47.3, HasDeltaPct: true},
		{Name: "Lazy-load Chat Side-pane Components",
			Description: "Dynamically import the chat side-pane tabs only when opened",
			DeltaPct:    -6.7, HasDeltaPct: true},
	}, categories, embedder, threshold)

	expected := []string{"Inline Shared Stylesheets", "Lazy-Load Unseen Images", "Lazy-Load Components"}
	for i, want := range expected {
		if results[i].Category != want {
			t.Errorf("results[%d] (%q) landed on %q, want %q", i, results[i].Input, results[i].Category, want)
		}
	}
}

// A submitter who already used a name the board carries must land on that row,
// not on a rule's synonym for it.
func TestAnExistingGenericNameWinsOverARuleSynonym(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()
	before := findCategory(t, categories, "Gzip / Brotli Compression")

	updated, results := leaderboard.Categorize([]leaderboard.Improvement{{
		Name: "Gzip / Brotli Compression", Description: "Turned on text compression at the origin",
		DeltaPct: -12, HasDeltaPct: true,
	}}, categories, embedder, threshold)

	if results[0].Action != "matched" || results[0].Category != "Gzip / Brotli Compression" {
		t.Fatalf("expected a fold into the existing row, got %+v", results[0])
	}
	if after := findCategory(t, updated, "Gzip / Brotli Compression"); after.Count != before.Count+1 {
		t.Errorf("count: got %d, want %d", after.Count, before.Count+1)
	}
	if len(updated) != len(categories) {
		t.Errorf("no category should have been created, got %d new", len(updated)-len(categories))
	}
}

func TestTitleCaseCategoryName(t *testing.T) {
	cases := map[string]string{
		"inline critical css":           "Inline Critical CSS",
		"preconnect to the font origin": "Preconnect to the Font Origin",
		"serve avif and webp images":    "Serve AVIF and WebP Images",
		"  http2   server push  ":       "HTTP/2 Server Push",
	}
	for input, expected := range cases {
		if got := leaderboard.TitleCaseCategoryName(input); got != expected {
			t.Errorf("TitleCaseCategoryName(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestCreatedCategoryFallsBackToACommunityDescription(t *testing.T) {
	categories := fixtureCategories(t)
	embedder, threshold := localEmbedder()

	updated, results := leaderboard.Categorize([]leaderboard.Improvement{{
		Name:        "buy a faster office chair",
		DeltaPct:    -2,
		HasDeltaPct: true,
	}}, categories, embedder, threshold)

	if results[0].Action != "created" {
		t.Fatalf("expected a created category, got %+v", results[0])
	}
	created := findCategory(t, updated, "Buy a Faster Office Chair")
	if created.Description != "Community-submitted: Buy a Faster Office Chair" {
		t.Errorf("description: got %q", created.Description)
	}
}
