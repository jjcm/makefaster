package httpapi_test

// The whole favicon path, end to end against the database: a submission names
// an icon on a host that refuses hotlinked requests, and the board still gets a
// picture — from this server, at this server's size.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"makefaster/internal/embedding"
	"makefaster/internal/favicon"
	httpapi "makefaster/internal/http"
	"makefaster/internal/leaderboard"
	"makefaster/internal/store"
)

// hotlinkingOrigin is a site that serves its favicon to a direct request and
// refuses one that came from a page on another domain — the exact behaviour the
// board's third-party <img src> used to trip over.
func hotlinkingOrigin(t *testing.T) *httptest.Server {
	t.Helper()
	icon := image.NewNRGBA(image.Rect(0, 0, 180, 180))
	draw.Draw(icon, icon.Bounds(), &image.Uniform{color.NRGBA{R: 0xd9, G: 0x3a, B: 0x1f, A: 0xff}}, image.Point{}, draw.Src)
	var body bytes.Buffer
	if err := png.Encode(&body, icon); err != nil {
		t.Fatalf("encode the origin's icon: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("referer") != "" || r.Header.Get("origin") != "" {
			http.Error(w, "hotlinking is not allowed", http.StatusForbidden)
			return
		}
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write(body.Bytes())
	}))
	t.Cleanup(server.Close)
	return server
}

// bootWithFavicons is `boot` plus the icon cache, rooted in a temporary
// directory. AllowPrivateHosts is what lets the test's own origin stand in for
// a real one; the deploy leaves it off.
func bootWithFavicons(t *testing.T, pool *sql.DB) *httptest.Server {
	t.Helper()
	leaderboards := store.New(pool)
	if err := leaderboards.Seed(context.Background(), fixtureSeedDir()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cache, err := favicon.New(favicon.Options{
		Dir:               filepath.Join(t.TempDir(), "favicons"),
		Resolver:          leaderboards.SiteFavicon,
		AllowPrivateHosts: true,
	})
	if err != nil {
		t.Fatalf("new favicon cache: %v", err)
	}

	embedder, threshold := embedding.New(embedding.Options{}, nil)
	server := httpapi.NewServer(httpapi.Options{
		Store:       leaderboards,
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: frontendFixture(t),
		Favicons:    cache,
	})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

// waitForIcon retries the icon URL while the background download that a
// submission started finishes. A board render never waits like this — it draws
// the letter and moves on — but a test has to.
func waitForIcon(t *testing.T, url string) *http.Response {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, err := http.Get(url)
		if err != nil {
			t.Fatalf("GET %s: %v", url, err)
		}
		if response.StatusCode == http.StatusOK || time.Now().After(deadline) {
			return response
		}
		response.Body.Close()
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSubmittedFaviconIsServedFromThisOrigin(t *testing.T) {
	pool := freshDatabase(t)
	server := bootWithFavicons(t, pool)
	origin := hotlinkingOrigin(t)
	iconURL := origin.URL + "/favicon.ico"

	// The premise: a browser loading this icon from a page on the board's
	// domain is refused, which is why the board cannot use the URL directly.
	request, _ := http.NewRequest(http.MethodGet, iconURL, nil)
	request.Header.Set("referer", server.URL+"/site-leaderboard")
	refused, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("GET the origin's icon as a hotlink: %v", err)
	}
	refused.Body.Close()
	if refused.StatusCode != http.StatusForbidden {
		t.Fatalf("the origin answered %d; this test needs it to refuse hotlinks", refused.StatusCode)
	}

	submission, err := json.Marshal(map[string]any{
		"url": "hotlinked.dev", "mode": "cold", "favicon": iconURL,
		"lcpRaw": 1800, "lcpDelta": -30, "ttiRaw": 2400, "ttiDelta": -25,
	})
	if err != nil {
		t.Fatalf("encode the submission: %v", err)
	}
	var accepted struct {
		Row leaderboard.SiteRow `json:"row"`
	}
	if status := postJSON(t, server.URL+"/api/submit-site", string(submission), &accepted); status != http.StatusCreated {
		t.Fatalf("submit answered %d, want 201", status)
	}
	if accepted.Row.Favicon != iconURL {
		t.Fatalf("the row's favicon is %q, want the submitted URL", accepted.Row.Favicon)
	}
	if !strings.HasPrefix(accepted.Row.FaviconPath, favicon.URLPrefix) {
		t.Fatalf("the row's faviconPath is %q, want a path on this server", accepted.Row.FaviconPath)
	}

	// The board reads the rows and only ever gets a path on this server.
	var rows []leaderboard.SiteRow
	if status := getJSON(t, server.URL+"/data/sites.json", &rows); status != http.StatusOK {
		t.Fatalf("GET /data/sites.json answered %d", status)
	}
	var row *leaderboard.SiteRow
	for index := range rows {
		if rows[index].URL == "hotlinked.dev" {
			row = &rows[index]
		}
	}
	if row == nil {
		t.Fatal("the submitted site is not on the board")
	}
	if row.FaviconPath != accepted.Row.FaviconPath {
		t.Fatalf("the board's path is %q, the submission's was %q", row.FaviconPath, accepted.Row.FaviconPath)
	}
	if strings.Contains(row.FaviconPath, origin.URL) {
		t.Fatalf("the board's path %q points at the third-party origin", row.FaviconPath)
	}

	response := waitForIcon(t, server.URL+row.FaviconPath)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET %s answered %d", row.FaviconPath, response.StatusCode)
	}
	if contentType := response.Header.Get("content-type"); contentType != "image/png" {
		t.Fatalf("content-type is %q, want image/png", contentType)
	}
	decoded, err := png.Decode(response.Body)
	if err != nil {
		t.Fatalf("the served icon is not a png: %v", err)
	}
	if decoded.Bounds().Dx() != favicon.Size || decoded.Bounds().Dy() != favicon.Size {
		t.Fatalf("served a %dx%d icon, want %d square",
			decoded.Bounds().Dx(), decoded.Bounds().Dy(), favicon.Size)
	}
}

// A row with no favicon at all keeps rendering: no path, no icon request, and
// the board's letter fallback.
func TestRowsWithoutAFaviconAreLeftAlone(t *testing.T) {
	pool := freshDatabase(t)
	server := bootWithFavicons(t, pool)
	if _, err := pool.Exec("UPDATE sites SET favicon = ''"); err != nil {
		t.Fatalf("clear the seeded favicons: %v", err)
	}

	var rows []leaderboard.SiteRow
	if status := getJSON(t, server.URL+"/data/sites.json", &rows); status != http.StatusOK {
		t.Fatalf("GET /data/sites.json answered %d", status)
	}
	if len(rows) == 0 {
		t.Fatal("the seeded board is empty")
	}
	for _, row := range rows {
		if row.FaviconPath != "" {
			t.Fatalf("%s has no favicon but got the path %q", row.URL, row.FaviconPath)
		}
	}

	// And the key is absent from the JSON rather than present and empty, so a
	// client that predates the field sees exactly what it always did.
	raw, _ := json.Marshal(rows[0])
	if bytes.Contains(raw, []byte("faviconPath")) {
		t.Fatalf("a row with no icon still carries faviconPath: %s", raw)
	}
}
