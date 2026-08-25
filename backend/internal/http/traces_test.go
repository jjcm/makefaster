package httpapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"makefaster/internal/embedding"
	httpapi "makefaster/internal/http"
	"makefaster/internal/store"
	"makefaster/internal/trace"
)

// bootWithTraces is `boot` plus a private trace vault rooted in a temporary
// directory, and it returns that directory so a test can look at what actually
// landed on disk.
func bootWithTraces(t *testing.T, pool *sql.DB) (*httptest.Server, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "traces")
	vault, err := trace.NewVault(dir, pool, nil)
	if err != nil {
		t.Fatalf("new vault: %v", err)
	}

	leaderboards := store.New(pool)
	if err := leaderboards.Seed(context.Background(), fixtureSeedDir()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	embedder, threshold := embedding.New(embedding.Options{}, nil)
	server := httpapi.NewServer(httpapi.Options{
		Store:       leaderboards,
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: frontendFixture(t),
		Traces:      vault,
	})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer, dir
}

func getRaw(t *testing.T, url string) (int, string) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// storedDocuments reads every trace document under the vault root, so a test can
// assert on what was written rather than on what the response said.
func storedDocuments(t *testing.T, dir string) []string {
	t.Helper()
	var documents []string
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".json" {
			return err
		}
		contents, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		info, statErr := entry.Info()
		if statErr != nil {
			return statErr
		}
		// A trace is private on disk, not only in the route table.
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s has mode %o, want 600", path, perm)
		}
		documents = append(documents, string(contents))
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return documents
}

const traceBody = `{
	"runId": "run-abc-123",
	"product": "Speedy",
	"prUrl": "https://github.com/jjcm/speedy/pull/7",
	"agent": "cursor",
	"model": "claude-fable-5",
	"round": 1,
	"startedAt": "2026-08-25T10:00:00.000Z",
	"submittedAt": "2026-08-25T11:00:00.000Z",
	"resultsSubmitted": true,
	"thinking": [
		{"text": "The hero image is the LCP element, so the font swap cannot be what is holding this back."},
		{"text": "Preloading it moved the number 180ms, which is over the noise floor, so keep it."}
	],
	"results": {
		"northStar": "lcp",
		"baseline": {"cold": {"lcpMs": 2400, "ttiMs": 3100}},
		"final": {"cold": {"lcpMs": 2100, "ttiMs": 2900}},
		"iterations": [
			{"name": "Preload the hero image", "kept": true, "deltaMs": -180, "deltaPct": -7.5, "phase": "checklist"},
			{"name": "Defer the analytics SDK", "kept": false, "deltaMs": -4}
		]
	}
}`

// The load-bearing promise: a trace is stored and published nowhere. Both public
// documents are captured byte for byte before the trace is submitted and
// compared after, so a trace cannot change what the boards serve even in a
// field nobody thought to look at.
func TestSubmitTraceStoresPrivatelyAndLeavesThePublicJSONUnchanged(t *testing.T) {
	pool := freshDatabase(t)
	server, dir := bootWithTraces(t, pool)
	base := server.URL

	// A board with real rows on it, so "unchanged" means something.
	if status := postJSON(t, base+"/api/submit-site",
		`{"url":"https://speedy.example.com","mode":"cold","lcpRaw":2100,"lcpDelta":-12,"ttiRaw":2900,"ttiDelta":-6}`, nil); status != http.StatusCreated {
		t.Fatalf("submit-site = %d, want 201", status)
	}
	if status := postJSON(t, base+"/api/submit-improvements",
		`{"improvements":[{"name":"Preload the hero image","description":"Preload the LCP image","deltaMs":-180}]}`, nil); status != http.StatusOK {
		t.Fatalf("submit-improvements = %d, want 200", status)
	}

	_, sitesBefore := getRaw(t, base+"/data/sites.json")
	_, improvementsBefore := getRaw(t, base+"/data/improvements.json")

	var submitted struct {
		OK             bool     `json:"ok"`
		RunID          string   `json:"runId"`
		ThinkingBlocks int      `json:"thinkingBlocks"`
		ThinkingChars  int      `json:"thinkingChars"`
		Iterations     int      `json:"iterations"`
		Truncated      []string `json:"truncated"`
	}
	if status := postJSON(t, base+"/api/submit-trace", traceBody, &submitted); status != http.StatusCreated {
		t.Fatalf("submit-trace = %d, want 201", status)
	}
	if !submitted.OK || submitted.RunID != "run-abc-123" || submitted.ThinkingBlocks != 2 || submitted.Iterations != 2 {
		t.Errorf("unexpected acknowledgement: %+v", submitted)
	}
	if submitted.ThinkingChars == 0 || len(submitted.Truncated) != 0 {
		t.Errorf("expected a full, untruncated trace: %+v", submitted)
	}

	_, sitesAfter := getRaw(t, base+"/data/sites.json")
	_, improvementsAfter := getRaw(t, base+"/data/improvements.json")
	if sitesAfter != sitesBefore {
		t.Errorf("a trace changed /data/sites.json:\nbefore %s\nafter  %s", sitesBefore, sitesAfter)
	}
	if improvementsAfter != improvementsBefore {
		t.Errorf("a trace changed /data/improvements.json:\nbefore %s\nafter  %s", improvementsBefore, improvementsAfter)
	}
	// And nothing from the reasoning is anywhere in either document.
	for _, document := range []string{sitesAfter, improvementsAfter} {
		for _, leak := range []string{"noise floor", "font swap", "thinking", "run-abc-123", "chain of thought"} {
			if strings.Contains(strings.ToLower(document), strings.ToLower(leak)) {
				t.Errorf("public JSON leaks %q: %s", leak, document)
			}
		}
	}

	// It is on disk, private, and complete.
	documents := storedDocuments(t, dir)
	if len(documents) != 1 {
		t.Fatalf("expected 1 stored document, got %d", len(documents))
	}
	if !strings.Contains(documents[0], "noise floor") || !strings.Contains(documents[0], "Preload the hero image") {
		t.Errorf("the stored document is missing the trace: %s", documents[0])
	}

	// And indexed, with the metadata that lets a training set line a trace up
	// with the run and the board row it came from.
	var row struct {
		source, product, prURL, agent, model, path string
		blocks, chars, iterations, round           int
		resultsSubmitted                           bool
		hasResults, hasDiff                        bool
	}
	err := pool.QueryRow(`SELECT source, product, pr_url, agent, model, path, thinking_blocks,
			thinking_chars, iterations, round, results_submitted, has_results, has_diff
		FROM traces WHERE run_id = ?`, "run-abc-123").Scan(&row.source, &row.product, &row.prURL,
		&row.agent, &row.model, &row.path, &row.blocks, &row.chars, &row.iterations, &row.round,
		&row.resultsSubmitted, &row.hasResults, &row.hasDiff)
	if err != nil {
		t.Fatalf("read the trace index: %v", err)
	}
	if row.source != "cli" || row.product != "Speedy" || row.agent != "cursor" || row.model != "claude-fable-5" {
		t.Errorf("unexpected index row: %+v", row)
	}
	if row.blocks != 2 || row.iterations != 2 || row.round != 1 || !row.resultsSubmitted || !row.hasResults || row.hasDiff {
		t.Errorf("unexpected index counts: %+v", row)
	}
	if !strings.HasSuffix(row.path, "run-abc-123.json") {
		t.Errorf("path should name the run: %q", row.path)
	}
}

// There is no way to read a trace back over HTTP, and the routes that do not
// exist say so rather than answering with the SPA shell.
func TestTracesHaveNoPublicRoute(t *testing.T) {
	server, dir := bootWithTraces(t, freshDatabase(t))
	base := server.URL

	if status := postJSON(t, base+"/api/submit-trace", traceBody, nil); status != http.StatusCreated {
		t.Fatalf("submit-trace = %d, want 201", status)
	}
	stored := storedDocuments(t, dir)
	if len(stored) != 1 {
		t.Fatalf("expected the trace to be stored, got %d documents", len(stored))
	}

	for _, path := range []string{"/api/submit-trace", "/api/traces", "/api/traces/run-abc-123", "/data/traces.json"} {
		status, body := getRaw(t, base+path)
		if status != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, status)
		}
		if strings.Contains(body, "noise floor") || strings.Contains(body, "<app-root>") {
			t.Errorf("GET %s should be a plain 404, got %s", path, body)
		}
	}

	// The vault is not under the static root, so it cannot be reached as a file
	// even if someone guesses the layout.
	status, _ := getRaw(t, base+"/traces/run-abc-123.json")
	if status != http.StatusNotFound {
		t.Errorf("GET /traces/... = %d, want 404", status)
	}
}

// A client that sends a tool transcript is refused with the reason, rather than
// having it quietly stripped: a trace that silently is not what it says it is
// would be worse than no trace.
func TestSubmitTraceRefusesToolTranscripts(t *testing.T) {
	server, dir := bootWithTraces(t, freshDatabase(t))
	base := server.URL

	cases := map[string]string{
		"top-level messages":         `{"thinking":[{"text":"thought"}],"messages":[{"role":"tool","content":"1000 lines of yarn build"}]}`,
		"tool results":               `{"thinking":[{"text":"thought"}],"toolResults":[{"output":"…"}]}`,
		"a build log":                `{"thinking":[{"text":"thought"}],"stdout":"webpack compiled with 4 warnings"}`,
		"a tool_result block":        `{"thinking":[{"type":"tool_result","text":"total 4816\ndrwxr-xr-x"}]}`,
		"tool output inside a block": `{"thinking":[{"text":"thought","stdout":"yarn build output"}]}`,
	}
	for name, body := range cases {
		var rejected struct {
			OK     bool     `json:"ok"`
			Errors []string `json:"errors"`
		}
		status := postJSON(t, base+"/api/submit-trace", body, &rejected)
		if status != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", name, status)
			continue
		}
		if rejected.OK || !strings.Contains(strings.ToLower(strings.Join(rejected.Errors, " ")), "thinking text only") {
			t.Errorf("%s: expected an explanation, got %+v", name, rejected)
		}
	}

	// An empty trace is refused too, and none of the above wrote anything.
	if status := postJSON(t, base+"/api/submit-trace", `{"thinking":[]}`, nil); status != http.StatusBadRequest {
		t.Errorf("an empty trace = %d, want 400", status)
	}
	if documents := storedDocuments(t, dir); len(documents) != 0 {
		t.Errorf("a refused trace must store nothing, got %d documents", len(documents))
	}
}

// The caps are what keep a yarn-build log out even when it arrives as
// "thinking": oversized blocks are cut, extra blocks are dropped, and a body
// past the outer wall never gets read at all.
func TestSubmitTraceClampsOversizedThinking(t *testing.T) {
	pool := freshDatabase(t)
	server, dir := bootWithTraces(t, pool)
	base := server.URL

	blocks := make([]string, 0, 20)
	blocks = append(blocks, fmt.Sprintf(`{"text":%q}`, strings.Repeat("y", trace.MaxBlockChars+500)))
	for i := 0; i < 19; i++ {
		blocks = append(blocks, fmt.Sprintf(`{"text":"thought %d"}`, i))
	}
	var submitted struct {
		ThinkingBlocks int      `json:"thinkingBlocks"`
		ThinkingChars  int      `json:"thinkingChars"`
		Truncated      []string `json:"truncated"`
	}
	body := `{"runId":"clamped","thinking":[` + strings.Join(blocks, ",") + `]}`
	if status := postJSON(t, base+"/api/submit-trace", body, &submitted); status != http.StatusCreated {
		t.Fatalf("submit-trace = %d, want 201", status)
	}
	if submitted.ThinkingBlocks != 20 {
		t.Errorf("blocks: got %d, want 20", submitted.ThinkingBlocks)
	}
	if len(submitted.Truncated) == 0 || !strings.Contains(strings.Join(submitted.Truncated, " "), "per-block cap") {
		t.Errorf("expected the response to admit the truncation, got %+v", submitted.Truncated)
	}
	documents := storedDocuments(t, dir)
	if len(documents) != 1 {
		t.Fatalf("expected 1 document, got %d", len(documents))
	}
	var stored trace.Trace
	if err := json.Unmarshal([]byte(documents[0]), &stored); err != nil {
		t.Fatalf("decode the stored document: %v", err)
	}
	if length := len([]rune(stored.Thinking[0].Text)); length <= trace.MaxBlockChars || length > trace.MaxBlockChars+40 {
		t.Errorf("the long block stored %d characters, want the cap plus a truncation marker", length)
	}

	// The outer wall: a body past the trace limit is refused before anything is
	// parsed, so no amount of "thinking" can carry a real build log.
	huge := fmt.Sprintf(`{"runId":"huge","thinking":[{"text":%q}]}`, strings.Repeat("z", 600*1024))
	res, err := http.Post(base+"/api/submit-trace", "application/json", strings.NewReader(huge))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("an oversized trace = %d, want 413", res.StatusCode)
	}
}

// One run, one trace: a resubmission replaces its own document instead of
// adding a second copy of the same reasoning to the training set.
func TestSubmitTraceResubmissionReplacesRatherThanDuplicates(t *testing.T) {
	pool := freshDatabase(t)
	server, dir := bootWithTraces(t, pool)
	base := server.URL

	if status := postJSON(t, base+"/api/submit-trace", traceBody, nil); status != http.StatusCreated {
		t.Fatalf("first submit = %d, want 201", status)
	}
	second := `{"runId":"run-abc-123","agent":"cursor","thinking":[{"text":"the second attempt, with more reasoning"}]}`
	if status := postJSON(t, base+"/api/submit-trace", second, nil); status != http.StatusOK {
		t.Fatalf("second submit = %d, want 200", status)
	}

	documents := storedDocuments(t, dir)
	if len(documents) != 1 {
		t.Fatalf("expected 1 document after a resubmission, got %d", len(documents))
	}
	if !strings.Contains(documents[0], "the second attempt") || strings.Contains(documents[0], "noise floor") {
		t.Errorf("the resubmission should have replaced the document: %s", documents[0])
	}
	var rows int
	if err := pool.QueryRow("SELECT COUNT(*) FROM traces").Scan(&rows); err != nil {
		t.Fatalf("count traces: %v", err)
	}
	if rows != 1 {
		t.Errorf("index rows: got %d, want 1", rows)
	}
}

// A deployment that collects no traces says so, and the CLI's question is the
// only thing that would ever have asked.
func TestSubmitTraceIsUnavailableWithoutATraceDirectory(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	var refused struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	if status := postJSON(t, base+"/api/submit-trace", traceBody, &refused); status != http.StatusServiceUnavailable {
		t.Fatalf("submit-trace with no vault = %d, want 503", status)
	}
	if refused.OK || !strings.Contains(strings.Join(refused.Errors, " "), "MAKEFASTER_TRACE_DIR") {
		t.Errorf("expected the 503 to name the setting, got %+v", refused)
	}
}
