package leaderboard

import (
	"net/url"
	"regexp"
	"strings"
	"time"
)

const nameMax = 80

var (
	// A URL the submitter already gave a scheme to; anything else is assumed
	// to be a bare hostname and gets https:// prepended before parsing.
	schemePattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.\-]*://`)

	// A dotted hostname of sane DNS labels. localhost and other bare hosts are
	// fine for local testing but have no place on a public board.
	hostnamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
)

// NormalizeSiteURL reduces whatever the submitter sent
// ("https://Example.com/path", "www.example.com", "example.com") to a bare
// lowercase hostname. The second return is false when it cannot be read as a
// public hostname.
func NormalizeSiteURL(input string) (string, bool) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" || len(trimmed) > 300 {
		return "", false
	}

	candidate := trimmed
	if !schemePattern.MatchString(candidate) {
		candidate = "https://" + candidate
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return "", false
	}

	hostname := strings.ToLower(parsed.Hostname())
	hostname = strings.TrimPrefix(hostname, "www.")
	hostname = strings.TrimSuffix(hostname, ".")
	if !hostnamePattern.MatchString(hostname) || len(hostname) > 253 {
		return "", false
	}
	return hostname, true
}

// DisplayNameForURL turns "docs.example.com" into "Example" — the fallback
// used when a submission carries no display name.
func DisplayNameForURL(host string) string {
	labels := strings.Split(host, ".")
	core := labels[0]
	if len(labels) >= 2 {
		core = labels[len(labels)-2]
	}
	if core == "" {
		return core
	}
	return strings.ToUpper(core[:1]) + core[1:]
}

// DefaultFaviconForURL is the favicon shown when a submission omits one.
func DefaultFaviconForURL(host string) string {
	return "https://icons.duckduckgo.com/ip3/" + host + ".ico"
}

// UpsertSite folds one validated measurement into the row that already exists
// for this (url, mode), or builds a brand new one.
//
// An existing row keeps its derived name/favicon unless the submission
// overrides them, has its metrics replaced by the latest run, and increments
// its test counter. A new row starts at one test.
func UpsertSite(existing *SiteRow, submission SiteSubmission, now time.Time) SiteRow {
	row := SiteRow{
		URL:        submission.URL,
		LCPRaw:     submission.LCPRaw,
		LCPDelta:   submission.LCPDelta,
		TTIRaw:     submission.TTIRaw,
		TTIDelta:   submission.TTIDelta,
		Mode:       submission.Mode,
		Tests:      1,
		MeasuredAt: FormatTimestamp(now),
	}

	row.Name = truncate(firstNonEmpty(submission.Name, existingName(existing), DisplayNameForURL(submission.URL)), nameMax)
	row.Favicon = firstNonEmpty(submission.Favicon, existingFavicon(existing), DefaultFaviconForURL(submission.URL))
	if existing != nil {
		row.Tests = existing.Tests + 1
	}
	return row
}

func existingName(row *SiteRow) string {
	if row == nil {
		return ""
	}
	return row.Name
}

func existingFavicon(row *SiteRow) string {
	if row == nil {
		return ""
	}
	return row.Favicon
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// truncate caps a string at max characters, counting runes so a multi-byte
// character can never be cut in half.
func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}
