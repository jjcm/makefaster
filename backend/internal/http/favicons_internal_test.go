package httpapi

// The board's icons, from the server's side: the rows it hands out point at
// this origin, the route serves the stored file, and neither depends on a
// database — so these run everywhere, unlike the MariaDB-backed suite.

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"makefaster/internal/favicon"
	"makefaster/internal/leaderboard"
)

// iconPNG is what an origin serves: a plain square, larger than the board draws.
func iconPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 128, 128))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.NRGBA{R: 0x20, G: 0x80, B: 0xff, A: 0xff}}, image.Point{}, draw.Src)
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatalf("encode icon: %v", err)
	}
	return out.Bytes()
}

// iconOrigin is the third-party host a favicon URL points at, counting how
// often it is actually asked.
func iconOrigin(t *testing.T) (string, *atomic.Int64) {
	t.Helper()
	hits := &atomic.Int64{}
	body := iconPNG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server.URL + "/favicon.ico", hits
}

func testCache(t *testing.T, source string) *favicon.Cache {
	t.Helper()
	cache, err := favicon.New(favicon.Options{
		Dir:               filepath.Join(t.TempDir(), "favicons"),
		AllowPrivateHosts: true,
		Resolver: func(context.Context, string) (string, error) {
			return source, nil
		},
	})
	if err != nil {
		t.Fatalf("new favicon cache: %v", err)
	}
	return cache
}

// spaFixture is a minimal SPA root, so a request that falls through to the
// static handler behaves the way it does in a deploy.
func spaFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<app-root></app-root>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	return dir
}

// The rows the board reads carry a path on this server, and keep the origin's
// URL only as the thing that path was derived from.
func TestSiteRowsPointAtThisServersCopyOfTheIcon(t *testing.T) {
	source, hits := iconOrigin(t)
	cache := testCache(t, source)
	server := NewServer(Options{FrontendDir: spaFixture(t), Favicons: cache})

	rows := server.withServedFavicons([]leaderboard.SiteRow{
		{URL: "example.com", Favicon: source},
		{URL: "plain.dev"},
		{URL: "bad.dev", Favicon: "javascript:alert(1)"},
	})

	if !strings.HasPrefix(rows[0].FaviconPath, favicon.URLPrefix) {
		t.Fatalf("faviconPath is %q, want a path under %s", rows[0].FaviconPath, favicon.URLPrefix)
	}
	if rows[0].Favicon != source {
		t.Fatalf("the original favicon URL was rewritten to %q", rows[0].Favicon)
	}
	if rows[1].FaviconPath != "" || rows[2].FaviconPath != "" {
		t.Fatalf("a row with no usable favicon got %q / %q", rows[1].FaviconPath, rows[2].FaviconPath)
	}

	// Rendering the board started the download without waiting for it.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if hits.Load() > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a board render never started the download")
}

// A deployment that caches no icons publishes no path either. The board draws
// letters; it does not fall back to loading the third-party URL.
func TestSiteRowsCarryNoPathWithoutACache(t *testing.T) {
	server := NewServer(Options{FrontendDir: spaFixture(t)})
	rows := server.withServedFavicons([]leaderboard.SiteRow{{URL: "example.com", Favicon: "https://example.com/favicon.ico"}})
	if rows[0].FaviconPath != "" {
		t.Fatalf("faviconPath is %q, want empty", rows[0].FaviconPath)
	}
}

func TestFaviconRouteServesTheNormalizedIcon(t *testing.T) {
	source, _ := iconOrigin(t)
	cache := testCache(t, source)
	server := NewServer(Options{FrontendDir: spaFixture(t), Favicons: cache})
	front := httptest.NewServer(server.Handler())
	t.Cleanup(front.Close)

	path := cache.Path("example.com", source)
	response, err := http.Get(front.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET %s answered %d", path, response.StatusCode)
	}
	if contentType := response.Header.Get("content-type"); contentType != "image/png" {
		t.Fatalf("content-type is %q, want image/png", contentType)
	}
	if cacheControl := response.Header.Get("cache-control"); !strings.Contains(cacheControl, "max-age=") {
		t.Fatalf("cache-control is %q, want a max-age", cacheControl)
	}
	decoded, err := png.Decode(response.Body)
	if err != nil {
		t.Fatalf("the served bytes are not a png: %v", err)
	}
	if decoded.Bounds().Dx() != favicon.Size {
		t.Fatalf("served a %dpx icon, want %d", decoded.Bounds().Dx(), favicon.Size)
	}
}

// An icon path must never be answered with the SPA shell: a broken <img> is a
// letter fallback, but an <img> pointing at HTML is a broken image forever.
func TestFaviconPathsNeverFallBackToTheShell(t *testing.T) {
	for name, options := range map[string]Options{
		"with no cache configured": {FrontendDir: spaFixture(t)},
		"with a cache":             {FrontendDir: spaFixture(t), Favicons: testCache(t, "")},
	} {
		front := httptest.NewServer(NewServer(options).Handler())
		response, err := http.Get(front.URL + favicon.URLPrefix + "example.com-0123456789.png")
		if err != nil {
			t.Fatalf("%s: GET an unknown icon: %v", name, err)
		}
		body := make([]byte, 64)
		read, _ := response.Body.Read(body)
		response.Body.Close()
		front.Close()

		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: answered %d, want 404", name, response.StatusCode)
		}
		if strings.Contains(string(body[:read]), "app-root") {
			t.Fatalf("%s: answered with the SPA shell", name)
		}
	}
}
