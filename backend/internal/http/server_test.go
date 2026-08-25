package httpapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"makefaster/internal/db"
	"makefaster/internal/embedding"
	httpapi "makefaster/internal/http"
	"makefaster/internal/leaderboard"
	"makefaster/internal/store"
)

// testDSNEnv points these tests at a throwaway MariaDB schema. Without it the
// suite skips rather than failing, so `go test ./...` still works on a machine
// with no database. See README.md for docker-compose and the local DSN.
const testDSNEnv = "MAKEFASTER_TEST_MARIADB_DSN"

const migrationsDir = "../db/migrations"

// fixtureSeedDir is a one-site, one-category seed: enough to prove the
// seed-from-file path end to end without depending on the size or contents of
// the committed public seed, which is empty on purpose.
func fixtureSeedDir() string { return filepath.Join("testdata", "seed") }

// committedSeedDir is the seed the deploy actually reads.
func committedSeedDir() string { return filepath.Join("..", "..", "..", "data") }

// freshDatabase drops everything the server owns and re-runs the migrations,
// so each test starts from the state a brand new deploy would see.
func freshDatabase(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv(testDSNEnv)
	if dsn == "" {
		t.Skipf("%s is not set; skipping the MariaDB-backed tests", testDSNEnv)
	}

	pool, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	for _, table := range []string{"sites", "improvement_categories", "goose_db_version"} {
		if _, err := pool.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			t.Fatalf("drop %s: %v", table, err)
		}
	}
	if err := db.Migrate(pool, migrationsDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

// boot mirrors what cmd/server does on start: seed if empty, pick an embedder,
// serve. Calling it twice against one database is a process restart.
func boot(t *testing.T, pool *sql.DB) *httptest.Server {
	t.Helper()
	return bootWithSeed(t, pool, fixtureSeedDir())
}

func bootWithSeed(t *testing.T, pool *sql.DB, seedDir string) *httptest.Server {
	t.Helper()
	leaderboards := store.New(pool)
	if err := leaderboards.Seed(context.Background(), seedDir); err != nil {
		t.Fatalf("seed: %v", err)
	}

	embedder, threshold := embedding.New(embedding.Options{}, nil)
	server := httpapi.NewServer(httpapi.Options{
		Store:       leaderboards,
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: frontendFixture(t),
	})

	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

// frontendFixture is a minimal SPA root: enough to prove static serving and
// the index.html fallback without depending on the real frontend build.
func frontendFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"),
		[]byte("<!DOCTYPE html><title>Makefaster</title><app-root></app-root>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "css"), 0o755); err != nil {
		t.Fatalf("mkdir css: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "css", "style.css"), []byte(".sheet{}"), 0o644); err != nil {
		t.Fatalf("write style.css: %v", err)
	}
	return dir
}

func getJSON(t *testing.T, url string, target any) int {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer res.Body.Close()
	if target != nil {
		if err := json.NewDecoder(res.Body).Decode(target); err != nil {
			t.Fatalf("decode %s: %v", url, err)
		}
	}
	return res.StatusCode
}

func postJSON(t *testing.T, url, body string, target any) int {
	t.Helper()
	res, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer res.Body.Close()
	if target != nil {
		if err := json.NewDecoder(res.Body).Decode(target); err != nil {
			t.Fatalf("decode %s: %v", url, err)
		}
	}
	return res.StatusCode
}

func TestServesTheSPAAndLiveSeededData(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	index, err := http.Get(base + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	body, _ := io.ReadAll(index.Body)
	index.Body.Close()
	if index.StatusCode != http.StatusOK || !strings.Contains(string(body), "<app-root>") {
		t.Errorf("GET / = %d, body %q", index.StatusCode, body)
	}
	if cacheControl := index.Header.Get("cache-control"); cacheControl != "no-cache" {
		t.Errorf("the SPA shell must not be cached; got %q", cacheControl)
	}

	css, err := http.Get(base + "/css/style.css")
	if err != nil {
		t.Fatalf("GET /css/style.css: %v", err)
	}
	css.Body.Close()
	if css.StatusCode != http.StatusOK || !strings.Contains(css.Header.Get("content-type"), "text/css") {
		t.Errorf("GET /css/style.css = %d, content-type %q", css.StatusCode, css.Header.Get("content-type"))
	}

	// A fresh migrate copies whatever the seed directory holds into the tables,
	// and both boards are then served from those tables.
	var categories []leaderboard.Category
	if status := getJSON(t, base+"/data/improvements.json", &categories); status != http.StatusOK {
		t.Fatalf("GET /data/improvements.json = %d", status)
	}
	if len(categories) != 1 {
		t.Fatalf("expected the 1 seeded category, got %d", len(categories))
	}
	if categories[0].Rank != 1 || categories[0].Name != "Image Optimization" {
		t.Errorf("unexpected seeded category: %+v", categories[0])
	}

	var sites []leaderboard.SiteRow
	if status := getJSON(t, base+"/data/sites.json", &sites); status != http.StatusOK {
		t.Fatalf("GET /data/sites.json = %d", status)
	}
	if len(sites) != 1 || sites[0].URL != "seed.example.com" {
		t.Errorf("expected the 1 seeded site, got %+v", sites)
	}

	var health struct {
		OK        bool    `json:"ok"`
		Embedder  string  `json:"embedder"`
		Threshold float64 `json:"threshold"`
	}
	if status := getJSON(t, base+"/api/health", &health); status != http.StatusOK {
		t.Fatalf("GET /api/health = %d", status)
	}
	if !health.OK || health.Embedder != "local-hash-v1" || health.Threshold != 0.3 {
		t.Errorf("unexpected health payload: %+v", health)
	}
}

// The public leaderboards hold real submissions only. A fresh migrate against
// the committed seed must therefore leave both boards empty, so a redeploy or a
// new environment can never republish synthetic rows.
func TestCommittedSeedLeavesBothBoardsEmpty(t *testing.T) {
	base := bootWithSeed(t, freshDatabase(t), committedSeedDir()).URL

	for _, path := range []string{"/data/improvements.json", "/data/sites.json"} {
		res, err := http.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d", path, res.StatusCode)
		}
		if strings.TrimSpace(string(body)) != "[]" {
			t.Errorf("GET %s = %s, want []", path, body)
		}
	}
}

func TestStaticFallbackAndLegacyRedirects(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	// App routes are served by the shell so a hard refresh works.
	for _, route := range []string{"/site-leaderboard", "/improvement-leaderboard", "/whatever"} {
		res, err := http.Get(base + route)
		if err != nil {
			t.Fatalf("GET %s: %v", route, err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK || !strings.Contains(string(body), "<app-root>") {
			t.Errorf("GET %s = %d, expected the SPA shell", route, res.StatusCode)
		}
	}

	// The pre-SPA URLs still resolve instead of 404ing.
	noRedirects := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for legacy, expected := range map[string]string{
		"/index.html":                   "/",
		"/site-leaderboard.html":        "/site-leaderboard",
		"/improvement-leaderboard.html": "/improvement-leaderboard",
	} {
		res, err := noRedirects.Get(base + legacy)
		if err != nil {
			t.Fatalf("GET %s: %v", legacy, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusMovedPermanently || res.Header.Get("location") != expected {
			t.Errorf("GET %s = %d -> %q, want 301 -> %q", legacy, res.StatusCode, res.Header.Get("location"), expected)
		}
	}

	// Missing assets stay 404s, and traversal never resolves.
	for _, path := range []string{"/nope.html", "/css/missing.css", "/..%2f..%2fetc%2fpasswd"} {
		res, err := http.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, res.StatusCode)
		}
	}
}

func TestSubmitSiteInsertsThenUpsertsAndSurvivesRestart(t *testing.T) {
	pool := freshDatabase(t)
	base := boot(t, pool).URL
	payload := `{"url":"https://speedy.example.com","mode":"cold","lcpRaw":1400,"lcpDelta":-22,"ttiRaw":2300,"ttiDelta":-17}`

	var first struct {
		OK      bool                `json:"ok"`
		Created bool                `json:"created"`
		Row     leaderboard.SiteRow `json:"row"`
	}
	if status := postJSON(t, base+"/api/submit-site", payload, &first); status != http.StatusCreated {
		t.Fatalf("first submission = %d, want 201", status)
	}
	if !first.OK || !first.Created {
		t.Errorf("expected a created row, got %+v", first)
	}
	if first.Row.URL != "speedy.example.com" {
		t.Errorf("url should be normalized to a bare hostname, got %q", first.Row.URL)
	}
	if first.Row.Tests != 1 {
		t.Errorf("tests: got %d, want 1", first.Row.Tests)
	}
	if first.Row.Favicon != "https://icons.duckduckgo.com/ip3/speedy.example.com.ico" {
		t.Errorf("favicon: got %q", first.Row.Favicon)
	}

	var second struct {
		Created bool                `json:"created"`
		Row     leaderboard.SiteRow `json:"row"`
	}
	updated := `{"url":"https://speedy.example.com","mode":"cold","lcpRaw":1300,"lcpDelta":-28,"ttiRaw":2300,"ttiDelta":-17}`
	if status := postJSON(t, base+"/api/submit-site", updated, &second); status != http.StatusOK {
		t.Fatalf("second submission = %d, want 200", status)
	}
	if second.Created {
		t.Errorf("the second submission must be an update, got %+v", second)
	}
	if second.Row.Tests != 2 || second.Row.LCPRaw != 1300 {
		t.Errorf("expected the latest metrics and tests=2, got %+v", second.Row)
	}

	// One row per (url, mode), never two.
	var rows []leaderboard.SiteRow
	getJSON(t, base+"/data/sites.json", &rows)
	matches := 0
	for _, row := range rows {
		if row.URL == "speedy.example.com" {
			matches++
		}
	}
	if matches != 1 {
		t.Errorf("expected 1 row for speedy.example.com, found %d", matches)
	}

	var rejected struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	bad := `{"url":"https://speedy.example.com","mode":"hot","lcpRaw":1400,"lcpDelta":-22,"ttiRaw":2300,"ttiDelta":-17}`
	if status := postJSON(t, base+"/api/submit-site", bad, &rejected); status != http.StatusBadRequest {
		t.Fatalf("invalid mode = %d, want 400", status)
	}
	if rejected.OK || !strings.Contains(strings.Join(rejected.Errors, " "), "mode") {
		t.Errorf("expected a mode error, got %+v", rejected)
	}

	// Restart against the same database: the submission is still there, and
	// seeding does not run a second time.
	restarted := boot(t, pool).URL
	var afterRestart []leaderboard.SiteRow
	getJSON(t, restarted+"/data/sites.json", &afterRestart)
	found := false
	for _, row := range afterRestart {
		if row.URL == "speedy.example.com" && row.Mode == "cold" {
			found = true
			if row.Tests != 2 {
				t.Errorf("tests after restart: got %d, want 2", row.Tests)
			}
		}
	}
	if !found {
		t.Error("the submitted row was lost across a restart")
	}
	if len(afterRestart) != len(rows) {
		t.Errorf("restart re-seeded the board: %d rows before, %d after", len(rows), len(afterRestart))
	}
}

// A row's identity: the product's name, and the pull request the run was opened
// as. The name a submitter sends describes their deployment, so it is reduced
// on the way in; the PR link is stored as sent and served back so the board can
// link to it. A submission without one leaves the key off the row entirely.
func TestSubmitSiteStoresTheProductNameAndPullRequest(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	var submitted struct {
		Row leaderboard.SiteRow `json:"row"`
	}
	body := `{"url":"https://n8n.example.com","mode":"cold","name":"n8n (self-hosted editor, jjcm/n8n fork)",
		"prUrl":"https://github.com/jjcm/n8n/pull/1",
		"lcpBefore":2000,"lcpRaw":1400,"lcpDelta":-30,"ttiBefore":3000,"ttiRaw":2300,"ttiDelta":-23}`
	if status := postJSON(t, base+"/api/submit-site", body, &submitted); status != http.StatusCreated {
		t.Fatalf("submit = %d, want 201", status)
	}
	if submitted.Row.Name != "n8n" {
		t.Errorf("name: got %q, want %q", submitted.Row.Name, "n8n")
	}
	if submitted.Row.PRURL != "https://github.com/jjcm/n8n/pull/1" {
		t.Errorf("prUrl: got %q", submitted.Row.PRURL)
	}

	// The board the SPA reads carries both, and a row with no pull request does
	// not carry an empty key for one.
	plain := `{"url":"https://plain.example.com","mode":"cold","lcpRaw":1000,"lcpDelta":-10,"ttiRaw":2000,"ttiDelta":-10}`
	if status := postJSON(t, base+"/api/submit-site", plain, nil); status != http.StatusCreated {
		t.Fatalf("submit without a PR = %d, want 201", status)
	}

	res, err := http.Get(base + "/data/sites.json")
	if err != nil {
		t.Fatalf("GET /data/sites.json: %v", err)
	}
	payload, _ := io.ReadAll(res.Body)
	res.Body.Close()

	var rows []leaderboard.SiteRow
	if err := json.Unmarshal(payload, &rows); err != nil {
		t.Fatalf("decode sites: %v", err)
	}
	for _, row := range rows {
		switch row.URL {
		case "n8n.example.com":
			if row.Name != "n8n" || row.PRURL != "https://github.com/jjcm/n8n/pull/1" {
				t.Errorf("the board lost the row's identity: %+v", row)
			}
		case "plain.example.com":
			if row.PRURL != "" {
				t.Errorf("a row with no pull request got one: %q", row.PRURL)
			}
		}
	}
	if strings.Contains(string(payload), `"prUrl":""`) {
		t.Errorf("a row without a pull request must omit the key, got %s", payload)
	}
}

// The site board shows before and after for both metrics, so both have to
// survive a round trip — including for a client that only sends the after
// value and the delta, which is every CLI released before lcpBefore existed.
func TestSubmitSiteStoresBothEndsOfEachMetric(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	var measured struct {
		Row leaderboard.SiteRow `json:"row"`
	}
	body := `{"url":"https://both.example.com","mode":"cold",
		"lcpBefore":6678,"lcpRaw":1202,"lcpDelta":-82,
		"ttiBefore":6723,"ttiRaw":5325,"ttiDelta":-20.8}`
	if status := postJSON(t, base+"/api/submit-site", body, &measured); status != http.StatusCreated {
		t.Fatalf("submit = %d, want 201", status)
	}
	if measured.Row.LCPBefore != 6678 || measured.Row.LCPRaw != 1202 {
		t.Errorf("LCP: got before=%d after=%d, want 6678/1202", measured.Row.LCPBefore, measured.Row.LCPRaw)
	}
	if measured.Row.TTIBefore != 6723 || measured.Row.TTIRaw != 5325 {
		t.Errorf("TTI: got before=%d after=%d, want 6723/5325", measured.Row.TTIBefore, measured.Row.TTIRaw)
	}

	var derived struct {
		Row leaderboard.SiteRow `json:"row"`
	}
	legacy := `{"url":"https://legacy.example.com","mode":"cold","lcpRaw":1202,"lcpDelta":-82,"ttiRaw":5325,"ttiDelta":-20.8}`
	if status := postJSON(t, base+"/api/submit-site", legacy, &derived); status != http.StatusCreated {
		t.Fatalf("legacy submit = %d, want 201", status)
	}
	if derived.Row.LCPBefore != leaderboard.BaselineFromDelta(1202, -82) {
		t.Errorf("lcpBefore should be recovered from the delta, got %d", derived.Row.LCPBefore)
	}
	if derived.Row.TTIBefore != leaderboard.BaselineFromDelta(5325, -20.8) {
		t.Errorf("ttiBefore should be recovered from the delta, got %d", derived.Row.TTIBefore)
	}

	// And both are on the board the SPA reads, not just in the write response.
	var rows []leaderboard.SiteRow
	getJSON(t, base+"/data/sites.json", &rows)
	found := false
	for _, row := range rows {
		if row.URL == "both.example.com" {
			found = true
			if row.LCPBefore != 6678 || row.TTIBefore != 6723 {
				t.Errorf("GET /data/sites.json lost the baselines: %+v", row)
			}
		}
	}
	if !found {
		t.Error("the submitted row is missing from the site board")
	}

	var rejected struct {
		Errors []string `json:"errors"`
	}
	bad := `{"url":"https://both.example.com","mode":"cold","lcpBefore":-5,"lcpRaw":1202,"lcpDelta":-82,"ttiRaw":5325,"ttiDelta":-20.8}`
	if status := postJSON(t, base+"/api/submit-site", bad, &rejected); status != http.StatusBadRequest {
		t.Fatalf("negative lcpBefore = %d, want 400", status)
	}
	if !strings.Contains(strings.Join(rejected.Errors, " "), "lcpBefore") {
		t.Errorf("expected an lcpBefore error, got %+v", rejected.Errors)
	}
}

func TestSubmitImprovementsFoldsMatchesAndCreatesNovelCategories(t *testing.T) {
	pool := freshDatabase(t)
	base := boot(t, pool).URL

	var before []leaderboard.Category
	getJSON(t, base+"/data/improvements.json", &before)
	imageCount := 0
	for _, category := range before {
		if category.Name == "Image Optimization" {
			imageCount = category.Count
		}
	}
	if imageCount == 0 {
		t.Fatal("the fixture seed board is missing Image Optimization")
	}

	var response struct {
		OK        bool                           `json:"ok"`
		Results   []leaderboard.CategorizeResult `json:"results"`
		Embedder  string                         `json:"embedder"`
		Threshold float64                        `json:"threshold"`
	}
	body := `{"improvements":[
		{"name":"Compress hero images","description":"Compressed and resized the oversized hero images","deltaMs":-420,"deltaPct":-19},
		{"name":"Rewrite ORM in Rust","description":"Rewrote the ORM data layer in Rust","deltaMs":-900,"deltaPct":-33}
	]}`
	if status := postJSON(t, base+"/api/submit-improvements", body, &response); status != http.StatusOK {
		t.Fatalf("submit-improvements = %d, want 200", status)
	}
	if !response.OK || response.Embedder != "local-hash-v1" || response.Threshold != 0.3 {
		t.Errorf("unexpected envelope: %+v", response)
	}
	if response.Results[0].Action != "matched" || response.Results[0].Category != "Image Optimization" {
		t.Errorf("first entry should fold into Image Optimization, got %+v", response.Results[0])
	}
	if response.Results[1].Action != "created" {
		t.Errorf("second entry should create a category, got %+v", response.Results[1])
	}

	var after []leaderboard.Category
	getJSON(t, base+"/data/improvements.json", &after)
	if len(after) != len(before)+1 {
		t.Fatalf("expected %d categories, got %d", len(before)+1, len(after))
	}

	ranks := map[int]bool{}
	var created *leaderboard.Category
	for i := range after {
		ranks[after[i].Rank] = true
		if after[i].Name == "Rewrite ORM in Rust" {
			created = &after[i]
		}
		if after[i].Name == "Image Optimization" && after[i].Count != imageCount+1 {
			t.Errorf("Image Optimization count: got %d, want %d", after[i].Count, imageCount+1)
		}
	}
	if len(ranks) != len(after) {
		t.Errorf("ranks must be a permutation of 1..%d, got %d distinct values", len(after), len(ranks))
	}
	if created == nil {
		t.Fatal("the novel category is missing from the live board")
	}
	if created.Count != 1 {
		t.Errorf("created count: got %d, want 1", created.Count)
	}
	// The board ranks by times improved, so a brand new category with one
	// sighting sits below the seeded one it was submitted alongside, however
	// big its single measurement was.
	if created.Rank != 2 {
		t.Errorf("created rank: got %d, want 2", created.Rank)
	}
	for i := range after {
		if after[i].Name == "Image Optimization" && after[i].Rank != 1 {
			t.Errorf("the most-improved category should rank 1, got %d", after[i].Rank)
		}
	}

	// The board survives a restart, which is the whole point of moving off the
	// JSON file store.
	restarted := boot(t, pool).URL
	var persisted []leaderboard.Category
	getJSON(t, restarted+"/data/improvements.json", &persisted)
	if len(persisted) != len(after) {
		t.Errorf("expected %d categories after restart, got %d", len(after), len(persisted))
	}
}

func TestCORSAndErrorEnvelopes(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	preflight, err := http.NewRequest(http.MethodOptions, base+"/api/submit-site", nil)
	if err != nil {
		t.Fatalf("build preflight: %v", err)
	}
	res, err := http.DefaultClient.Do(preflight)
	if err != nil {
		t.Fatalf("OPTIONS: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("OPTIONS = %d, want 204", res.StatusCode)
	}
	if res.Header.Get("access-control-allow-origin") != "*" {
		t.Errorf("missing permissive CORS origin: %q", res.Header.Get("access-control-allow-origin"))
	}
	if !strings.Contains(res.Header.Get("access-control-allow-methods"), "POST") {
		t.Errorf("allow-methods: %q", res.Header.Get("access-control-allow-methods"))
	}

	// Even a rejected request carries CORS, or the browser hides the reason.
	malformed, err := http.Post(base+"/api/submit-site", "application/json", strings.NewReader("not json"))
	if err != nil {
		t.Fatalf("POST malformed: %v", err)
	}
	malformed.Body.Close()
	if malformed.StatusCode != http.StatusBadRequest {
		t.Errorf("malformed body = %d, want 400", malformed.StatusCode)
	}
	if malformed.Header.Get("access-control-allow-origin") != "*" {
		t.Error("error responses must still carry CORS headers")
	}

	var unknown struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	if status := postJSON(t, base+"/api/nope", "{}", &unknown); status != http.StatusNotFound {
		t.Errorf("unknown endpoint = %d, want 404", status)
	}
	if unknown.OK || len(unknown.Errors) != 1 || unknown.Errors[0] != "unknown endpoint" {
		t.Errorf("unexpected envelope: %+v", unknown)
	}
}

func TestOversizedBodyIsRejected(t *testing.T) {
	base := boot(t, freshDatabase(t)).URL

	oversized := `{"improvements":[{"name":"Big","deltaPct":-1,"description":"` +
		strings.Repeat("x", 300*1024) + `"}]}`
	res, err := http.Post(base+"/api/submit-improvements", "application/json", strings.NewReader(oversized))
	if err != nil {
		t.Fatalf("POST oversized: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body = %d, want 413", res.StatusCode)
	}
}
