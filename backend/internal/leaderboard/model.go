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
type SiteRow struct {
	Name       string  `json:"name"`
	URL        string  `json:"url"`
	Favicon    string  `json:"favicon"`
	LCPBefore  int     `json:"lcpBefore"`
	LCPRaw     int     `json:"lcpRaw"`
	LCPDelta   float64 `json:"lcpDelta"`
	TTIBefore  int     `json:"ttiBefore"`
	TTIRaw     int     `json:"ttiRaw"`
	TTIDelta   float64 `json:"ttiDelta"`
	Mode       string  `json:"mode"`
	Tests      int     `json:"tests"`
	MeasuredAt string  `json:"measuredAt"`
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
// one and the value recovered from the delta when it did not.
type SiteSubmission struct {
	URL       string
	Mode      string
	LCPBefore int
	LCPRaw    int
	LCPDelta  float64
	TTIBefore int
	TTIRaw    int
	TTIDelta  float64
	Name      string
	Favicon   string
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
