package trace

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// A packed run is one directory per run, in the layout Speed Lab already writes
// when it exports a session:
//
//	<run>/meta.json      required — product, prUrl, agent, model, timestamps
//	<run>/thinking.jsonl required — one {"text": "…"} object per line, in order
//	<run>/results.json   optional — the run's results.json
//	<run>/diff.patch     optional — the unified patch, size-capped on import
//
// A backfill is a directory of those directories, or a tar (optionally gzipped)
// of the same tree. Nothing about the layout goes through the TUI, so a box can
// be filled from an scp without a single interactive run — and the caps and the
// whitelisting are the same ones POST /api/submit-trace applies, because the
// import produces the same Trace value.
const (
	metaFile     = "meta.json"
	thinkingFile = "thinking.jsonl"
	resultsFile  = "results.json"
	diffFile     = "diff.patch"
)

// maxPackedFileBytes is the ceiling on any single file inside a packed run.
// It is generous next to the trace caps on purpose: a file may be larger than
// what survives clamping, but it may not be a gigabyte.
const maxPackedFileBytes = 8 << 20

// packedMeta is the recognised content of meta.json. Unknown keys are ignored,
// so an exporter that records more than this does not have to be changed.
type packedMeta struct {
	RunID            string `json:"runId"`
	Run              string `json:"run"`
	Product          string `json:"product"`
	Site             string `json:"site"`
	PRURL            string `json:"prUrl"`
	PR               string `json:"pr"`
	Agent            string `json:"agent"`
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	Round            int    `json:"round"`
	StartedAt        string `json:"startedAt"`
	SubmittedAt      string `json:"submittedAt"`
	FinishedAt       string `json:"finishedAt"`
	ResultsSubmitted bool   `json:"resultsSubmitted"`
}

// packedRun is the raw bytes of one run's files, from a directory or a tar.
type packedRun struct {
	Name     string
	Meta     []byte
	Thinking []byte
	Results  []byte
	Diff     []byte
}

// LoadDir reads every packed run directly beneath root, in name order.
func LoadDir(root string) ([]Trace, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", root, err)
	}

	// A single run directory handed over directly is also accepted: it is what
	// someone re-importing one export will type.
	if fileExists(filepath.Join(root, metaFile)) || fileExists(filepath.Join(root, thinkingFile)) {
		run, err := readRunDir(root, filepath.Base(strings.TrimSuffix(root, string(filepath.Separator))))
		if err != nil {
			return nil, err
		}
		trace, err := run.trace()
		if err != nil {
			return nil, err
		}
		return []Trace{trace}, nil
	}

	traces := []Trace{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		run, err := readRunDir(filepath.Join(root, entry.Name()), entry.Name())
		if err != nil {
			return nil, err
		}
		if run == nil {
			continue
		}
		trace, err := run.trace()
		if err != nil {
			return nil, err
		}
		traces = append(traces, trace)
	}
	return traces, nil
}

func readRunDir(dir, name string) (*packedRun, error) {
	run := &packedRun{Name: name}
	var err error
	if run.Meta, err = readCapped(filepath.Join(dir, metaFile)); err != nil {
		return nil, err
	}
	if run.Thinking, err = readCapped(filepath.Join(dir, thinkingFile)); err != nil {
		return nil, err
	}
	if run.Results, err = readCapped(filepath.Join(dir, resultsFile)); err != nil {
		return nil, err
	}
	if run.Diff, err = readCapped(filepath.Join(dir, diffFile)); err != nil {
		return nil, err
	}
	if run.Meta == nil && run.Thinking == nil {
		return nil, nil // not a packed run, just a directory that happened to be here
	}
	return run, nil
}

// LoadTar reads packed runs from a tar or tar.gz stream. The first path segment
// of each entry is the run, so both `tar -cf runs.tar run-*/` and a tar with a
// wrapping directory import the same way.
func LoadTar(reader io.Reader, gzipped bool) ([]Trace, error) {
	if gzipped {
		unzipped, err := gzip.NewReader(reader)
		if err != nil {
			return nil, fmt.Errorf("read gzip: %w", err)
		}
		defer unzipped.Close()
		reader = unzipped
	}

	runs := map[string]*packedRun{}
	archive := tar.NewReader(reader)
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		cleaned := path.Clean(header.Name)
		if strings.HasPrefix(cleaned, "..") || path.IsAbs(cleaned) {
			return nil, fmt.Errorf("refusing tar entry outside the archive: %s", header.Name)
		}
		runName, file := path.Split(cleaned)
		runName = strings.Trim(runName, "/")
		if runName == "" {
			continue // a loose file at the archive root belongs to no run
		}
		switch file {
		case metaFile, thinkingFile, resultsFile, diffFile:
		default:
			continue
		}

		contents, err := io.ReadAll(io.LimitReader(archive, maxPackedFileBytes+1))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", cleaned, err)
		}
		if len(contents) > maxPackedFileBytes {
			return nil, fmt.Errorf("%s is larger than the %d byte per-file cap", cleaned, maxPackedFileBytes)
		}

		run := runs[runName]
		if run == nil {
			run = &packedRun{Name: path.Base(runName)}
			runs[runName] = run
		}
		switch file {
		case metaFile:
			run.Meta = contents
		case thinkingFile:
			run.Thinking = contents
		case resultsFile:
			run.Results = contents
		case diffFile:
			run.Diff = contents
		}
	}

	names := make([]string, 0, len(runs))
	for name := range runs {
		names = append(names, name)
	}
	sort.Strings(names)

	traces := []Trace{}
	for _, name := range names {
		trace, err := runs[name].trace()
		if err != nil {
			return nil, err
		}
		traces = append(traces, trace)
	}
	return traces, nil
}

// trace turns one packed run into the same validated value POST
// /api/submit-trace produces, so an imported trace and a submitted one are
// stored identically and clamped by identical rules.
func (r *packedRun) trace() (Trace, error) {
	var meta packedMeta
	if len(r.Meta) > 0 {
		if err := json.Unmarshal(r.Meta, &meta); err != nil {
			return Trace{}, fmt.Errorf("%s/%s: %w", r.Name, metaFile, err)
		}
	}

	blocks, err := readThinkingJSONL(r.Thinking)
	if err != nil {
		return Trace{}, fmt.Errorf("%s/%s: %w", r.Name, thinkingFile, err)
	}

	results, err := decodePackedResults(r.Results)
	if err != nil {
		return Trace{}, fmt.Errorf("%s/%s: %w", r.Name, resultsFile, err)
	}
	if len(blocks) == 0 && results.Empty() {
		return Trace{}, fmt.Errorf("%s: neither %s nor %s carried anything to store", r.Name, thinkingFile, resultsFile)
	}

	trace := Trace{
		RunID:            truncate(firstNonEmpty(meta.RunID, meta.Run, r.Name), maxRunID),
		Source:           SourceImport,
		Product:          truncate(firstNonEmpty(meta.Product, meta.Site), maxProduct),
		PRURL:            truncate(firstNonEmpty(meta.PRURL, meta.PR), maxPRURL),
		Agent:            truncate(firstNonEmpty(meta.Agent, meta.Provider), maxAgent),
		Model:            truncate(meta.Model, maxModel),
		Round:            meta.Round,
		StartedAt:        timestamp(meta.StartedAt),
		SubmittedAt:      timestamp(firstNonEmpty(meta.SubmittedAt, meta.FinishedAt)),
		ReceivedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		ResultsSubmitted: meta.ResultsSubmitted,
		Results:          results,
	}

	var notes []string
	trace.Thinking, notes = clampBlocks(blocks)
	diff, diffNotes := clampDiff(string(r.Diff))
	trace.Diff = diff
	notes = append(notes, diffNotes...)
	notes = append(notes, clampResults(trace.Results)...)
	trace.Truncated = dedupe(notes)
	if trace.Results.Empty() {
		trace.Results = nil
	}
	return trace, nil
}

// readThinkingJSONL reads thinking.jsonl: one block per line, in order. A line
// may be a JSON object with a `text` (what the CLI's own
// `.makefaster/thinking-trace.jsonl` writes) or a bare JSON string. A line that
// carries tool output is refused rather than stripped, exactly as the endpoint
// refuses one.
func readThinkingJSONL(contents []byte) ([]Block, error) {
	if len(contents) == 0 {
		return nil, nil
	}
	blocks := []Block{}
	for number, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" {
			continue
		}
		var text string
		if err := json.Unmarshal([]byte(line), &text); err == nil {
			blocks = append(blocks, Block{Text: text})
			continue
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &object); err != nil {
			return nil, fmt.Errorf("line %d is neither a JSON string nor a JSON object", number+1)
		}
		for key := range object {
			if toolTransportKeys[strings.ToLower(key)] {
				return nil, fmt.Errorf("line %d carries tool output (%s); a trace holds thinking text only", number+1, key)
			}
		}
		var blockType string
		_ = json.Unmarshal(object["type"], &blockType)
		if toolBlockTypes[strings.ToLower(strings.TrimSpace(blockType))] {
			return nil, fmt.Errorf("line %d is a %s block; a trace holds thinking text only", number+1, blockType)
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

// decodePackedResults reads a whole results.json through the same field-by-field
// whitelist the endpoint uses, so a packed run's `notes` and anything else the
// skill wrote for itself stay on Speed Lab's disk rather than entering the
// training set.
func decodePackedResults(contents []byte) (*Results, error) {
	if len(strings.TrimSpace(string(contents))) == 0 {
		return &Results{}, nil
	}
	return decodeResults(json.RawMessage(contents))
}

func readCapped(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}
	if info.IsDir() {
		return nil, nil
	}
	if info.Size() > maxPackedFileBytes {
		return nil, fmt.Errorf("%s is larger than the %d byte per-file cap", path, maxPackedFileBytes)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return contents, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
