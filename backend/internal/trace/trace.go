// Package trace holds the private reasoning traces a makefaster run may submit
// after it has answered the results question: the hidden agent's own chain of
// thought, kept so a small model can be post-trained on how the loop reasons.
//
// The whole package is built around one rule: a trace is thinking text and a
// short record of what was tried, and nothing else. There is no route that
// serves one, no board that renders one, and nothing here reaches the checklist
// the CLI imports — the same posture as the private catalog tips, and for a
// stronger reason: a trace is a user's reasoning about their own repository,
// handed over once, on purpose.
//
// Everything a client sends is whitelisted rather than filtered. `thinking` is
// read for text and nothing else; `results` is re-read field by field into
// Results below, so a tool transcript, a build log or a file dump cannot arrive
// by riding along in a key nobody thought to strip. A client that sends one
// deliberately is rejected outright (see DecodeSubmission).
package trace

import (
	"encoding/json"
	"strings"
	"time"
)

// The caps. They are the reason a 40 MB `yarn build` log cannot land here: the
// HTTP body limit stops the request, and everything that gets past it is
// clamped to a size that is still a chain of thought.
const (
	// MaxBlocks is how many thinking blocks one trace may carry.
	MaxBlocks = 400
	// MaxBlockChars is the ceiling on one block. Past this it is a transcript.
	MaxBlockChars = 8_000
	// MaxThinkingChars is the ceiling on all blocks together.
	MaxThinkingChars = 200_000
	// MaxIterations is how much of the keep/revert list is kept.
	MaxIterations = 200
	// MaxDiffBytes caps the unified patch a backfilled run may carry.
	MaxDiffBytes = 96 * 1024

	maxRunID   = 64
	maxProduct = 200
	maxPRURL   = 500
	maxAgent   = 40
	maxModel   = 120
	maxName    = 120
	maxDescr   = 500
	maxPhase   = 40
)

// truncationMarker ends a value that was clamped, so a reader of the stored
// document can tell a short thought from a cut one.
const truncationMarker = "\n…[truncated by makefaster]"

// Block is one block of reasoning. Text and only text: there is deliberately
// no field for a tool call, a tool result, or a file.
type Block struct {
	Text string `json:"text"`
}

// Metrics is one measurement of the north-star metrics, in the shape
// results.json writes them. Pointers so an absent metric stays absent rather
// than becoming a zero the training set would read as "0ms".
type Metrics struct {
	LCPMs *float64 `json:"lcpMs,omitempty"`
	TTIMs *float64 `json:"ttiMs,omitempty"`
	FCPMs *float64 `json:"fcpMs,omitempty"`
	TBTMs *float64 `json:"tbtMs,omitempty"`
}

// Iteration is one experiment: what was tried, what it measured, and whether it
// survived. `Notes` is deliberately absent — that is where the skill puts
// everything specific to one repository.
type Iteration struct {
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description,omitempty"`
	Kept        *bool    `json:"kept,omitempty"`
	DeltaMs     *float64 `json:"deltaMs,omitempty"`
	DeltaPct    *float64 `json:"deltaPct,omitempty"`
	Phase       string   `json:"phase,omitempty"`
	Generic     *bool    `json:"generic,omitempty"`
}

// Results is the distilled results.json a trace may carry: the iteration list
// with its keep/revert verdicts, and both ends of the run.
type Results struct {
	NorthStar  string             `json:"northStar,omitempty"`
	Baseline   map[string]Metrics `json:"baseline,omitempty"`
	Final      map[string]Metrics `json:"final,omitempty"`
	Iterations []Iteration        `json:"iterations,omitempty"`
}

// Empty reports whether there is nothing worth storing.
func (r *Results) Empty() bool {
	return r == nil || (r.NorthStar == "" && len(r.Baseline) == 0 && len(r.Final) == 0 && len(r.Iterations) == 0)
}

// Trace is one validated submission, and also the exact shape of the JSON
// document written under the private trace directory.
type Trace struct {
	RunID  string `json:"runId"`
	Source string `json:"source"`

	Product string `json:"product,omitempty"`
	PRURL   string `json:"prUrl,omitempty"`
	Agent   string `json:"agent,omitempty"`
	Model   string `json:"model,omitempty"`
	Round   int    `json:"round,omitempty"`

	StartedAt   string `json:"startedAt,omitempty"`
	SubmittedAt string `json:"submittedAt,omitempty"`
	ReceivedAt  string `json:"receivedAt"`

	// ResultsSubmitted records whether the same run also sent its numbers to
	// the public boards. Answering no to that and yes to this is a supported
	// combination, which is why it is stored rather than assumed.
	ResultsSubmitted bool `json:"resultsSubmitted"`

	Thinking []Block  `json:"thinking"`
	Results  *Results `json:"results,omitempty"`
	Diff     string   `json:"diff,omitempty"`

	// Truncated names what had to be clamped to fit the caps, so the stored
	// document is honest about being a partial record.
	Truncated []string `json:"truncated,omitempty"`
}

// ThinkingChars is the total length of the reasoning kept.
func (t Trace) ThinkingChars() int {
	total := 0
	for _, block := range t.Thinking {
		total += len([]rune(block.Text))
	}
	return total
}

// IterationCount is how much of the keep/revert list survived.
func (t Trace) IterationCount() int {
	if t.Results == nil {
		return 0
	}
	return len(t.Results.Iterations)
}

// clampBlocks applies the three thinking caps in order: per block, then count,
// then total. It returns the kept blocks and a note for each cap that bit.
func clampBlocks(blocks []Block) ([]Block, []string) {
	kept := make([]Block, 0, len(blocks))
	var notes []string
	total := 0

	for _, block := range blocks {
		text := strings.TrimSpace(block.Text)
		if text == "" {
			continue
		}
		if len(kept) >= MaxBlocks {
			notes = append(notes, "thinking: blocks past the cap were dropped")
			break
		}
		runes := []rune(text)
		if len(runes) > MaxBlockChars {
			runes = runes[:MaxBlockChars]
			text = string(runes) + truncationMarker
			notes = append(notes, "thinking: a block was longer than the per-block cap")
		}
		if total+len(runes) > MaxThinkingChars {
			notes = append(notes, "thinking: the total character cap was reached")
			break
		}
		total += len(runes)
		kept = append(kept, Block{Text: text})
	}
	return kept, dedupe(notes)
}

func clampDiff(diff string) (string, []string) {
	trimmed := strings.TrimSpace(diff)
	if len(trimmed) <= MaxDiffBytes {
		return trimmed, nil
	}
	return trimmed[:MaxDiffBytes] + truncationMarker, []string{"diff: truncated to the size cap"}
}

func clampResults(results *Results) []string {
	if results == nil || len(results.Iterations) <= MaxIterations {
		return nil
	}
	results.Iterations = results.Iterations[:MaxIterations]
	return []string{"results: iterations past the cap were dropped"}
}

func dedupe(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

// timestamp normalizes a client-supplied instant. An unparseable one is
// dropped rather than guessed at: ReceivedAt is always the server's own.
func timestamp(value string) string {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return ""
	}
	return parsed.UTC().Format(time.RFC3339Nano)
}

// Document renders the trace as the JSON written to the private directory.
func (t Trace) Document() ([]byte, error) {
	return json.MarshalIndent(t, "", "  ")
}
