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

func seedCategories(t *testing.T) []leaderboard.Category {
	t.Helper()
	path := filepath.Join("..", "..", "..", "data", "improvements.json")
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
	categories := seedCategories(t)
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
	categories := seedCategories(t)
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
	categories := seedCategories(t)
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
	categories := seedCategories(t)
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

func TestRerankCategoriesOrdersByAveragePct(t *testing.T) {
	categories := []leaderboard.Category{
		{Name: "B", AvgImprovementPct: -5, Count: 10},
		{Name: "A", AvgImprovementPct: -20, Count: 1},
		{Name: "C", AvgImprovementPct: -5, Count: 20},
	}
	leaderboard.RerankCategories(categories)

	for i, expected := range []string{"A", "C", "B"} {
		if categories[i].Name != expected {
			t.Fatalf("position %d: got %q, want %q", i, categories[i].Name, expected)
		}
		if categories[i].Rank != i+1 {
			t.Errorf("rank at position %d: got %d, want %d", i, categories[i].Rank, i+1)
		}
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
	categories := seedCategories(t)
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
