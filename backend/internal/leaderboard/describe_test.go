package leaderboard_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"makefaster/internal/leaderboard"
)

// liveDescription is one row of backend/testdata/category_descriptions.json:
// the description the public board carried before this change and the technique
// blurb migration 00004 replaces it with.
type liveDescription struct {
	Name string `json:"name"`
	Was  string `json:"was"`
	Now  string `json:"now"`
}

func fixtureDescriptions(t *testing.T) []liveDescription {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "category_descriptions.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var rows []liveDescription
	if err := json.Unmarshal(contents, &rows); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(rows) == 0 {
		t.Fatalf("%s is empty", path)
	}
	return rows
}

// Every description the live board carried is a changelog, and every
// replacement is a technique. This is the whole point of the change, checked
// against the real 20 rows rather than against invented examples.
func TestLiveBoardDescriptionsAreRewrittenAsTechniques(t *testing.T) {
	for _, row := range fixtureDescriptions(t) {
		if leaderboard.IsGenericDescription(row.Was) {
			t.Errorf("%q: the old description reads as generic, so nothing would flag it: %q", row.Name, row.Was)
		}
		if markers := leaderboard.SiteSpecificMarkers(row.Now); len(markers) > 0 {
			t.Errorf("%q: the new description is still site-specific (%v): %q", row.Name, markers, row.Now)
		}
		if len([]rune(row.Now)) > 160 {
			t.Errorf("%q: the new description is %d characters, over the 160 the column holds", row.Name, len([]rune(row.Now)))
		}
	}
}

// Migration 00004 and the catalog in describe.go have to say the same thing:
// the migration backfills the rows that predate the rule, ingest describes
// everything after it, and a row rewritten by one then folded by the other must
// not flip wording. The one exception is deliberate: migration 00008 folded the
// compression triplet onto Precompress Static Assets and re-described it, so
// for that row the catalog now writes the folded blurb, not 00004's.
func TestBackfilledDescriptionsMatchTheCatalogBlurb(t *testing.T) {
	supersededBy00008 := map[string]struct{}{
		"Precompress Static Assets": {},
	}
	matched := 0
	for _, row := range fixtureDescriptions(t) {
		blurb := leaderboard.CatalogDescription(row.Name)
		if blurb == "" {
			continue
		}
		if _, superseded := supersededBy00008[row.Name]; superseded {
			continue
		}
		matched++
		if blurb != row.Now {
			t.Errorf("%q: the migration backfills %q but ingest would write %q", row.Name, row.Now, blurb)
		}
	}
	if matched == 0 {
		t.Fatal("no fixture row matched a catalog technique; the lookup is broken")
	}
}

// A technique the catalog names must come with a blurb another site can act on.
func TestCatalogBlurbsAreGenericAndFitTheColumn(t *testing.T) {
	for _, name := range []string{
		"Lazy-Load Components", "Lazy-Load Unseen Images", "Lazy-Load Third-Party SDKs",
		"Defer Analytics Loading", "Defer Unused Data Fetches",
		"Precompress Static Assets", "Minify JavaScript", "Remove Unused CSS",
		"Content-Hashed Immutable Assets", "ETag Conditional Responses",
		"Reduce Font Payload", "Self-Host Critical Fonts", "Cut Critical-Path JavaScript",
		"Subset Syntax-Highlighter Bundle", "Skip Redundant Fetches",
		"Optimize Hydration Strategy", "Inline Critical HTML Shell", "Inline Critical CSS",
		"Inline Shared Stylesheets", "Remove Duplicate CSS Bundles", "Compress SVG Assets",
	} {
		blurb := leaderboard.CatalogDescription(name)
		if blurb == "" {
			t.Errorf("%q has no catalog description", name)
			continue
		}
		if markers := leaderboard.SiteSpecificMarkers(blurb); len(markers) > 0 {
			t.Errorf("%q: catalog description is site-specific (%v): %q", name, markers, blurb)
		}
		if len([]rune(blurb)) > 160 {
			t.Errorf("%q: catalog description is %d characters, over 160", name, len([]rune(blurb)))
		}
	}
}

// The wording of a name must not decide whether its blurb is found: the lookup
// keys on the same stems the fold does.
func TestCatalogDescriptionIgnoresNameWording(t *testing.T) {
	blurb := leaderboard.CatalogDescription("Inline Shared Stylesheets")
	for _, wording := range []string{
		"Inline the shared stylesheet",
		"inline shared stylesheets",
		"Inline Shared Stylesheet",
	} {
		if got := leaderboard.CatalogDescription(wording); got != blurb {
			t.Errorf("CatalogDescription(%q) = %q, want the shared-stylesheet blurb", wording, got)
		}
	}
}

// The markers, one kind at a time, so a failure says which rule stopped
// working.
func TestSiteSpecificDescriptionsAreDetected(t *testing.T) {
	cases := map[string]string{
		"module name":        "Removed the mermaid-to-excalidraw chunk from the boot path",
		"file name":          "Inline a static copy of the shell into index.html for first paint",
		"route path":         "The helper behind /api/v1/all answers conditionally now",
		"symbol":             "Turn on the compress_body middleware for every text response",
		"css declaration":    "The decoration is display:none on mobile, so defer it",
		"component name":     "AppInitPage asks for the same payload twice on boot",
		"source spelling":    "Drop the manualChunks pin so the chunk stays off the boot path",
		"byte size":          "Ship a 262KB animated GIF only when it is actually visible",
		"before and after":   "The home document goes 46.7KB -> 41.1KB on the wire",
		"approximate count":  "Group the ~270 chunks the client build emits into fewer files",
		"pixel dimensions":   "A 512x512 image paints a 48x48 slot, so resize it",
		"product noun":       "Load the Tailwind bundle once instead of twice",
		"font name":          "Cut Playfair Display to the single weight the page paints",
		"past-tense opener":  "Added versioned asset URLs with immutable cache headers",
		"past-tense body":    "The realtime client used the default transport order",
		"process footnote":   "Same change as iteration 4, re-tested after the fix landed",
		"empty":              "",
		"placeholder":        "Community-submitted: Buy a Faster Office Chair",
		"version identifier": "Retarget the build at es2015 so fewer polyfills ship",
	}
	for kind, description := range cases {
		if leaderboard.IsGenericDescription(description) {
			t.Errorf("%s went undetected: %q", kind, description)
		}
	}
}

// The other half of the same rule: technique prose has to survive, including
// the protocol, header and format spellings that look like identifiers.
func TestGenericDescriptionsAreLeftAlone(t *testing.T) {
	for _, description := range []string{
		"Compress text responses (HTML, JS, CSS, JSON) with gzip so first-load transfer is smaller.",
		"Send ETags on large JSON/API payloads and honor If-None-Match with 304 so warm loads skip the body.",
		"Combine tiny boot-time JS chunks so HTTP/1.1 request count and round trips stop dominating LCP.",
		"Open the realtime connection on WebSocket first (with polling fallback) instead of a long-poll handshake.",
		"Host LCP fonts on the same origin so the heading does not wait on extra DNS/TLS to a font CDN.",
		"Paint the LCP heading/logo from static HTML+CSS instead of waiting for the app bundle to mount it.",
		"Ship prebuilt .gz and .br siblings for static files",
		"Serve cached responses from regional POPs",
		"Minify inline and static SVGs so the document costs fewer bytes on the critical path.",
		"Embed the payloads the first paint reads into the shell document.",
		"Do not eagerly download images that are hidden, below the fold, or unused on the current viewport.",
	} {
		if markers := leaderboard.SiteSpecificMarkers(description); len(markers) > 0 {
			t.Errorf("%q was flagged as site-specific (%v)", description, markers)
		}
	}
}

// Both shipped catalogs are the model the board is supposed to look like, so
// neither may carry a description that names one repo.
func TestBundledCatalogDescriptionsAreGeneric(t *testing.T) {
	for _, path := range []string{
		filepath.Join("..", "..", "testdata", "categories.json"),
		filepath.Join("..", "..", "..", "packages", "cli", "data", "improvements.json"),
	} {
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var rows []leaderboard.Category
		if err := json.Unmarshal(contents, &rows); err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, row := range rows {
			if markers := leaderboard.SiteSpecificMarkers(row.Description); len(markers) > 0 {
				t.Errorf("%s: %q describes one repo (%v): %q", path, row.Name, markers, row.Description)
			}
		}
	}
}

// What ingest stores for a submission: the catalog blurb when the technique is
// one the board names, whatever generic prose the submitter wrote when it is
// not, and a placeholder when nothing survives.
func TestGenericCategoryDescription(t *testing.T) {
	cases := []struct {
		name      string
		submitted string
		want      string
	}{
		{
			name:      "Reduce Font Payload",
			submitted: "Playfair Display cut from 4 weights x 2 styles to the single 400-italic actually used",
			want:      leaderboard.CatalogDescription("Reduce Font Payload"),
		},
		{
			name:      "Reduce Font Payload",
			submitted: "",
			want:      leaderboard.CatalogDescription("Reduce Font Payload"),
		},
		{
			name:      "Merge Small JS Chunks",
			submitted: "Combine tiny boot-time JS chunks so request count stops dominating LCP",
			want:      "Combine tiny boot-time JS chunks so request count stops dominating LCP",
		},
		{
			name:      "Merge Small JS Chunks",
			submitted: "The client build emitted ~270 chunks over HTTP/1.1, so round trips dominated",
			want:      "Community-submitted: Merge Small JS Chunks",
		},
		{
			name:      "Buy a Faster Office Chair",
			submitted: "",
			want:      "Community-submitted: Buy a Faster Office Chair",
		},
	}
	for _, test := range cases {
		got := leaderboard.GenericCategoryDescription(test.name, test.submitted)
		if got != test.want {
			t.Errorf("GenericCategoryDescription(%q, %q) = %q, want %q", test.name, test.submitted, got, test.want)
		}
	}
}

// Salvage: a novel technique whose description carries one repo's file names in
// an otherwise reusable sentence keeps the sentence and loses the file names.
func TestNovelTechniqueDescriptionIsSalvagedWhenItCan(t *testing.T) {
	got := leaderboard.GenericCategoryDescription(
		"Precompile Route Manifests",
		"Precompile the route manifest lookup table in src/routes/manifest.ts at build time. Saves 21.1MB.",
	)
	want := "Precompile the route manifest lookup table at build time."
	if got != want {
		t.Errorf("GenericCategoryDescription() = %q, want %q", got, want)
	}
}
