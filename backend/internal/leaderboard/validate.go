package leaderboard

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
)

// Limits on the public write endpoints. These are the system boundary, so
// everything is checked and clamped here; the rest of the server trusts
// validated values.
const (
	rawMsMax        = 600_000 // ten minutes — beyond that it's garbage, not slow
	deltaMsLimit    = 600_000
	deltaPctMin     = -100 // can't get more than 100% faster
	deltaPctMax     = 500
	improvementsMax = 50
	submitNameMax   = 120
	descriptionMax  = 500
)

// ValidationError is a rejected payload: the errors are returned verbatim as
// the `errors` array of a 400 response.
type ValidationError struct {
	Errors []string
}

func (e *ValidationError) Error() string {
	return strings.Join(e.Errors, "; ")
}

func invalid(errors ...string) *ValidationError {
	return &ValidationError{Errors: errors}
}

// DecodeObject reads a request body as a JSON object. Numbers are kept as
// json.Number so a quoted "1400" can be rejected the way the JSON API always
// has, instead of being silently coerced.
func DecodeObject(body []byte) (map[string]any, error) {
	// An empty body decodes to null, exactly as JSON.parse("") did, and falls
	// through to the "must be a JSON object" error below.
	var parsed any
	if trimmed := strings.TrimSpace(string(body)); trimmed != "" {
		decoder := json.NewDecoder(strings.NewReader(trimmed))
		decoder.UseNumber()
		if err := decoder.Decode(&parsed); err != nil {
			return nil, invalid("body must be valid JSON")
		}
		if decoder.More() {
			return nil, invalid("body must be valid JSON")
		}
	}

	object, isObject := parsed.(map[string]any)
	if !isObject {
		return nil, invalid("payload must be a JSON object")
	}
	return object, nil
}

// numberValue reports whether the field holds a JSON number, and its value.
// Literals too large for a float64 come back as ±Inf and are rejected by the
// range checks, matching JSON.parse("1e999") === Infinity.
func numberValue(field any) (float64, bool) {
	number, isNumber := field.(json.Number)
	if !isNumber {
		return 0, false
	}
	value, _ := number.Float64()
	return value, true
}

func finiteInRange(field any, min, max float64) bool {
	value, isNumber := numberValue(field)
	if !isNumber || math.IsNaN(value) || math.IsInf(value, 0) {
		return false
	}
	return value >= min && value <= max
}

func present(field any, exists bool) bool {
	return exists && field != nil
}

func isHTTPURL(field any) bool {
	value, isString := field.(string)
	if !isString || len(value) > 500 {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" || parsed.Scheme == "http"
}

// BaselineFromDelta recovers the pre-loop measurement a submission was
// compared against. The delta is the percent change from baseline to the
// measured value, so baseline = measured / (1 + delta/100).
//
// A delta of -100% or worse leaves nothing to divide by — that is a claim of
// infinite speedup, not a baseline — so the measured value is returned
// unchanged and the row reads as no recorded improvement. Nothing here
// invents a number the submitter did not imply.
func BaselineFromDelta(measured int, deltaPct float64) int {
	ratio := 1 + deltaPct/100
	if ratio <= 0 {
		return measured
	}
	return int(jsRound(float64(measured) / ratio))
}

// ValidateSitePayload checks a POST /api/submit-site body:
//
//	{ url, favicon?, name?, lcpBefore?, lcpRaw, lcpDelta,
//	  ttiBefore?, ttiRaw, ttiDelta, mode: cold|warm }
//
// lcpRaw/ttiRaw are the measurement after the loop and the deltas are
// percentages vs. the pre-loop baseline, negative = faster. lcpBefore/ttiBefore
// are that baseline; a client that does not send them (every CLI before this
// field existed) has it recovered from the delta.
func ValidateSitePayload(body map[string]any) (SiteSubmission, error) {
	var errors []string

	rawURL, _ := body["url"].(string)
	host, hostOK := NormalizeSiteURL(rawURL)
	if !hostOK {
		errors = append(errors, `url must be a valid public hostname, e.g. "example.com"`)
	}

	mode, _ := body["mode"].(string)
	if mode != "cold" && mode != "warm" {
		errors = append(errors, `mode must be "cold" or "warm"`)
	}

	if !finiteInRange(body["lcpRaw"], 0, rawMsMax) {
		errors = append(errors, fmt.Sprintf("lcpRaw must be a number of ms between 0 and %d", rawMsMax))
	}
	if !finiteInRange(body["ttiRaw"], 0, rawMsMax) {
		errors = append(errors, fmt.Sprintf("ttiRaw must be a number of ms between 0 and %d", rawMsMax))
	}
	if !finiteInRange(body["lcpDelta"], deltaPctMin, deltaPctMax) {
		errors = append(errors, fmt.Sprintf("lcpDelta must be a percentage between %d and %d (negative = faster)", deltaPctMin, deltaPctMax))
	}
	if !finiteInRange(body["ttiDelta"], deltaPctMin, deltaPctMax) {
		errors = append(errors, fmt.Sprintf("ttiDelta must be a percentage between %d and %d (negative = faster)", deltaPctMin, deltaPctMax))
	}

	lcpBefore, lcpBeforeExists := body["lcpBefore"]
	lcpBeforeGiven := present(lcpBefore, lcpBeforeExists)
	if lcpBeforeGiven && !finiteInRange(lcpBefore, 0, rawMsMax) {
		errors = append(errors, fmt.Sprintf("lcpBefore must be a number of ms between 0 and %d when provided", rawMsMax))
	}
	ttiBefore, ttiBeforeExists := body["ttiBefore"]
	ttiBeforeGiven := present(ttiBefore, ttiBeforeExists)
	if ttiBeforeGiven && !finiteInRange(ttiBefore, 0, rawMsMax) {
		errors = append(errors, fmt.Sprintf("ttiBefore must be a number of ms between 0 and %d when provided", rawMsMax))
	}

	favicon, faviconExists := body["favicon"]
	if present(favicon, faviconExists) && !isHTTPURL(favicon) {
		errors = append(errors, "favicon must be an http(s) URL when provided")
	}

	name, nameExists := body["name"]
	if present(name, nameExists) && !isShortName(name) {
		errors = append(errors, "name must be a short string when provided")
	}

	if len(errors) > 0 {
		return SiteSubmission{}, invalid(errors...)
	}

	lcpRaw, _ := numberValue(body["lcpRaw"])
	lcpDelta, _ := numberValue(body["lcpDelta"])
	ttiRaw, _ := numberValue(body["ttiRaw"])
	ttiDelta, _ := numberValue(body["ttiDelta"])

	submission := SiteSubmission{
		URL:      host,
		Mode:     mode,
		LCPRaw:   int(jsRound(lcpRaw)),
		LCPDelta: roundPct(lcpDelta),
		TTIRaw:   int(jsRound(ttiRaw)),
		TTIDelta: roundPct(ttiDelta),
	}
	submission.LCPBefore = BaselineFromDelta(submission.LCPRaw, submission.LCPDelta)
	if lcpBeforeGiven {
		value, _ := numberValue(lcpBefore)
		submission.LCPBefore = int(jsRound(value))
	}
	submission.TTIBefore = BaselineFromDelta(submission.TTIRaw, submission.TTIDelta)
	if ttiBeforeGiven {
		value, _ := numberValue(ttiBefore)
		submission.TTIBefore = int(jsRound(value))
	}
	if faviconString, ok := favicon.(string); ok && faviconString != "" {
		submission.Favicon = faviconString
	}
	if nameString, ok := name.(string); ok && strings.TrimSpace(nameString) != "" {
		submission.Name = strings.TrimSpace(nameString)
	}
	return submission, nil
}

func isShortName(field any) bool {
	value, isString := field.(string)
	if !isString {
		return false
	}
	return strings.TrimSpace(value) != "" && len([]rune(value)) <= 200
}

// ValidateImprovementsPayload checks a POST /api/submit-improvements body:
//
//	{ improvements: [{ name, description?, deltaMs?, deltaPct? }] }
//
// The endpoint is anonymous by design, so any url/site field a client sends is
// simply not read. Each entry needs a name and at least one delta (negative =
// faster).
func ValidateImprovementsPayload(body map[string]any) ([]Improvement, error) {
	entries, isArray := body["improvements"].([]any)
	if !isArray || len(entries) == 0 {
		return nil, invalid("improvements must be a non-empty array")
	}
	if len(entries) > improvementsMax {
		return nil, invalid(fmt.Sprintf("improvements is capped at %d entries per submission", improvementsMax))
	}

	var errors []string
	improvements := make([]Improvement, 0, len(entries))
	for i, raw := range entries {
		entry, isObject := raw.(map[string]any)
		if !isObject {
			errors = append(errors, fmt.Sprintf("improvements[%d] must be an object", i))
			continue
		}

		rawName, _ := entry["name"].(string)
		name := strings.TrimSpace(rawName)
		if name == "" || len([]rune(name)) > submitNameMax {
			errors = append(errors, fmt.Sprintf("improvements[%d].name must be a 1–%d character string", i, submitNameMax))
			continue
		}

		deltaMs, hasMs := entry["deltaMs"]
		hasMs = present(deltaMs, hasMs)
		deltaPct, hasPct := entry["deltaPct"]
		hasPct = present(deltaPct, hasPct)

		if hasMs && !finiteInRange(deltaMs, -deltaMsLimit, deltaMsLimit) {
			errors = append(errors, fmt.Sprintf("improvements[%d].deltaMs must be a number of ms (negative = faster)", i))
			continue
		}
		if hasPct && !finiteInRange(deltaPct, deltaPctMin, deltaPctMax) {
			errors = append(errors, fmt.Sprintf("improvements[%d].deltaPct must be a percentage (negative = faster)", i))
			continue
		}
		if !hasMs && !hasPct {
			errors = append(errors, fmt.Sprintf("improvements[%d] needs at least one of deltaMs or deltaPct", i))
			continue
		}

		description, descriptionExists := entry["description"]
		descriptionString, isString := description.(string)
		if present(description, descriptionExists) && !isString {
			errors = append(errors, fmt.Sprintf("improvements[%d].description must be a string when provided", i))
			continue
		}

		improvement := Improvement{
			Name:        name,
			Description: truncate(strings.TrimSpace(descriptionString), descriptionMax),
		}
		if hasMs {
			improvement.DeltaMs, _ = numberValue(deltaMs)
			improvement.HasDeltaMs = true
		}
		if hasPct {
			improvement.DeltaPct, _ = numberValue(deltaPct)
			improvement.HasDeltaPct = true
		}
		improvements = append(improvements, improvement)
	}

	if len(errors) > 0 {
		return nil, invalid(errors...)
	}
	return improvements, nil
}
