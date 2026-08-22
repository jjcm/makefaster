package leaderboard_test

import (
	"testing"
	"time"

	"makefaster/internal/leaderboard"
)

func TestNormalizeSiteURL(t *testing.T) {
	valid := map[string]string{
		"example.com":                   "example.com",
		"https://Example.com/path?q=1":  "example.com",
		"www.example.com":               "example.com",
		"https://WWW.Example.COM":       "example.com",
		"http://docs.example.co.uk/a/b": "docs.example.co.uk",
		"  https://example.com.  ":      "example.com",
		"https://user:pass@example.com": "example.com",
		"https://example.com:8443":      "example.com",
	}
	for input, expected := range valid {
		host, ok := leaderboard.NormalizeSiteURL(input)
		if !ok || host != expected {
			t.Errorf("NormalizeSiteURL(%q) = (%q, %v), want (%q, true)", input, host, ok, expected)
		}
	}

	// Bare hosts have no place on a public board, and neither does junk.
	for _, input := range []string{
		"", "   ", "localhost", "localhost:3000", "http://localhost", "intranet",
		"http://[::1]", "not a hostname", "-example.com", "example-.com", "..",
	} {
		if host, ok := leaderboard.NormalizeSiteURL(input); ok {
			t.Errorf("NormalizeSiteURL(%q) unexpectedly accepted as %q", input, host)
		}
	}
}

func TestDisplayNameAndFaviconFallbacks(t *testing.T) {
	if got := leaderboard.DisplayNameForURL("docs.example.com"); got != "Example" {
		t.Errorf("DisplayNameForURL = %q, want %q", got, "Example")
	}
	if got := leaderboard.DisplayNameForURL("example.com"); got != "Example" {
		t.Errorf("DisplayNameForURL = %q, want %q", got, "Example")
	}
	want := "https://icons.duckduckgo.com/ip3/example.com.ico"
	if got := leaderboard.DefaultFaviconForURL("example.com"); got != want {
		t.Errorf("DefaultFaviconForURL = %q, want %q", got, want)
	}
}

func TestUpsertSiteDerivesDefaultsThenCountsTests(t *testing.T) {
	now := time.Date(2026, 8, 22, 2, 37, 56, 983_000_000, time.UTC)
	submission := leaderboard.SiteSubmission{
		URL: "speedy.example.com", Mode: "cold",
		LCPRaw: 1400, LCPDelta: -22, TTIRaw: 2300, TTIDelta: -17,
	}

	created := leaderboard.UpsertSite(nil, submission, now)
	if created.Name != "Example" {
		t.Errorf("name: got %q, want %q", created.Name, "Example")
	}
	if created.Favicon != "https://icons.duckduckgo.com/ip3/speedy.example.com.ico" {
		t.Errorf("favicon: got %q", created.Favicon)
	}
	if created.Tests != 1 {
		t.Errorf("tests: got %d, want 1", created.Tests)
	}
	if created.MeasuredAt != "2026-08-22T02:37:56.983Z" {
		t.Errorf("measuredAt: got %q", created.MeasuredAt)
	}

	// A second run replaces the metrics, keeps the derived identity, and
	// increments the counter.
	second := submission
	second.LCPRaw = 1300
	second.LCPDelta = -28
	updated := leaderboard.UpsertSite(&created, second, now.Add(time.Hour))
	if updated.Tests != 2 {
		t.Errorf("tests: got %d, want 2", updated.Tests)
	}
	if updated.LCPRaw != 1300 || updated.LCPDelta != -28 {
		t.Errorf("metrics were not replaced: %+v", updated)
	}
	if updated.Name != "Example" || updated.Favicon != created.Favicon {
		t.Errorf("derived identity changed: %+v", updated)
	}

	// An explicit name and favicon win over both the stored and derived values.
	third := submission
	third.Name = "Speedy"
	third.Favicon = "https://speedy.example.com/icon.png"
	overridden := leaderboard.UpsertSite(&updated, third, now)
	if overridden.Name != "Speedy" || overridden.Favicon != "https://speedy.example.com/icon.png" {
		t.Errorf("submission values did not win: %+v", overridden)
	}
	if overridden.Tests != 3 {
		t.Errorf("tests: got %d, want 3", overridden.Tests)
	}
}
