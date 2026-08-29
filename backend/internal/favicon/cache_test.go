package favicon_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"makefaster/internal/favicon"
)

// upstream is the origin a favicon is downloaded from. Every test here serves
// its own: nothing in this package is allowed to reach the real internet, and
// counting the requests is how a cache hit is told apart from a re-download.
type upstream struct {
	server *httptest.Server
	hits   atomic.Int64

	mu      sync.Mutex
	status  int
	body    []byte
	delay   time.Duration
	headers map[string]string
}

func newUpstream(t *testing.T, body []byte) *upstream {
	t.Helper()
	up := &upstream{status: http.StatusOK, body: body}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		up.hits.Add(1)
		up.mu.Lock()
		status, body, delay, headers := up.status, up.body, up.delay, up.headers
		up.mu.Unlock()

		time.Sleep(delay)
		for key, value := range headers {
			w.Header().Set(key, value)
		}
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(up.server.Close)
	return up
}

func (u *upstream) url() string { return u.server.URL + "/favicon.ico" }

func (u *upstream) answer(status int, body []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status, u.body = status, body
}

func (u *upstream) slow(delay time.Duration) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.delay = delay
}

// newCache is a cache with a stub resolver: it answers with whatever URL the
// test says the site's row is pointing at.
//
// AllowPrivateHosts is on because the stub upstream is on 127.0.0.1. Production
// leaves it off, and TestTheDownloaderRefusesPrivateAddresses covers that.
func newCache(t *testing.T, source func() string) (*favicon.Cache, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "favicons")
	cache, err := favicon.New(favicon.Options{
		Dir:               dir,
		AllowPrivateHosts: true,
		Resolver: func(context.Context, string) (string, error) {
			return source(), nil
		},
	})
	if err != nil {
		t.Fatalf("new cache: %v", err)
	}
	return cache, cache.Dir()
}

func get(t *testing.T, cache *favicon.Cache, path string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	cache.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

// waitForFile gives a background download a moment to land, so a test can
// assert on what Prime actually stored rather than on when it stored it.
func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(path); err == nil && info.Size() > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no file appeared at %s", path)
}

func storedPath(dir, servedPath string) string {
	return filepath.Join(dir, strings.TrimPrefix(servedPath, favicon.URLPrefix))
}

// The page's <img src> is a path on this server, and it changes when the row
// starts pointing at a different icon.
func TestPathIsSameOriginAndChangesWithTheSource(t *testing.T) {
	cache, _ := newCache(t, func() string { return "" })

	path := cache.Path("example.com", "https://cdn.example.com/icon.png")
	if !strings.HasPrefix(path, favicon.URLPrefix) {
		t.Fatalf("path %q is not served by this origin", path)
	}
	if strings.Contains(path, "cdn.example.com") {
		t.Fatalf("path %q leaks the third-party URL", path)
	}
	if other := cache.Path("example.com", "https://example.com/favicon.ico"); other == path {
		t.Fatalf("two source URLs share the path %q", path)
	}
	if again := cache.Path("example.com", "https://cdn.example.com/icon.png"); again != path {
		t.Fatalf("the same source gave %q then %q", path, again)
	}
}

// A stored value this server will not fetch gets no path at all, so the board
// falls back to the site's letter instead of hotlinking it.
func TestPathIsEmptyForAnythingUnfetchable(t *testing.T) {
	cache, _ := newCache(t, func() string { return "" })

	cases := map[string]struct{ host, source string }{
		"no favicon":         {"example.com", ""},
		"a javascript url":   {"example.com", "javascript:alert(1)"},
		"a data url":         {"example.com", "data:image/png;base64,iVBORw0K"},
		"an ftp url":         {"example.com", "ftp://example.com/icon.png"},
		"a relative path":    {"example.com", "/favicon.ico"},
		"no host in the url": {"example.com", "https:///favicon.ico"},
		"a bad site host":    {"../../etc", "https://example.com/favicon.ico"},
		"a bare host":        {"localhost", "https://example.com/favicon.ico"},
	}
	for name, input := range cases {
		if path := cache.Path(input.host, input.source); path != "" {
			t.Fatalf("%s produced the path %q", name, path)
		}
	}
}

// The whole point: the icon is downloaded from its origin, converted to the one
// size and format the board draws, and served from here.
func TestServeDownloadsNormalizesAndThenHitsTheStoredFile(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 128, 128, blue))
	cache, dir := newCache(t, up.url)

	path := cache.Path("example.com", up.url())
	response := get(t, cache, path)
	if response.Code != http.StatusOK {
		t.Fatalf("first GET %s answered %d", path, response.Code)
	}
	if contentType := response.Header().Get("content-type"); contentType != "image/png" {
		t.Fatalf("content-type is %q, want image/png", contentType)
	}
	if cacheControl := response.Header().Get("cache-control"); !strings.Contains(cacheControl, "max-age=") {
		t.Fatalf("cache-control is %q, want a max-age", cacheControl)
	}
	// Same origin as the board, so the browser needs no CORS grant to draw it.
	if response.Header().Get("access-control-allow-origin") != "" {
		t.Fatalf("the favicon route should not need to negotiate CORS")
	}

	image := decodePNG(t, response.Body.Bytes())
	if image.Bounds().Dx() != favicon.Size || image.Bounds().Dy() != favicon.Size {
		t.Fatalf("served a %dx%d icon, want %d square",
			image.Bounds().Dx(), image.Bounds().Dy(), favicon.Size)
	}
	assertColor(t, image, 32, 32, blue)

	stored, err := os.ReadFile(storedPath(dir, path))
	if err != nil {
		t.Fatalf("the normalized icon was not stored: %v", err)
	}
	if len(stored) != response.Body.Len() {
		t.Fatalf("stored %d bytes but served %d", len(stored), response.Body.Len())
	}

	// The second request is a file read, not a second trip to somebody else's
	// CDN.
	second := get(t, cache, path)
	if second.Code != http.StatusOK {
		t.Fatalf("second GET answered %d", second.Code)
	}
	if hits := up.hits.Load(); hits != 1 {
		t.Fatalf("the origin was asked %d times, want exactly once", hits)
	}
}

// The failure this feature exists for: an origin that refuses the request. The
// row keeps its letter, and the refusal is not retried on every render.
func TestServeAnswers404WhenTheOriginRefuses(t *testing.T) {
	up := newUpstream(t, nil)
	up.answer(http.StatusForbidden, []byte("hotlinking is not allowed"))
	cache, dir := newCache(t, up.url)

	path := cache.Path("example.com", up.url())
	if response := get(t, cache, path); response.Code != http.StatusNotFound {
		t.Fatalf("GET %s answered %d, want 404", path, response.Code)
	}
	if _, err := os.Stat(storedPath(dir, path)); !os.IsNotExist(err) {
		t.Fatalf("a refused download should store nothing (stat error: %v)", err)
	}

	for attempt := 0; attempt < 3; attempt++ {
		if response := get(t, cache, path); response.Code != http.StatusNotFound {
			t.Fatalf("retry %d answered %d, want 404", attempt, response.Code)
		}
	}
	if hits := up.hits.Load(); hits != 1 {
		t.Fatalf("the origin was asked %d times, want once until the cooldown expires", hits)
	}
}

// An origin that answers 200 with something that is not an image — an HTML
// error page, an SVG this cannot rasterize — is the same non-event.
func TestServeAnswers404WhenTheOriginServesSomethingElse(t *testing.T) {
	up := newUpstream(t, []byte("<!DOCTYPE html><title>Not found</title>"))
	cache, dir := newCache(t, up.url)

	path := cache.Path("example.com", up.url())
	if response := get(t, cache, path); response.Code != http.StatusNotFound {
		t.Fatalf("GET %s answered %d, want 404", path, response.Code)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Fatalf("the cache directory holds %d entries (err %v), want none", len(entries), err)
	}
}

// Nothing but a path this cache handed out is answered, which is also what
// keeps a request from naming a file outside the cache directory.
func TestServeRefusesAPathItDidNotHandOut(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 32, 32, red))
	cache, _ := newCache(t, up.url)

	current := cache.Path("example.com", up.url())
	stale := cache.Path("example.com", "https://cdn.example.com/old-icon.png")

	for _, path := range []string{
		favicon.URLPrefix + "../../etc/passwd",
		favicon.URLPrefix + "..%2f..%2fpasswd.png",
		favicon.URLPrefix + "example.com.png",
		favicon.URLPrefix + "example.com-nothex.png",
		favicon.URLPrefix + "-0123456789.png",
		favicon.URLPrefix + "example.com-0123456789.gif",
		stale, // the row points somewhere else now
	} {
		if response := get(t, cache, path); response.Code != http.StatusNotFound {
			t.Fatalf("GET %s answered %d, want 404", path, response.Code)
		}
	}
	if hits := up.hits.Load(); hits != 0 {
		t.Fatalf("the origin was asked %d times for paths this cache never issued", hits)
	}
	if response := get(t, cache, current); response.Code != http.StatusOK {
		t.Fatalf("the current path answered %d, want 200", response.Code)
	}
}

// Priming is what ingest and a board render do: start the download, wait for
// nothing.
func TestPrimeStoresInTheBackgroundWithoutBlocking(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 64, 64, red))
	up.slow(150 * time.Millisecond)
	cache, dir := newCache(t, up.url)

	path := cache.Path("example.com", up.url())
	started := time.Now()
	cache.Prime("example.com", up.url())
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("Prime blocked for %s; it must not wait on the download", elapsed)
	}

	waitForFile(t, storedPath(dir, path))
	if response := get(t, cache, path); response.Code != http.StatusOK {
		t.Fatalf("GET %s answered %d after priming", path, response.Code)
	}
	if hits := up.hits.Load(); hits != 1 {
		t.Fatalf("the origin was asked %d times, want once", hits)
	}
}

// A stored file that is past its TTL is still served immediately; the refresh
// happens behind the request.
func TestServeReturnsAStaleFileAndRefreshesBehindIt(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 64, 64, red))
	cache, dir := newCache(t, up.url)

	path := cache.Path("example.com", up.url())
	if response := get(t, cache, path); response.Code != http.StatusOK {
		t.Fatalf("first GET answered %d", response.Code)
	}

	file := storedPath(dir, path)
	stale := time.Now().Add(-30 * 24 * time.Hour)
	if err := os.Chtimes(file, stale, stale); err != nil {
		t.Fatalf("age the stored file: %v", err)
	}

	up.answer(http.StatusOK, solidPNG(t, 64, 64, blue))
	response := get(t, cache, path)
	if response.Code != http.StatusOK {
		t.Fatalf("the stale GET answered %d, want the stored bytes", response.Code)
	}
	assertColor(t, decodePNG(t, response.Body.Bytes()), 32, 32, red)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(file); err == nil && info.ModTime().After(stale.Add(time.Hour)) {
			assertColor(t, decodePNG(t, mustRead(t, file)), 32, 32, blue)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the stale icon was never refreshed")
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

// A board render asks for every icon at once. One download per icon, however
// many viewers arrive together.
func TestConcurrentRequestsShareOneDownload(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 64, 64, blue))
	up.slow(100 * time.Millisecond)
	cache, _ := newCache(t, up.url)
	path := cache.Path("example.com", up.url())

	var group sync.WaitGroup
	codes := make([]int, 8)
	for index := range codes {
		group.Add(1)
		go func(slot int) {
			defer group.Done()
			codes[slot] = get(t, cache, path).Code
		}(index)
	}
	group.Wait()

	for slot, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("viewer %d got %d, want 200", slot, code)
		}
	}
	if hits := up.hits.Load(); hits != 1 {
		t.Fatalf("the origin was asked %d times, want once for all eight viewers", hits)
	}
}

// The favicon URL on a site row arrives through a public write endpoint, so the
// downloader is the one place this server would happily fetch a URL a stranger
// chose. It refuses anything that is not a public address.
func TestTheDownloaderRefusesPrivateAddresses(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 64, 64, red))
	dir := filepath.Join(t.TempDir(), "favicons")
	cache, err := favicon.New(favicon.Options{
		Dir: dir,
		Resolver: func(context.Context, string) (string, error) {
			return up.url(), nil
		},
	})
	if err != nil {
		t.Fatalf("new cache: %v", err)
	}

	path := cache.Path("example.com", up.url())
	if response := get(t, cache, path); response.Code != http.StatusNotFound {
		t.Fatalf("GET %s answered %d, want 404 for a loopback origin", path, response.Code)
	}
	if hits := up.hits.Load(); hits != 0 {
		t.Fatalf("the loopback origin was reached %d times", hits)
	}
}

// A deployment with nowhere to write serves no icons rather than falling back
// to hotlinking.
func TestNewRefusesWithoutADirectory(t *testing.T) {
	for _, dir := range []string{"", "   "} {
		if _, err := favicon.New(favicon.Options{Dir: dir}); err == nil {
			t.Fatalf("New(%q) should have refused", dir)
		}
	}
}

// A file stored under an older source URL is dropped when the new one lands, so
// a rebranded site does not leave its old icon behind forever.
func TestStoringSupersedesTheSitesEarlierIcon(t *testing.T) {
	up := newUpstream(t, solidPNG(t, 64, 64, red))
	source := up.url()
	cache, dir := newCache(t, func() string { return source })

	first := cache.Path("example.com", source)
	if response := get(t, cache, first); response.Code != http.StatusOK {
		t.Fatalf("first GET answered %d", response.Code)
	}

	source = up.server.URL + "/new-icon.png"
	second := cache.Path("example.com", source)
	if response := get(t, cache, second); response.Code != http.StatusOK {
		t.Fatalf("GET the new icon answered %d", response.Code)
	}

	if _, err := os.Stat(storedPath(dir, first)); !os.IsNotExist(err) {
		t.Fatalf("the superseded icon is still stored (stat error: %v)", err)
	}
	if _, err := os.Stat(storedPath(dir, second)); err != nil {
		t.Fatalf("the current icon is not stored: %v", err)
	}
}
