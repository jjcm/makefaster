package httpapi

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// legacyPages map the old multi-page URLs onto SPA routes so links that
// predate the single-page rewrite keep working instead of 404ing.
var legacyPages = map[string]string{
	"/index.html":                   "/",
	"/site-leaderboard.html":        "/site-leaderboard",
	"/improvement-leaderboard.html": "/improvement-leaderboard",
}

// serveStatic serves the SPA's files, falling back to index.html for app
// routes so the History API paths survive a hard refresh.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	requested := r.URL.Path

	if target, isLegacy := legacyPages[requested]; isLegacy {
		http.Redirect(w, r, target, http.StatusMovedPermanently)
		return
	}

	// Reject traversal outright rather than resolving it: no request for a
	// real asset ever needs "..".
	if strings.Contains(requested, "..") {
		s.writeJSON(w, http.StatusNotFound, errorBody("not found"))
		return
	}

	cleaned := path.Clean("/" + strings.TrimPrefix(requested, "/"))
	candidate := filepath.Join(s.frontendDir, filepath.FromSlash(cleaned))
	root, err := filepath.Abs(s.frontendDir)
	if err != nil {
		s.fail(w, err)
		return
	}
	absolute, err := filepath.Abs(candidate)
	if err != nil || (absolute != root && !strings.HasPrefix(absolute, root+string(filepath.Separator))) {
		s.writeJSON(w, http.StatusNotFound, errorBody("not found"))
		return
	}

	if info, err := os.Stat(absolute); err == nil && !info.IsDir() {
		s.serveFile(w, r, absolute)
		return
	}

	// Unknown paths that name a file extension are missing assets; everything
	// else is an app route the SPA router will resolve.
	if path.Ext(cleaned) != "" {
		s.writeJSON(w, http.StatusNotFound, errorBody("not found"))
		return
	}
	s.serveFile(w, r, filepath.Join(root, "index.html"))
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, absolute string) {
	// The shell must never be cached or a deploy leaves stale JS references
	// behind; fingerprint-free assets get a short window instead.
	if strings.EqualFold(filepath.Ext(absolute), ".html") {
		w.Header().Set("cache-control", "no-cache")
	} else {
		w.Header().Set("cache-control", "public, max-age=300")
	}
	http.ServeFile(w, r, absolute)
}
