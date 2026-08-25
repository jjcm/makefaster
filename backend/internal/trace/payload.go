package trace

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ValidationError is a rejected trace: the messages are returned verbatim as
// the `errors` array of a 400 response.
type ValidationError struct {
	Errors []string
}

func (e *ValidationError) Error() string { return strings.Join(e.Errors, "; ") }

func invalid(errors ...string) *ValidationError { return &ValidationError{Errors: errors} }

// toolTransportKeys are the fields a client would use to send a tool
// transcript, a build log, or the contents of a file. None of them is part of a
// trace, and a payload carrying one is not a client that needs its trace
// trimmed — it is a client sending the wrong thing, so it is refused with the
// reason rather than quietly stripped.
var toolTransportKeys = map[string]bool{
	"messages":     true,
	"conversation": true,
	"transcript":   true,
	"toolcalls":    true,
	"tool_calls":   true,
	"tooluse":      true,
	"tool_use":     true,
	"toolresults":  true,
	"tool_results": true,
	"toolresult":   true,
	"tool_result":  true,
	"toolouput":    true,
	"tooloutput":   true,
	"tool_output":  true,
	"events":       true,
	"stdout":       true,
	"stderr":       true,
	"logs":         true,
	"buildlog":     true,
	"build_log":    true,
	"output":       true,
	"outputs":      true,
	"files":        true,
	"filecontents": true,
}

// toolBlockTypes are the block `type` values that mean "this is not a thought".
var toolBlockTypes = map[string]bool{
	"tool_use":          true,
	"tooluse":           true,
	"tool_result":       true,
	"toolresult":        true,
	"tool_call":         true,
	"toolcall":          true,
	"function_call":     true,
	"function_response": true,
	"tool":              true,
}

// DecodeSubmission validates a POST /api/submit-trace body:
//
//	{ runId?, product?, prUrl?, agent?, model?, round?, startedAt?,
//	  submittedAt?, resultsSubmitted?, diff?,
//	  thinking: [{ text } | "…"],
//	  results?: { northStar?, baseline?, final?, iterations? } }
//
// Every field is read by name. `thinking` is read for text; `results` is read
// into Results field by field. Anything else a client sends is not stored —
// and a client that sends a tool transcript is told so, because the alternative
// is a trace that silently is not what it claims to be.
//
// The runId is the client's when it gave one and the server's when it did not,
// so every stored trace has a name and a resubmission of the same run replaces
// its own trace rather than adding a copy.
func DecodeSubmission(body []byte, now time.Time) (Trace, error) {
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(string(body))))
	if err := decoder.Decode(&raw); err != nil || raw == nil {
		return Trace{}, invalid("payload must be a JSON object")
	}
	if decoder.More() {
		return Trace{}, invalid("body must be valid JSON")
	}

	var refused []string
	for key := range raw {
		if toolTransportKeys[strings.ToLower(key)] {
			refused = append(refused, key)
		}
	}
	if len(refused) > 0 {
		return Trace{}, invalid(fmt.Sprintf(
			"a trace carries the agent's thinking text only; %s is a tool transcript and is not accepted",
			strings.Join(sorted(refused), ", ")))
	}

	blocks, err := decodeBlocks(raw["thinking"])
	if err != nil {
		return Trace{}, err
	}

	results, err := decodeResults(raw["results"])
	if err != nil {
		return Trace{}, err
	}

	if len(blocks) == 0 && results.Empty() {
		return Trace{}, invalid("thinking must be a non-empty array of reasoning blocks")
	}

	trace := Trace{
		RunID:            truncate(stringField(raw, "runId"), maxRunID),
		Source:           SourceCLI,
		Product:          truncate(stringField(raw, "product"), maxProduct),
		PRURL:            truncate(stringField(raw, "prUrl", "pr"), maxPRURL),
		Agent:            truncate(stringField(raw, "agent", "provider"), maxAgent),
		Model:            truncate(stringField(raw, "model"), maxModel),
		Round:            intField(raw, "round"),
		StartedAt:        timestamp(stringField(raw, "startedAt")),
		SubmittedAt:      timestamp(stringField(raw, "submittedAt")),
		ReceivedAt:       now.UTC().Format(time.RFC3339Nano),
		ResultsSubmitted: boolField(raw, "resultsSubmitted"),
		Results:          results,
	}
	if trace.RunID == "" {
		trace.RunID = NewRunID()
	}

	var notes []string
	trace.Thinking, notes = clampBlocks(blocks)

	diff, diffNotes := clampDiff(stringField(raw, "diff"))
	trace.Diff = diff
	notes = append(notes, diffNotes...)
	notes = append(notes, clampResults(trace.Results)...)
	trace.Truncated = dedupe(notes)
	if trace.Results.Empty() {
		trace.Results = nil
	}
	return trace, nil
}

// decodeBlocks reads `thinking`. A block may be a bare string or an object with
// a `text` — both shapes appear in the wild — and nothing else in the object is
// read. A block that announces itself as a tool call or a tool result is
// refused, for the same reason a tool transcript at the top level is.
func decodeBlocks(field json.RawMessage) ([]Block, error) {
	if len(field) == 0 {
		return nil, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(field, &entries); err != nil {
		return nil, invalid("thinking must be an array of reasoning blocks")
	}

	blocks := make([]Block, 0, len(entries))
	for i, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err == nil {
			blocks = append(blocks, Block{Text: text})
			continue
		}

		var object map[string]json.RawMessage
		if err := json.Unmarshal(entry, &object); err != nil {
			return nil, invalid(fmt.Sprintf("thinking[%d] must be a string or an object with a text field", i))
		}
		for key := range object {
			if toolTransportKeys[strings.ToLower(key)] {
				return nil, invalid(fmt.Sprintf(
					"thinking[%d].%s is tool output; a trace carries the agent's thinking text only", i, key))
			}
		}
		var blockType string
		_ = json.Unmarshal(object["type"], &blockType)
		if toolBlockTypes[strings.ToLower(strings.TrimSpace(blockType))] {
			return nil, invalid(fmt.Sprintf(
				"thinking[%d] is a %s block; a trace carries the agent's thinking text only", i, blockType))
		}

		var blockText string
		if len(object["text"]) > 0 {
			_ = json.Unmarshal(object["text"], &blockText)
		} else if len(object["thinking"]) > 0 {
			_ = json.Unmarshal(object["thinking"], &blockText)
		}
		blocks = append(blocks, Block{Text: blockText})
	}
	return blocks, nil
}

// decodeResults reads the optional results summary field by field, so the
// stored document holds the iteration list and both ends of the run and cannot
// hold anything else — not `notes`, not a log, not a file.
func decodeResults(field json.RawMessage) (*Results, error) {
	if len(field) == 0 || string(field) == "null" {
		return &Results{}, nil
	}
	var raw struct {
		NorthStar  string             `json:"northStar"`
		Baseline   map[string]Metrics `json:"baseline"`
		Final      map[string]Metrics `json:"final"`
		Iterations []Iteration        `json:"iterations"`
	}
	if err := json.Unmarshal(field, &raw); err != nil {
		return nil, invalid("results must be an object with optional northStar, baseline, final and iterations")
	}

	results := &Results{
		NorthStar: truncate(raw.NorthStar, maxPhase),
		Baseline:  raw.Baseline,
		Final:     raw.Final,
	}
	for _, iteration := range raw.Iterations {
		results.Iterations = append(results.Iterations, Iteration{
			Name:        truncate(iteration.Name, maxName),
			Description: truncate(iteration.Description, maxDescr),
			Kept:        iteration.Kept,
			DeltaMs:     iteration.DeltaMs,
			DeltaPct:    iteration.DeltaPct,
			Phase:       truncate(iteration.Phase, maxPhase),
			Generic:     iteration.Generic,
		})
	}
	return results, nil
}

func stringField(raw map[string]json.RawMessage, names ...string) string {
	for _, name := range names {
		if len(raw[name]) == 0 {
			continue
		}
		var value string
		if err := json.Unmarshal(raw[name], &value); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func intField(raw map[string]json.RawMessage, name string) int {
	if len(raw[name]) == 0 {
		return 0
	}
	var value float64
	if err := json.Unmarshal(raw[name], &value); err != nil || value < 0 || value > 1_000_000 {
		return 0
	}
	return int(value)
}

func boolField(raw map[string]json.RawMessage, name string) bool {
	if len(raw[name]) == 0 {
		return false
	}
	var value bool
	_ = json.Unmarshal(raw[name], &value)
	return value
}

func sorted(values []string) []string {
	out := append([]string(nil), values...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
