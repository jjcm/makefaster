package leaderboard_test

import (
	"errors"
	"strings"
	"testing"

	"makefaster/internal/leaderboard"
)

func decode(t *testing.T, body string) map[string]any {
	t.Helper()
	parsed, err := leaderboard.DecodeObject([]byte(body))
	if err != nil {
		t.Fatalf("DecodeObject(%q): %v", body, err)
	}
	return parsed
}

func validationErrors(t *testing.T, err error) []string {
	t.Helper()
	var validation *leaderboard.ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("expected a ValidationError, got %v", err)
	}
	return validation.Errors
}

func TestDecodeObjectRejectsNonObjects(t *testing.T) {
	for body, expected := range map[string]string{
		"":           "payload must be a JSON object",
		"null":       "payload must be a JSON object",
		"[]":         "payload must be a JSON object",
		`"a string"`: "payload must be a JSON object",
		"not json":   "body must be valid JSON",
		`{"a":1}{}`:  "body must be valid JSON",
	} {
		_, err := leaderboard.DecodeObject([]byte(body))
		got := validationErrors(t, err)
		if len(got) != 1 || got[0] != expected {
			t.Errorf("DecodeObject(%q) errors = %v, want [%q]", body, got, expected)
		}
	}
}

func TestValidateSitePayloadAcceptsAndRounds(t *testing.T) {
	submission, err := leaderboard.ValidateSitePayload(decode(t, `{
		"url": "https://Example.com/path", "mode": "warm",
		"lcpRaw": 1750.6, "lcpDelta": -27.14, "ttiRaw": 3050.2, "ttiDelta": -21.86,
		"name": "  Example  ", "favicon": "https://example.com/favicon.ico"
	}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if submission.URL != "example.com" || submission.Mode != "warm" {
		t.Errorf("identity: %+v", submission)
	}
	if submission.LCPRaw != 1751 || submission.TTIRaw != 3050 {
		t.Errorf("raw ms should round to whole numbers: %+v", submission)
	}
	if submission.LCPDelta != -27.1 || submission.TTIDelta != -21.9 {
		t.Errorf("deltas should round to one decimal: %+v", submission)
	}
	if submission.Name != "Example" {
		t.Errorf("name should be trimmed: %q", submission.Name)
	}
}

func TestValidateSitePayloadReportsEveryProblem(t *testing.T) {
	_, err := leaderboard.ValidateSitePayload(decode(t, `{
		"url": "localhost", "mode": "hot",
		"lcpRaw": "1400", "lcpDelta": -900, "ttiRaw": 900000, "ttiDelta": null,
		"favicon": "ftp://example.com/icon.ico", "name": "", "prUrl": "not-a-url"
	}`))
	got := validationErrors(t, err)
	joined := strings.Join(got, "\n")

	for _, expected := range []string{
		`url must be a valid public hostname, e.g. "example.com"`,
		`mode must be "cold" or "warm"`,
		"lcpRaw must be a number of ms between 0 and 600000",
		"ttiRaw must be a number of ms between 0 and 600000",
		"lcpDelta must be a percentage between -100 and 500 (negative = faster)",
		"ttiDelta must be a percentage between -100 and 500 (negative = faster)",
		"favicon must be an http(s) URL when provided",
		"name must be a short string when provided",
		"prUrl must be an http(s) URL when provided",
	} {
		if !strings.Contains(joined, expected) {
			t.Errorf("missing error %q; got:\n%s", expected, joined)
		}
	}
}

func TestValidateSitePayloadTreatsOmittedOptionalsAsAbsent(t *testing.T) {
	submission, err := leaderboard.ValidateSitePayload(decode(t, `{
		"url": "example.com", "mode": "cold",
		"lcpRaw": 1000, "lcpDelta": -1, "ttiRaw": 2000, "ttiDelta": -2,
		"name": null, "favicon": null, "prUrl": null
	}`))
	if err != nil {
		t.Fatalf("explicit nulls should be treated as omitted, got %v", err)
	}
	if submission.Name != "" || submission.Favicon != "" || submission.PRURL != "" {
		t.Errorf("expected empty optionals, got %+v", submission)
	}
}

// The pull request the run was opened as, under either spelling: `prUrl` is
// what the schema documents, `pr` is what a submitter is just as likely to
// write, and losing the link over the field name would be a poor trade.
func TestValidateSitePayloadReadsThePullRequestUnderEitherName(t *testing.T) {
	metrics := `"url": "example.com", "mode": "cold", "lcpRaw": 1000, "lcpDelta": -1, "ttiRaw": 2000, "ttiDelta": -2`
	for _, field := range []string{"prUrl", "pr"} {
		body := "{" + metrics + `, "` + field + `": "  https://github.com/jjcm/immich/pull/1  "}`
		submission, err := leaderboard.ValidateSitePayload(decode(t, body))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", field, err)
		}
		if submission.PRURL != "https://github.com/jjcm/immich/pull/1" {
			t.Errorf("%s: got %q", field, submission.PRURL)
		}
	}

	// prUrl wins when both are present, and neither may be a javascript: URL.
	both := "{" + metrics + `, "prUrl": "https://github.com/jjcm/immich/pull/2", "pr": "https://github.com/jjcm/immich/pull/9"}`
	submission, err := leaderboard.ValidateSitePayload(decode(t, both))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if submission.PRURL != "https://github.com/jjcm/immich/pull/2" {
		t.Errorf("prUrl should win over pr, got %q", submission.PRURL)
	}
	if _, err := leaderboard.ValidateSitePayload(decode(t, "{"+metrics+`, "pr": "javascript:alert(1)"}`)); err == nil {
		t.Error("a javascript: URL must be rejected")
	}
}

// The two keep percentages are complementary, so either one implies the other,
// both zero means no split was reported, and a pair that does not add up is a
// broken client rather than a number to guess at.
func TestValidateSitePayloadReadsTheKeepSplit(t *testing.T) {
	metrics := `"url": "example.com", "mode": "cold", "lcpRaw": 1000, "lcpDelta": -1, "ttiRaw": 2000, "ttiDelta": -2`
	cases := []struct {
		fields               string
		generic, siteSpecifc int
	}{
		{`, "genericKeepPct": 80, "siteSpecificKeepPct": 20`, 80, 20},
		{`, "genericKeepPct": 80`, 80, 20},
		{`, "siteSpecificKeepPct": 20`, 80, 20},
		// All keeps site-specific: the pair still adds to 100.
		{`, "genericKeepPct": 0, "siteSpecificKeepPct": 100`, 0, 100},
		{`, "siteSpecificKeepPct": 100`, 0, 100},
		// Nothing kept, and nothing said: no split either way.
		{`, "genericKeepPct": 0, "siteSpecificKeepPct": 0`, 0, 0},
		{`, "genericKeepPct": 0`, 0, 0},
		{`, "genericKeepPct": null, "siteSpecificKeepPct": null`, 0, 0},
		{``, 0, 0},
		// Percentages are whole numbers on the board.
		{`, "genericKeepPct": 66.6`, 67, 33},
	}
	for _, test := range cases {
		submission, err := leaderboard.ValidateSitePayload(decode(t, "{"+metrics+test.fields+"}"))
		if err != nil {
			t.Errorf("%s: unexpected error: %v", test.fields, err)
			continue
		}
		if submission.GenericKeepPct != test.generic || submission.SiteSpecificKeepPct != test.siteSpecifc {
			t.Errorf("%s: got %d/%d, want %d/%d", test.fields,
				submission.GenericKeepPct, submission.SiteSpecificKeepPct, test.generic, test.siteSpecifc)
		}
	}

	for _, broken := range []string{
		`, "genericKeepPct": 80, "siteSpecificKeepPct": 80`,
		`, "genericKeepPct": 140`,
		`, "genericKeepPct": -10`,
		`, "genericKeepPct": "80"`,
	} {
		if _, err := leaderboard.ValidateSitePayload(decode(t, "{"+metrics+broken+"}")); err == nil {
			t.Errorf("%s should have been rejected", broken)
		}
	}
}

// Tips ride along with a site submission as notes to the catalog maintainers.
// They are best-effort by design: entries are clamped and malformed ones are
// dropped, because a bad tip must never cost a run its site row.
func TestValidateSitePayloadReadsTipsLeniently(t *testing.T) {
	metrics := `"url": "example.com", "mode": "cold", "lcpRaw": 1000, "lcpDelta": -1, "ttiRaw": 2000, "ttiDelta": -2`

	submission, err := leaderboard.ValidateSitePayload(decode(t, "{"+metrics+`, "tips": [
		{ "text": "  Enable Gzip duplicates Precompress Static Assets  ", "about": "  catalog  " },
		{ "text": "Skip SPA-internal rows when the bundle is prebuilt" },
		{ "text": "" },
		"not an object",
		{ "about": "no text at all" }
	]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(submission.Tips) != 2 {
		t.Fatalf("expected the 2 usable tips, got %+v", submission.Tips)
	}
	if submission.Tips[0].Text != "Enable Gzip duplicates Precompress Static Assets" || submission.Tips[0].About != "catalog" {
		t.Errorf("first tip should be trimmed: %+v", submission.Tips[0])
	}
	if submission.Tips[1].About != "" {
		t.Errorf("an omitted about stays empty: %+v", submission.Tips[1])
	}

	// Caps: 280 characters of text, 80 of about, 10 tips.
	long := strings.Repeat("y", 400)
	capped, err := leaderboard.ValidateSitePayload(decode(t,
		"{"+metrics+`, "tips": [{ "text": "`+long+`", "about": "`+strings.Repeat("z", 100)+`" }]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len([]rune(capped.Tips[0].Text)) != 280 || len([]rune(capped.Tips[0].About)) != 80 {
		t.Errorf("tip should be truncated to 280/80, got %d/%d",
			len([]rune(capped.Tips[0].Text)), len([]rune(capped.Tips[0].About)))
	}

	var entries []string
	for i := 0; i < 15; i++ {
		entries = append(entries, `{"text":"tip"}`)
	}
	many, err := leaderboard.ValidateSitePayload(decode(t, "{"+metrics+`, "tips": [`+strings.Join(entries, ",")+`]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(many.Tips) != 10 {
		t.Errorf("tips should be capped at 10, got %d", len(many.Tips))
	}

	// A tips field that is not an array is ignored rather than rejected, and a
	// payload without one carries no tips at all.
	for _, fields := range []string{`, "tips": "a string"`, `, "tips": null`, `, "tips": 4`, ``} {
		submission, err := leaderboard.ValidateSitePayload(decode(t, "{"+metrics+fields+"}"))
		if err != nil {
			t.Errorf("%s: unexpected error: %v", fields, err)
			continue
		}
		if submission.Tips != nil {
			t.Errorf("%s: expected no tips, got %+v", fields, submission.Tips)
		}
	}
}

func TestValidateImprovementsPayload(t *testing.T) {
	improvements, err := leaderboard.ValidateImprovementsPayload(decode(t, `{
		"url": "example.com",
		"improvements": [
			{ "name": "  Inline critical CSS  ", "description": "  Inlined above-the-fold styles  ",
			  "deltaMs": -260, "deltaPct": -10.8 },
			{ "name": "Preload the LCP image", "deltaPct": -4 }
		]
	}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(improvements) != 2 {
		t.Fatalf("expected 2 improvements, got %d", len(improvements))
	}
	if improvements[0].Name != "Inline critical CSS" || improvements[0].Description != "Inlined above-the-fold styles" {
		t.Errorf("expected trimmed text, got %+v", improvements[0])
	}
	if !improvements[0].HasDeltaMs || improvements[0].DeltaMs != -260 {
		t.Errorf("deltaMs: %+v", improvements[0])
	}
	if improvements[1].HasDeltaMs {
		t.Errorf("omitted deltaMs should stay omitted: %+v", improvements[1])
	}
}

func TestValidateImprovementsPayloadRejections(t *testing.T) {
	cases := map[string]string{
		`{}`:                                  "improvements must be a non-empty array",
		`{"improvements": []}`:                "improvements must be a non-empty array",
		`{"improvements": [1]}`:               "improvements[0] must be an object",
		`{"improvements": [{"deltaMs": -1}]}`: "improvements[0].name must be a 1–120 character string",
		`{"improvements": [{"name": "A"}]}`:   "improvements[0] needs at least one of deltaMs or deltaPct",
		`{"improvements": [{"name": "A", "deltaPct": -900}]}`:                "improvements[0].deltaPct must be a percentage (negative = faster)",
		`{"improvements": [{"name": "A", "deltaMs": "-1"}]}`:                 "improvements[0].deltaMs must be a number of ms (negative = faster)",
		`{"improvements": [{"name": "A", "deltaMs": -1, "description": 5}]}`: "improvements[0].description must be a string when provided",
	}
	for body, expected := range cases {
		_, err := leaderboard.ValidateImprovementsPayload(decode(t, body))
		got := validationErrors(t, err)
		if len(got) != 1 || got[0] != expected {
			t.Errorf("%s -> %v, want [%q]", body, got, expected)
		}
	}
}

func TestValidateImprovementsPayloadCapsBatchSize(t *testing.T) {
	var entries []string
	for i := 0; i < 51; i++ {
		entries = append(entries, `{"name":"Improvement","deltaPct":-1}`)
	}
	body := `{"improvements":[` + strings.Join(entries, ",") + `]}`
	_, err := leaderboard.ValidateImprovementsPayload(decode(t, body))
	got := validationErrors(t, err)
	if len(got) != 1 || got[0] != "improvements is capped at 50 entries per submission" {
		t.Errorf("got %v", got)
	}
}
