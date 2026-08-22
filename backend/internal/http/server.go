// Package httpapi serves the Makefaster SPA, the live leaderboard data, and
// the two write APIs from one Go process.
//
// The route table is the public contract the `npx makefaster` CLI and the SPA
// both depend on:
//
//	GET  /                          the SPA shell (and every unknown app route)
//	GET  /data/sites.json           live site-leaderboard rows
//	GET  /data/improvements.json    live improvement categories
//	GET  /api/health                { ok, embedder, threshold }
//	POST /api/submit-site           one measurement run for one site
//	POST /api/submit-improvements    anonymous improvements, embedding-matched
package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"makefaster/internal/embedding"
	"makefaster/internal/leaderboard"
	"makefaster/internal/store"
)

const (
	bodyLimitBytes    = 256 * 1024
	rateLimitWindow   = time.Minute
	rateLimitMaxPosts = 60
)

type Server struct {
	store       *store.Store
	embedder    embedding.Embedder
	threshold   float64
	frontendDir string
	logger      *slog.Logger

	limiter *rateLimiter

	// writes serializes both write endpoints: one request folds into the
	// leaderboard at a time, so two concurrent submissions cannot lose each
	// other's rows.
	writes sync.Mutex
}

type Options struct {
	Store       *store.Store
	Embedder    embedding.Embedder
	Threshold   float64
	FrontendDir string
	Logger      *slog.Logger
}

func NewServer(opts Options) *Server {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		store:       opts.Store,
		embedder:    opts.Embedder,
		threshold:   opts.Threshold,
		frontendDir: opts.FrontendDir,
		logger:      logger,
		limiter:     newRateLimiter(),
	}
}

// Handler is the whole application, gzip included.
func (s *Server) Handler() http.Handler {
	return gzipMiddleware(http.HandlerFunc(s.route))
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	setCORS(w)

	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)

	case http.MethodPost:
		if !s.limiter.allow(clientIP(r)) {
			s.writeJSON(w, http.StatusTooManyRequests, errorBody("rate limit exceeded — try again in a minute"))
			return
		}
		switch r.URL.Path {
		case "/api/submit-site":
			s.handleSubmitSite(w, r)
		case "/api/submit-improvements":
			s.handleSubmitImprovements(w, r)
		default:
			s.writeJSON(w, http.StatusNotFound, errorBody("unknown endpoint"))
		}

	case http.MethodGet, http.MethodHead:
		switch r.URL.Path {
		// Live leaderboard data always comes from the database, never the
		// committed seed files, so the tables reflect submissions.
		case "/data/sites.json":
			s.handleSites(w, r)
		case "/data/improvements.json":
			s.handleImprovements(w, r)
		case "/api/health":
			s.writeJSON(w, http.StatusOK, healthBody{
				OK:        true,
				Embedder:  s.embedder.ID(),
				Threshold: s.threshold,
			})
		default:
			s.serveStatic(w, r)
		}

	default:
		s.writeJSON(w, http.StatusMethodNotAllowed, errorBody("method not allowed"))
	}
}

type healthBody struct {
	OK        bool    `json:"ok"`
	Embedder  string  `json:"embedder"`
	Threshold float64 `json:"threshold"`
}

func (s *Server) handleSites(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.Sites(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleImprovements(w http.ResponseWriter, r *http.Request) {
	categories, err := s.store.Categories(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, categories)
}

type submitSiteResponse struct {
	OK      bool                `json:"ok"`
	Created bool                `json:"created"`
	Row     leaderboard.SiteRow `json:"row"`
}

func (s *Server) handleSubmitSite(w http.ResponseWriter, r *http.Request) {
	body, ok := s.readBody(w, r)
	if !ok {
		return
	}
	parsed, err := leaderboard.DecodeObject(body)
	if err != nil {
		s.writeValidationError(w, err)
		return
	}
	submission, err := leaderboard.ValidateSitePayload(parsed)
	if err != nil {
		s.writeValidationError(w, err)
		return
	}

	s.writes.Lock()
	row, created, err := s.store.UpsertSite(r.Context(), submission, time.Now())
	s.writes.Unlock()
	if err != nil {
		s.fail(w, err)
		return
	}

	action := "updated"
	status := http.StatusOK
	if created {
		action, status = "created", http.StatusCreated
	}
	s.logger.Info("submit-site", "action", action, "url", submission.URL, "mode", submission.Mode)
	s.writeJSON(w, status, submitSiteResponse{OK: true, Created: created, Row: row})
}

type submitImprovementsResponse struct {
	OK        bool                           `json:"ok"`
	Results   []leaderboard.CategorizeResult `json:"results"`
	Embedder  string                         `json:"embedder"`
	Threshold float64                        `json:"threshold"`
}

func (s *Server) handleSubmitImprovements(w http.ResponseWriter, r *http.Request) {
	body, ok := s.readBody(w, r)
	if !ok {
		return
	}
	parsed, err := leaderboard.DecodeObject(body)
	if err != nil {
		s.writeValidationError(w, err)
		return
	}
	improvements, err := leaderboard.ValidateImprovementsPayload(parsed)
	if err != nil {
		s.writeValidationError(w, err)
		return
	}

	s.writes.Lock()
	results, err := s.foldImprovements(r, improvements)
	s.writes.Unlock()
	if err != nil {
		s.fail(w, err)
		return
	}

	matched := 0
	for _, result := range results {
		if result.Action == "matched" {
			matched++
		}
	}
	s.logger.Info("submit-improvements",
		"matched", matched,
		"created", len(results)-matched,
		"embedder", s.embedder.ID())
	s.writeJSON(w, http.StatusOK, submitImprovementsResponse{
		OK:        true,
		Results:   results,
		Embedder:  s.embedder.ID(),
		Threshold: s.threshold,
	})
}

// foldImprovements re-embeds the current categories on every request: nothing
// is persisted in embedding space, so the embedding backend can be switched at
// any time without invalidating the board.
func (s *Server) foldImprovements(r *http.Request, improvements []leaderboard.Improvement) ([]leaderboard.CategorizeResult, error) {
	current, err := s.store.Categories(r.Context())
	if err != nil {
		return nil, err
	}
	categories, results := leaderboard.Categorize(improvements, current, s.embedder, s.threshold)
	if err := s.store.ReplaceCategories(r.Context(), categories); err != nil {
		return nil, err
	}
	return results, nil
}

// readBody reads at most 256 KB of request body, answering 413 beyond that.
func (s *Server) readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, bodyLimitBytes+1))
	if err != nil {
		s.writeJSON(w, http.StatusBadRequest, errorBody("could not read request body"))
		return nil, false
	}
	if len(body) > bodyLimitBytes {
		s.writeJSON(w, http.StatusRequestEntityTooLarge, errorBody("payload too large"))
		return nil, false
	}
	return body, true
}

func (s *Server) writeValidationError(w http.ResponseWriter, err error) {
	var validation *leaderboard.ValidationError
	if errors.As(err, &validation) {
		s.writeJSON(w, http.StatusBadRequest, errorPayload{OK: false, Errors: validation.Errors})
		return
	}
	s.fail(w, err)
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.logger.Error("request failed", "error", err)
	s.writeJSON(w, http.StatusInternalServerError, errorBody("internal error"))
}

type errorPayload struct {
	OK     bool     `json:"ok"`
	Errors []string `json:"errors"`
}

func errorBody(messages ...string) errorPayload {
	return errorPayload{OK: false, Errors: messages}
}

func setCORS(w http.ResponseWriter) {
	header := w.Header()
	header.Set("access-control-allow-origin", "*")
	header.Set("access-control-allow-methods", "GET, POST, OPTIONS")
	header.Set("access-control-allow-headers", "content-type")
}

func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	if r.RemoteAddr == "" {
		return "unknown"
	}
	return r.RemoteAddr
}

// rateLimiter caps POSTs per IP per window. Buckets are dropped wholesale past
// a crude memory ceiling rather than swept individually.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	windowStart time.Time
	count       int
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: map[string]*bucket{}}
}

func (l *rateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	existing, found := l.buckets[ip]
	if !found || now.Sub(existing.windowStart) >= rateLimitWindow {
		l.buckets[ip] = &bucket{windowStart: now, count: 1}
		return true
	}
	existing.count++
	if len(l.buckets) > 10_000 {
		l.buckets = map[string]*bucket{}
	}
	return existing.count <= rateLimitMaxPosts
}
