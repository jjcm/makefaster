// Package leaderboard holds the two public leaderboard shapes plus the pure
// logic that turns a submission into rows: URL normalization, site upsert,
// payload validation, and embedding-based improvement categorization.
//
// The JSON tags here are the public API contract — `js/api.js`, the
// `npx makefaster` CLI, and the committed seed files in data/ all read these
// exact keys.
package leaderboard

import "time"

// timestampLayout matches JavaScript's Date#toISOString, which is what the
// Node server wrote and what the SPA parses.
const timestampLayout = "2006-01-02T15:04:05.000Z"

// FormatTimestamp renders a measurement time the way the API always has.
func FormatTimestamp(t time.Time) string {
	return t.UTC().Format(timestampLayout)
}

// SiteRow is one row of the site leaderboard: the latest measured run for one
// site in one load mode.
//
// Each metric is stored at both ends of the run. LCPBefore/TTIBefore are the
// pre-loop baseline; LCPRaw/TTIRaw are the measurement after the last kept
// change — "raw" rather than "after" because that is the key the API has
// always used. The deltas are the percent change between the two, negative =
// faster.
//
// PRURL is the pull request the loop's changes were opened as, so a reader can
// go straight from the number to the diff that produced it. It is omitted from
// the JSON when there is none: most rows predate the field, and a row without a
// PR must not render a dead link.
//
// Favicon is the icon's URL at its own origin, as submitted or derived, and it
// is not what the board loads: FaviconPath is the same-origin path this server
// serves a downloaded, normalized copy from (see internal/favicon). It is
// filled in on the way out of GET /data/sites.json rather than stored, and is
// absent when this deployment caches no icons or the row's URL is not one the
// server will fetch — in which case the board draws the site's initial rather
// than hotlinking an origin that may well refuse the request.
//
// GenericKeepPct / SiteSpecificKeepPct split the run's kept changes into the
// ones that were reusable techniques and the ones that were only ever going to
// matter to this site. They sum to 100 when the run kept anything, and are both
// zero when it kept nothing or when the submission predates the fields — the
// same "nothing to show" either way, so both are omitted from the JSON.
type SiteRow struct {
	Name                string  `json:"name"`
	URL                 string  `json:"url"`
	PRURL               string  `json:"prUrl,omitempty"`
	GenericKeepPct      int     `json:"genericKeepPct,omitempty"`
	SiteSpecificKeepPct int     `json:"siteSpecificKeepPct,omitempty"`
	Favicon             string  `json:"favicon"`
	FaviconPath         string  `json:"faviconPath,omitempty"`
	LCPBefore           int     `json:"lcpBefore"`
	LCPRaw              int     `json:"lcpRaw"`
	LCPDelta            float64 `json:"lcpDelta"`
	TTIBefore           int     `json:"ttiBefore"`
	TTIRaw              int     `json:"ttiRaw"`
	TTIDelta            float64 `json:"ttiDelta"`
	Mode                string  `json:"mode"`
	Tests               int     `json:"tests"`
	MeasuredAt          string  `json:"measuredAt"`
}

// Category is one row of the improvement leaderboard.
type Category struct {
	Rank              int     `json:"rank"`
	Name              string  `json:"name"`
	Description       string  `json:"description"`
	Count             int     `json:"count"`
	AvgImprovementMs  int     `json:"avgImprovementMs"`
	AvgImprovementPct float64 `json:"avgImprovementPct"`
	Icon              string  `json:"icon"`
}

// SiteSubmission is a validated POST /api/submit-site body. Name and Favicon
// are empty when the submitter left them out, in which case the upsert derives
// them. LCPBefore/TTIBefore are the measured baseline when the submitter sent
// one and the value recovered from the delta when it did not. PRURL is empty
// unless the submitter linked the pull request the run produced, and the two
// keep percentages are zero unless the submitter reported the split.
//
// Tips are the run's private notes to the catalog maintainers (see Tip). They
// are stored and never served: not on either board, not in GET /data/*.json,
// and never in the checklist the CLI imports.
type SiteSubmission struct {
	URL                 string
	Mode                string
	LCPBefore           int
	LCPRaw              int
	LCPDelta            float64
	TTIBefore           int
	TTIRaw              int
	TTIDelta            float64
	Name                string
	Favicon             string
	PRURL               string
	GenericKeepPct      int
	SiteSpecificKeepPct int
	Tips                []Tip
}

// Tip is one note a run leaves for the Speed Lab about the catalog itself —
// "these two rows are one technique", "skip the JS rows when the SPA is
// prebuilt". About optionally names the category (or "catalog") the note is
// about. Tips are write-only through the public API: they inform how the
// catalog is refined (the way the compression triplet was folded), and they
// are never displayed anywhere or fed back to another agent.
type Tip struct {
	Text  string
	About string
}

// Improvement is one validated entry of POST /api/submit-improvements. The
// endpoint is anonymous by design: no URL or site identity survives
// validation. HasDeltaMs / HasDeltaPct distinguish "zero" from "omitted",
// which decides whether a running average is touched at all.
type Improvement struct {
	Name        string
	Description string
	DeltaMs     float64
	HasDeltaMs  bool
	DeltaPct    float64
	HasDeltaPct bool
}
