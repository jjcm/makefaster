package embedding_test

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"makefaster/internal/embedding"
)

type category struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// loadCategories reads backend/testdata/categories.json: a frozen 50-row board
// that the threshold and reference-similarity tests below are pinned against.
// It is test-only — the committed public seed in data/ is empty.
func loadCategories(t *testing.T) []category {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "categories.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var categories []category
	if err := json.Unmarshal(contents, &categories); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return categories
}

// embeddingText mirrors leaderboard.EmbeddingText; duplicated here to keep the
// embedding package free of a dependency on the leaderboard types.
func embeddingText(name, description string) string {
	return name + ". " + name + ". " + description
}

func TestLocalIsDeterministicAndNormalized(t *testing.T) {
	a := embedding.Local("Enable Brotli compression for text assets")
	b := embedding.Local("Enable Brotli compression for text assets")

	if len(a) != len(b) {
		t.Fatalf("dimension mismatch: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("embedding is not deterministic at index %d: %v vs %v", i, a[i], b[i])
		}
	}

	norm := 0.0
	for _, v := range a {
		norm += v * v
	}
	if math.Abs(norm-1) > 1e-9 {
		t.Fatalf("expected unit norm, got %v", norm)
	}
}

func TestCosineSimilarityIdentityAndEmpty(t *testing.T) {
	a := embedding.Local("inline critical css")
	if similarity := embedding.CosineSimilarity(a, a); math.Abs(similarity-1) > 1e-9 {
		t.Fatalf("expected self-similarity 1, got %v", similarity)
	}
	if similarity := embedding.CosineSimilarity(a, embedding.Local("")); similarity != 0 {
		t.Fatalf("expected empty text to be orthogonal, got %v", similarity)
	}
}

func TestNewPicksLocalBackendAndHonorsThresholdOverride(t *testing.T) {
	embedder, threshold := embedding.New(embedding.Options{}, nil)
	if embedder.Kind() != "local" {
		t.Fatalf("expected local backend, got %q", embedder.Kind())
	}
	if embedder.ID() != "local-hash-v1" {
		t.Fatalf("expected id local-hash-v1, got %q", embedder.ID())
	}
	if threshold != embedding.DefaultThresholdLocal {
		t.Fatalf("expected threshold %v, got %v", embedding.DefaultThresholdLocal, threshold)
	}

	if _, overridden := embedding.New(embedding.Options{ThresholdOverride: 0.62}, nil); overridden != 0.62 {
		t.Fatalf("expected overridden threshold 0.62, got %v", overridden)
	}
}

func TestNewPicksRemoteBackendWhenKeyIsPresent(t *testing.T) {
	embedder, threshold := embedding.New(embedding.Options{
		APIKey:  "sk-test",
		Model:   "text-embedding-3-small",
		BaseURL: "https://api.openai.com/v1",
	}, nil)
	if embedder.Kind() != "remote" {
		t.Fatalf("expected remote backend, got %q", embedder.Kind())
	}
	if threshold != embedding.DefaultThresholdRemote {
		t.Fatalf("expected threshold %v, got %v", embedding.DefaultThresholdRemote, threshold)
	}
}

func bestMatch(t *testing.T, categories []category, name, description string) (string, float64) {
	t.Helper()
	vector := embedding.Local(embeddingText(name, description))
	bestName, bestSimilarity := "", math.Inf(-1)
	for _, candidate := range categories {
		similarity := embedding.CosineSimilarity(vector, embedding.Local(embeddingText(candidate.Name, candidate.Description)))
		if similarity > bestSimilarity {
			bestName, bestSimilarity = candidate.Name, similarity
		}
	}
	return bestName, bestSimilarity
}

// The load-bearing property, and what pins DefaultThresholdLocal: real-world
// paraphrases of known categories score above the threshold against their
// category, and genuinely novel improvements score below it against every
// category. Inputs mirror what the skill actually submits — a short name plus
// a one-line description.
func TestParaphrasesClearTheLocalThreshold(t *testing.T) {
	categories := loadCategories(t)
	paraphrases := []struct {
		name        string
		description string
		expect      []string
	}{
		{"Enable Brotli on text assets", "Enabled Brotli compression for HTML, CSS and JS responses", []string{"Gzip / Brotli Compression"}},
		{"Compress hero images", "Compressed and resized the oversized hero images", []string{"Image Optimization"}},
		{"Remove unused JavaScript", "Tree-shook the main bundle and dropped dead code", []string{"Tree Shaking"}},
		{"Inline critical CSS", "Inlined above-the-fold styles into the document head", []string{"Inline Critical CSS"}},
		{"Lazy load below-fold images", "Deferred offscreen images with loading=lazy", []string{"Lazy-Load Unseen Images"}},
		// The board buckets deferred third-party work by what is being
		// deferred, so either bucket is a correct home for this one.
		{"Defer third-party scripts", "Analytics and chat widgets now load after interactive", []string{"Lazy-Load Third-Party SDKs", "Defer Analytics Loading"}},
		{"Subset web fonts", "Shipped only the glyphs the pages actually use", []string{"Font Subsetting", "Reduce Font Payload"}},
		{"Serve AVIF images", "Switched product images from JPEG to AVIF format", []string{"AVIF / WebP Image Formats"}},
		{"Preload the LCP image", "Added a preload hint for the largest contentful paint image", []string{"Preload LCP Image", "Resource Preloading"}},
		{"Preconnect to font origin", "Added preconnect hints for the font CDN origin", []string{"Preconnect To Required Origins"}},
		{"Enable gzip on API responses", "Turned on gzip text compression for JSON API responses", []string{"Gzip / Brotli Compression", "Precompress Static Assets"}},
		{"Split bundle by route", "Split the vendor bundle along navigation route boundaries", []string{"Code Splitting By Route"}},
		{"Add service worker caching", "Cache the app shell and static assets for repeat visits", []string{"Service Worker Caching"}},
		{"Immutable cache for hashed assets", "Set long cache lifetimes on content-hashed static assets", []string{"Content-Hashed Immutable Assets", "Cache Header Improvements"}},
		{"Resize images at the CDN edge", "Moved image resizing and recompression to the edge", []string{"Image CDN Transformations"}},
	}

	for _, item := range paraphrases {
		name, similarity := bestMatch(t, categories, item.name, item.description)
		if similarity < embedding.DefaultThresholdLocal {
			t.Errorf("%q best=%s sim=%.3f — below threshold %v", item.name, name, similarity, embedding.DefaultThresholdLocal)
			continue
		}
		matched := false
		for _, expected := range item.expect {
			if name == expected {
				matched = true
				break
			}
		}
		if !matched {
			t.Errorf("%q matched %q (sim %.3f), expected one of %v", item.name, name, similarity, item.expect)
		}
	}
}

func TestNovelImprovementsStayBelowTheLocalThreshold(t *testing.T) {
	categories := loadCategories(t)
	novel := []struct{ name, description string }{
		{"Rewrite ORM in Rust", "Rewrote the ORM data layer in Rust"},
		{"Upgrade database hardware", "Upgraded the Postgres instance to a bigger machine"},
		{"Buy a faster office chair", "Bought a faster office chair for the developers"},
		{"Disable debug logging", "Disabled verbose debug logging in production"},
		{"Migrate newsletter vendor", "Migrated the newsletter signup to a new vendor"},
		{"Refactor checkout state machine", "Refactored the checkout state machine for clarity"},
		{"Add dark mode", "Added dark mode support to the settings screen"},
	}

	for _, item := range novel {
		name, similarity := bestMatch(t, categories, item.name, item.description)
		if similarity >= embedding.DefaultThresholdLocal {
			t.Errorf("%q unexpectedly matched %q at sim=%.3f (threshold %v)",
				item.name, name, similarity, embedding.DefaultThresholdLocal)
		}
	}
}

// The Node implementation this replaced produced these similarities for the
// same inputs against the frozen fixture board. They are recorded here so a
// change to the tokenizer, stemmer, feature weights, or hash seeds cannot
// silently move the boundary between "folds into a category" and "creates one".
func TestLocalMatchesTheReferenceSimilarities(t *testing.T) {
	categories := loadCategories(t)
	cases := []struct {
		name        string
		description string
		bestName    string
		similarity  float64
	}{
		{"Compress hero images", "Compressed and resized the oversized hero images", "Image Optimization", 0.664},
		{"Inline critical CSS", "Inlined above-the-fold styles into the document head", "Inline Critical CSS", 0.977},
		{"Subset web fonts", "Shipped only the glyphs the pages actually use", "Font Subsetting", 0.898},
	}

	for _, item := range cases {
		name, similarity := bestMatch(t, categories, item.name, item.description)
		rounded := math.Floor(similarity*1000+0.5) / 1000
		if name != item.bestName || rounded != item.similarity {
			t.Errorf("%q: got %q at %v, expected %q at %v", item.name, name, rounded, item.bestName, item.similarity)
		}
	}

	// Novel improvements are pinned by distance, not by which unrelated row
	// happens to be nearest: that depends on the fixture's contents, while the
	// property the threshold rests on is only that nothing comes close.
	novelName, novelSimilarity := bestMatch(t, categories, "Rewrite ORM in Rust", "Rewrote the ORM data layer in Rust")
	if novelSimilarity >= embedding.DefaultThresholdLocal/2 {
		t.Errorf("%q matched %q at %.3f — expected well under half the threshold %v",
			"Rewrite ORM in Rust", novelName, novelSimilarity, embedding.DefaultThresholdLocal)
	}
}
