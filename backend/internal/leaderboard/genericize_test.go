package leaderboard_test

import (
	"testing"

	"makefaster/internal/leaderboard"
)

// The three names Jacob called out on the live board, plus the rest of the
// same spirit: the stored name must be a technique another site could reuse
// verbatim.
func TestGenericCategoryNameRewritesSiteSpecificNames(t *testing.T) {
	cases := map[string]string{
		"Inline the Shared Stylesheet (re-test After Landscape Change)": "Inline Shared Stylesheets",
		"Lazy-load Chat Side-pane Components":                           "Lazy-Load Components",
		"Lazy-load Hidden 262KB Changelog Rocket.gif":                   "Lazy-Load Unseen Images",

		"Gzip-precompressed static assets":                      "Precompress Static Assets",
		"Gzip Precompress Frontend Static Assets":               "Precompress Static Assets",
		"Enable Gzip Text Compression on the Production Server": "Enable Gzip Compression",
		"Gzip Dynamic API JSON Responses by Default":            "Enable Gzip Compression",
		"Prefer Brotli Over Gzip":                               "Enable Brotli Compression",
		"ETag Conditional Responses for the Component Registry": "ETag Conditional Responses",
		"Import highlight.js/lib/common":                        "Subset Syntax-Highlighter Bundle",
		"Highlight.js Common Subset":                            "Subset Syntax-Highlighter Bundle",
		"Trim Preloaded Font Payload":                           "Reduce Font Payload",
		"Cut Playfair Display From 4 Font Weights to 1":         "Reduce Font Payload",
		"Self-host Boot-path Fonts":                             "Self-Host Critical Fonts",
		"Remove Duplicate 1MB Basic_examples Fetch":             "Skip Redundant Fetches",
		"Hydrate Non-critical Islands on Idle Instead of Load":  "Optimize Hydration Strategy",
		"Version and Immutably Cache Shell Assets":              "Content-Hashed Immutable Assets",
		"Deduplicate Render-blocking CSS Bundles":               "Remove Duplicate CSS Bundles",
		"Minify Boot-shell SVG Paths":                           "Compress SVG Assets",
		"Static Welcome-screen Boot Shell":                      "Inline Critical HTML Shell",
		"Evict Remaining Non-boot JS From the Entry Bundle":     "Cut Critical-Path JavaScript",
	}
	for input, expected := range cases {
		if got := leaderboard.GenericCategoryName(input); got != expected {
			t.Errorf("GenericCategoryName(%q) = %q, want %q", input, got, expected)
		}
	}
}

// The point of the lazy-load buckets is that no widget, image or vendor ever
// gets a row of its own.
func TestLazyLoadFamilyFoldsIntoAFixedSetOfBuckets(t *testing.T) {
	buckets := map[string][]string{
		"Lazy-Load Components": {
			"Lazy-load Chat Side-pane Components",
			"Lazy-load the Settings Modal",
			"Lazily load the JSON editor cluster",
			"Defer the code-editor modal",
			"Dynamically import the auto-layout library",
			"Lazy-load Mermaid Runtime",
		},
		"Lazy-Load Unseen Images": {
			"Lazy-load Hidden 262KB Changelog Rocket.gif",
			"Lazy-load below-the-fold images",
			"Defer offscreen thumbnails",
			"Lazy-load the hero banner",
		},
		"Lazy-Load Third-Party SDKs": {
			"Lazy-load the chat widget",
			"Defer the third-party payments SDK",
			"Lazy-load the video embed",
		},
		"Defer Analytics Loading": {
			"Lazy-load Amplitude analytics",
			"Defer the tracking beacon",
			"Lazy-load Google Tag Manager",
		},
		"Defer Unused Data Fetches": {
			"Defer the app-list prefetch",
			"Lazy-load the component registry fetch",
			"Defer non-critical API requests",
		},
	}

	seen := map[string]struct{}{}
	for expected, inputs := range buckets {
		seen[expected] = struct{}{}
		for _, input := range inputs {
			if got := leaderboard.GenericCategoryName(input); got != expected {
				t.Errorf("GenericCategoryName(%q) = %q, want %q", input, got, expected)
			}
		}
	}
	if len(seen) != 5 {
		t.Fatalf("the lazy-load family must fold into 5 buckets, got %d", len(seen))
	}
}

// Sanitization is mechanical: it strips the parts of a name that describe one
// repo, and leaves everything else alone.
func TestGenericCategoryNameStripsAsidesMeasurementsAndIdentifiers(t *testing.T) {
	cases := map[string]string{
		"Precompile route manifests (second attempt)":  "Precompile Route Manifests",
		"Precompile route manifests [re-test]":         "Precompile Route Manifests",
		"Trim the 262KB polyfill payload":              "Trim the Polyfill Payload",
		"Split the 1.8MB vendor chunk":                 "Split the Vendor Chunk",
		"Drop the moment.js dependency":                "Drop the Dependency",
		"Stop rendering basic_examples on boot":        "Stop Rendering on Boot",
		"Trim src/app/legacy/panel.tsx from the graph": "Trim From the Graph",
		"Rewrite the es2015 transpile target":          "Rewrite the Transpile Target",
	}
	for input, expected := range cases {
		if got := leaderboard.GenericCategoryName(input); got != expected {
			t.Errorf("GenericCategoryName(%q) = %q, want %q", input, got, expected)
		}
	}
}

// Nothing above may mangle a name that was already a generic technique — that
// includes every name in the bundled checklist and the acronym spellings the
// board uses.
func TestAlreadyGenericNamesSurviveUnchanged(t *testing.T) {
	for _, name := range []string{
		"Tree Shaking",
		"Image Optimization",
		"Cache Header Improvements",
		"Minification",
		"CDN Usage",
		"Reduce Redirects",
		"Resource Preloading",
		"Remove Unused CSS",
		"HTTP/2 Server Push",
		"HTTP/3 / QUIC Migration",
		"AVIF / WebP Image Formats",
		"Responsive srcset Images",
		"Reduce DOM Size",
		"Virtualize Long Lists",
		"Streaming SSR",
		"Preload LCP Image",
		"OffscreenCanvas Rendering",
		"Remove Unused JavaScript",
		"Trim Polyfill Payload",
		"Batch API Requests",
	} {
		if got := leaderboard.GenericCategoryName(name); got != name {
			t.Errorf("GenericCategoryName(%q) = %q, want it unchanged", name, got)
		}
	}
}

// A name that is nothing but strippable parts must not become an empty
// category.
func TestNameMadeOnlyOfStrippablePartsIsKept(t *testing.T) {
	for _, name := range []string{"rocket.gif", "262KB", "(re-test)"} {
		if got := leaderboard.GenericCategoryName(name); got == "" {
			t.Errorf("GenericCategoryName(%q) returned an empty name", name)
		}
	}
}
