package trace_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"makefaster/internal/trace"
)

func now() time.Time {
	return time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
}

func decode(t *testing.T, body string) trace.Trace {
	t.Helper()
	submission, err := trace.DecodeSubmission([]byte(body), now())
	if err != nil {
		t.Fatalf("DecodeSubmission: %v", err)
	}
	return submission
}

func mustReject(t *testing.T, body, wants string) {
	t.Helper()
	_, err := trace.DecodeSubmission([]byte(body), now())
	var validation *trace.ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("expected a validation error for %s, got %v", body, err)
	}
	if !strings.Contains(strings.ToLower(validation.Error()), strings.ToLower(wants)) {
		t.Errorf("error %q does not mention %q", validation.Error(), wants)
	}
}

func TestDecodeSubmissionReadsThinkingAndTheIterationList(t *testing.T) {
	submission := decode(t, `{
		"runId": "run-1",
		"product": "Speedy",
		"prUrl": "https://github.com/jjcm/speedy/pull/3",
		"agent": "cursor",
		"model": "claude-fable-5",
		"round": 2,
		"startedAt": "2026-08-25T10:00:00.000Z",
		"resultsSubmitted": true,
		"thinking": [
			{"text": "  the hero image is the LCP element  "},
			"a bare string is a block too",
			{"thinking": "and so is one that spells the field the other way"},
			{"text": "   "}
		],
		"results": {
			"northStar": "lcp",
			"baseline": {"cold": {"lcpMs": 2400}},
			"final": {"cold": {"lcpMs": 2100}},
			"iterations": [{"name": "Preload the hero image", "kept": true, "deltaMs": -180, "notes": "src/app/hero.tsx line 42"}]
		}
	}`)

	if len(submission.Thinking) != 3 {
		t.Fatalf("blocks: got %d, want the 3 non-empty ones: %+v", len(submission.Thinking), submission.Thinking)
	}
	if submission.Thinking[0].Text != "the hero image is the LCP element" {
		t.Errorf("blocks are trimmed when they close: %q", submission.Thinking[0].Text)
	}
	if submission.RunID != "run-1" || submission.Product != "Speedy" || submission.Agent != "cursor" || submission.Round != 2 {
		t.Errorf("metadata: %+v", submission)
	}
	if submission.Source != trace.SourceCLI {
		t.Errorf("source: got %q, want %q", submission.Source, trace.SourceCLI)
	}
	if !submission.ResultsSubmitted {
		t.Error("resultsSubmitted should be recorded, because declining the results and sending a trace is a real answer")
	}
	if submission.ReceivedAt == "" {
		t.Error("the server stamps its own receipt time")
	}
	if submission.Results == nil || len(submission.Results.Iterations) != 1 || submission.Results.NorthStar != "lcp" {
		t.Fatalf("results: %+v", submission.Results)
	}

	// The iteration list is re-read field by field, so a `notes` full of file
	// paths cannot ride along into the training set.
	document, err := submission.Document()
	if err != nil {
		t.Fatalf("Document: %v", err)
	}
	if strings.Contains(string(document), "hero.tsx") || strings.Contains(string(document), "notes") {
		t.Errorf("the stored document kept an unrecognised field: %s", document)
	}
}

func TestDecodeSubmissionNamesAnUnnamedRun(t *testing.T) {
	first := decode(t, `{"thinking":["a thought"]}`)
	second := decode(t, `{"thinking":["a thought"]}`)
	if first.RunID == "" || second.RunID == "" {
		t.Fatal("every stored trace needs a name")
	}
	if first.RunID == second.RunID {
		t.Error("two unnamed runs must not collide, or one would overwrite the other")
	}
}

func TestDecodeSubmissionRefusesToolTranscripts(t *testing.T) {
	mustReject(t, `{"thinking":["t"],"messages":[{"role":"tool"}]}`, "tool transcript")
	mustReject(t, `{"thinking":["t"],"toolResults":[]}`, "tool transcript")
	mustReject(t, `{"thinking":["t"],"stdout":"yarn build"}`, "tool transcript")
	mustReject(t, `{"thinking":[{"type":"tool_result","text":"…"}]}`, "thinking text only")
	mustReject(t, `{"thinking":[{"text":"t","stderr":"…"}]}`, "thinking text only")
	mustReject(t, `{"thinking":[]}`, "non-empty array")
	mustReject(t, `{"thinking":"not an array"}`, "array of reasoning blocks")
	mustReject(t, `not json`, "must be a JSON object")
}

func TestDecodeSubmissionClampsEveryDimension(t *testing.T) {
	// One oversized block, then more blocks than the cap allows.
	blocks := []string{fmt.Sprintf("%q", strings.Repeat("y", trace.MaxBlockChars+1000))}
	for i := 0; i < trace.MaxBlocks+50; i++ {
		blocks = append(blocks, fmt.Sprintf("%q", fmt.Sprintf("thought %d", i)))
	}
	submission := decode(t, `{"runId":"clamped","thinking":[`+strings.Join(blocks, ",")+`]}`)

	if len(submission.Thinking) != trace.MaxBlocks {
		t.Errorf("blocks: got %d, want the cap of %d", len(submission.Thinking), trace.MaxBlocks)
	}
	if length := len([]rune(submission.Thinking[0].Text)); length <= trace.MaxBlockChars || length > trace.MaxBlockChars+40 {
		t.Errorf("the long block is %d characters, want the cap plus a marker", length)
	}
	if submission.ThinkingChars() > trace.MaxThinkingChars {
		t.Errorf("total characters %d exceeds the cap of %d", submission.ThinkingChars(), trace.MaxThinkingChars)
	}
	notes := strings.Join(submission.Truncated, " ")
	if !strings.Contains(notes, "per-block cap") || !strings.Contains(notes, "past the cap were dropped") {
		t.Errorf("the trace should say what was clamped, got %+v", submission.Truncated)
	}
}

func TestDecodeSubmissionTruncatesADiffAndCapsIterations(t *testing.T) {
	iterations := make([]string, 0, trace.MaxIterations+10)
	for i := 0; i < trace.MaxIterations+10; i++ {
		iterations = append(iterations, fmt.Sprintf(`{"name":"iteration %d","kept":false}`, i))
	}
	body := fmt.Sprintf(`{"runId":"big","thinking":["a thought"],"diff":%q,"results":{"iterations":[%s]}}`,
		strings.Repeat("+", trace.MaxDiffBytes+2000), strings.Join(iterations, ","))
	submission := decode(t, body)

	if len(submission.Diff) > trace.MaxDiffBytes+64 {
		t.Errorf("diff: %d bytes, want the cap of %d plus a marker", len(submission.Diff), trace.MaxDiffBytes)
	}
	if submission.IterationCount() != trace.MaxIterations {
		t.Errorf("iterations: got %d, want the cap of %d", submission.IterationCount(), trace.MaxIterations)
	}
	notes := strings.Join(submission.Truncated, " ")
	if !strings.Contains(notes, "diff") || !strings.Contains(notes, "iterations") {
		t.Errorf("expected the diff and the iteration list to be reported as clamped, got %+v", submission.Truncated)
	}
}

func TestVaultStoresOneDocumentPerRunPrivately(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "traces")
	// A nil pool is the file-only mode: it is what makes this test say something
	// about the document rather than about MariaDB.
	vault, err := trace.NewVault(dir, nil, nil)
	if err != nil {
		t.Fatalf("NewVault: %v", err)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the trace directory must be 0700: %v %v", info, err)
	}

	submission := decode(t, `{"runId":"run-9","thinking":["a thought worth keeping"]}`)
	record, err := vault.Save(context.Background(), submission, true)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !record.Created || record.ThinkingBlocks != 1 {
		t.Errorf("unexpected record: %+v", record)
	}
	if want := now().Format("2006-01") + "/run-9.json"; !strings.HasSuffix(record.Path, "run-9.json") {
		t.Errorf("path %q should be %q-shaped", record.Path, want)
	}

	absolute := filepath.Join(dir, filepath.FromSlash(record.Path))
	info, err := os.Stat(absolute)
	if err != nil {
		t.Fatalf("stat the document: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("the document is %o, want 600", info.Mode().Perm())
	}
	contents, _ := os.ReadFile(absolute)
	var stored trace.Trace
	if err := json.Unmarshal(contents, &stored); err != nil {
		t.Fatalf("the document must be readable JSON: %v", err)
	}
	if len(stored.Thinking) != 1 || stored.Thinking[0].Text != "a thought worth keeping" {
		t.Errorf("stored: %+v", stored)
	}

	// A re-import without --replace leaves the document alone, which is what
	// makes a re-run of an interrupted backfill safe.
	second := decode(t, `{"runId":"run-9","thinking":["a different thought"]}`)
	skipped, err := vault.Save(context.Background(), second, false)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if skipped.Created {
		t.Error("a repeat without replace should report that it stored nothing")
	}
	contents, _ = os.ReadFile(absolute)
	if strings.Contains(string(contents), "a different thought") {
		t.Error("a skipped save must not have rewritten the document")
	}
}

// A run id is client-supplied, so it must not be able to choose where its
// document lands.
func TestVaultRefusesToLetARunIDEscapeTheDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "traces")
	vault, err := trace.NewVault(dir, nil, nil)
	if err != nil {
		t.Fatalf("NewVault: %v", err)
	}

	submission := decode(t, `{"runId":"../../etc/passwd","thinking":["a thought"]}`)
	record, err := vault.Save(context.Background(), submission, true)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if strings.Contains(record.Path, "..") || strings.Contains(record.Path, "etc/passwd") {
		t.Fatalf("path escaped: %q", record.Path)
	}
	absolute := filepath.Join(dir, filepath.FromSlash(record.Path))
	if !strings.HasPrefix(absolute, dir+string(filepath.Separator)) {
		t.Fatalf("%q is outside %q", absolute, dir)
	}
	if _, err := os.Stat(absolute); err != nil {
		t.Fatalf("the document should still have been written: %v", err)
	}
}

func TestNewVaultReportsThatTracesAreOff(t *testing.T) {
	if _, err := trace.NewVault("", nil, nil); !errors.Is(err, trace.ErrTracesDisabled) {
		t.Errorf("an empty directory should disable collection, got %v", err)
	}
}

// The backfill layout, imported from a directory: one folder per run holding
// meta.json, thinking.jsonl, and optionally results.json and diff.patch.
func TestLoadDirImportsPackedRuns(t *testing.T) {
	root := t.TempDir()
	writePackedRun(t, filepath.Join(root, "2026-08-01-speedy"), map[string]string{
		"meta.json": `{"runId":"speedy-1","product":"Speedy","prUrl":"https://github.com/jjcm/speedy/pull/3",
			"agent":"claude","model":"claude-fable-5","round":1,"startedAt":"2026-08-01T09:00:00Z","resultsSubmitted":true}`,
		"thinking.jsonl": "{\"text\":\"the hero image is the LCP element\"}\n\"a bare string block\"\n\n{\"text\":\"preloading it beat the noise floor\"}\n",
		"results.json":   `{"northStar":"lcp","iterations":[{"name":"Preload the hero image","kept":true,"deltaMs":-180,"notes":"src/hero.tsx"}]}`,
		"diff.patch":     "--- a/index.html\n+++ b/index.html\n@@\n+<link rel=preload>\n",
	})
	// A directory that is not a packed run is ignored rather than failing an
	// otherwise good backfill.
	if err := os.MkdirAll(filepath.Join(root, "notes"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writePackedRun(t, filepath.Join(root, "2026-08-02-other"), map[string]string{
		"meta.json":      `{"product":"Other"}`,
		"thinking.jsonl": "{\"text\":\"a second run\"}\n",
	})

	traces, err := trace.LoadDir(root)
	if err != nil {
		t.Fatalf("LoadDir: %v", err)
	}
	if len(traces) != 2 {
		t.Fatalf("expected 2 runs, got %d", len(traces))
	}

	first := traces[0]
	if first.RunID != "speedy-1" || first.Product != "Speedy" || first.Agent != "claude" || !first.ResultsSubmitted {
		t.Errorf("metadata: %+v", first)
	}
	if first.Source != trace.SourceImport {
		t.Errorf("source: got %q, want %q", first.Source, trace.SourceImport)
	}
	if len(first.Thinking) != 3 {
		t.Errorf("blocks: got %d, want 3: %+v", len(first.Thinking), first.Thinking)
	}
	if first.Results == nil || len(first.Results.Iterations) != 1 {
		t.Fatalf("results: %+v", first.Results)
	}
	if !strings.Contains(first.Diff, "rel=preload") {
		t.Errorf("diff: %q", first.Diff)
	}
	document, _ := first.Document()
	if strings.Contains(string(document), "hero.tsx") {
		t.Errorf("an imported run's results.json goes through the same whitelist: %s", document)
	}

	// A run with no runId in meta.json is named after its directory, so a
	// re-import of the same export is still one trace rather than two.
	if traces[1].RunID != "2026-08-02-other" {
		t.Errorf("second run id: got %q, want the directory name", traces[1].RunID)
	}
}

func TestLoadDirRefusesAPackedRunFullOfToolOutput(t *testing.T) {
	root := t.TempDir()
	writePackedRun(t, filepath.Join(root, "bad-run"), map[string]string{
		"meta.json":      `{"runId":"bad"}`,
		"thinking.jsonl": "{\"text\":\"fine\"}\n{\"stdout\":\"webpack compiled with 4 warnings\"}\n",
	})
	_, err := trace.LoadDir(root)
	if err == nil || !strings.Contains(err.Error(), "thinking text only") {
		t.Fatalf("expected the import to refuse tool output, got %v", err)
	}
}

func TestLoadTarImportsTheSameLayout(t *testing.T) {
	files := map[string]string{
		"runs/speedy-1/meta.json":      `{"runId":"speedy-1","product":"Speedy"}`,
		"runs/speedy-1/thinking.jsonl": "{\"text\":\"one\"}\n{\"text\":\"two\"}\n",
		"runs/speedy-2/meta.json":      `{"runId":"speedy-2"}`,
		"runs/speedy-2/thinking.jsonl": "{\"text\":\"three\"}\n",
		"runs/README.md":               "not part of a run",
	}

	for _, gzipped := range []bool{false, true} {
		archive := buildTar(t, files, gzipped)
		traces, err := trace.LoadTar(bytes.NewReader(archive), gzipped)
		if err != nil {
			t.Fatalf("LoadTar(gzipped=%v): %v", gzipped, err)
		}
		if len(traces) != 2 {
			t.Fatalf("gzipped=%v: expected 2 runs, got %d", gzipped, len(traces))
		}
		if traces[0].RunID != "speedy-1" || len(traces[0].Thinking) != 2 {
			t.Errorf("gzipped=%v: first run %+v", gzipped, traces[0])
		}
		if traces[1].RunID != "speedy-2" || traces[1].Source != trace.SourceImport {
			t.Errorf("gzipped=%v: second run %+v", gzipped, traces[1])
		}
	}
}

func TestLoadTarRefusesAnEntryOutsideTheArchive(t *testing.T) {
	archive := buildTar(t, map[string]string{
		"../escape/thinking.jsonl": "{\"text\":\"nope\"}\n",
	}, false)
	if _, err := trace.LoadTar(bytes.NewReader(archive), false); err == nil {
		t.Fatal("expected a tar entry outside the archive to be refused")
	}
}

func writePackedRun(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	for name, contents := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

func buildTar(t *testing.T, files map[string]string, gzipped bool) []byte {
	t.Helper()
	var buffer bytes.Buffer
	var writer *tar.Writer
	var zipper *gzip.Writer
	if gzipped {
		zipper = gzip.NewWriter(&buffer)
		writer = tar.NewWriter(zipper)
	} else {
		writer = tar.NewWriter(&buffer)
	}

	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	for _, name := range names {
		contents := files[name]
		header := &tar.Header{Name: name, Mode: 0o600, Size: int64(len(contents)), Typeflag: tar.TypeReg}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatalf("tar header %s: %v", name, err)
		}
		if _, err := writer.Write([]byte(contents)); err != nil {
			t.Fatalf("tar write %s: %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if zipper != nil {
		if err := zipper.Close(); err != nil {
			t.Fatalf("close gzip: %v", err)
		}
	}
	return buffer.Bytes()
}
