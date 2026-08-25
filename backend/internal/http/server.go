// Package httpapi serves the Makefaster SPA, the live leaderboard data, and
// the two write APIs from one Go process.
//
// The route table is the public contract the `npx makefaster` CLI and the SPA
// both depend on:
//
//	GET  /                          the SPA shell (and every unknown app route)
//	GET  /data/sites.json           live site-leaderboard rows
//	GET  /data/improvements.json    live improvement categories
//	GET  /api/health                { ok, embedder, threshold, inference }
//	POST /api/submit-site           one measurement run for one site, plus
//	                                optional private tips for the catalog
//	                                maintainers (stored, never served)
//	POST /api/submit-improvements    anonymous improvements, embedding-matched
//	POST /api/submit-trace          one run's chain of thought, stored privately
//	                                and served by nothing (see internal/trace)
//	POST /api/openrouter/v1/chat/completions
//	                                the subsidized model proxy the CLI's
//	                                `makefaster` provider runs on
//
// There is no GET counterpart to submit-trace, and adding one would be a
// mistake rather than a feature: unknown GET paths under /api/ answer 404 so
// that a route nobody wrote cannot become a route the SPA shell answers.
package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"makefaster/internal/embedding"
	"makefaster/internal/inference"
	"makefaster/internal/leaderboard"
	"makefaster/internal/store"
	"makefaster/internal/trace"
)

const (
	bodyLimitBytes    = 256 * 1024
	rateLimitWindow   = time.Minute
	rateLimitMaxPosts = 60

	// The inference proxy spends real money per request, so it gets its own,
	// tighter budget. A tool-calling loop makes a handful of calls a minute
	// when it is working and none while a build runs, so this is generous for
	// one honest session and useless for anyone trying to resell the endpoint.
	inferenceRateLimitMax = 30

	// The proxy's own body ceiling. A conversation with a few files in it is
	// large, but not this large, and the request is read into memory.
	inferenceBodyLimitBytes = 1024 * 1024

	// A trace is a session's reasoning plus its iteration list, which is more
	// than a leaderboard row and much less than a conversation. The per-block,
	// per-trace and total caps in internal/trace do the real work; this is the
	// outer wall, so a client that ignores them is refused before the body is
	// read rather than after.
	traceBodyLimitBytes = 512 * 1024
)

type Server struct {
	store       *store.Store
	embedder    embedding.Embedder
	threshold   float64
	frontendDir string
	logger      *slog.Logger
	inference   *inference.Proxy

	// traces is the private trace store. Nil is a supported state: the
	// deployment collects no traces and POST /api/submit-trace answers 503.
	traces *trace.Vault

	limiter          *rateLimiter
	inferenceLimiter *rateLimiter

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

	// Inference is optional: a nil proxy answers the inference route with the
	// same 503 an unconfigured credential does.
	Inference *inference.Proxy

	// Traces is optional in the same way: a nil vault means this deployment
	// stores no chains of thought, and says so.
	Traces *trace.Vault
}

func NewServer(opts Options) *Server {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	proxy := opts.Inference
	if proxy == nil {
		proxy = inference.New("", "", logger)
	}
	return &Server{
		store:            opts.Store,
		embedder:         opts.Embedder,
		threshold:        opts.Threshold,
		frontendDir:      opts.FrontendDir,
		logger:           logger,
		inference:        proxy,
		traces:           opts.Traces,
		limiter:          newRateLimiter(rateLimitMaxPosts),
		inferenceLimiter: newRateLimiter(inferenceRateLimitMax),
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
		case "/api/submit-trace":
			s.handleSubmitTrace(w, r)
		case "/api/openrouter/v1/chat/completions":
			s.handleInferenceChat(w, r)
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
				Inference: inferenceHealth{
					Available: s.inference.Available(),
					Model:     s.inference.Model(),
					Models:    s.inference.Models(),
				},
			})
		default:
			// Everything under /api/ that is not a route above is a 404, not
			// the SPA shell. The write endpoints store things that are never
			// meant to be read back — private catalog tips, chains of thought —
			// so "no GET exists for that" has to be the answer here, not an
			// accident of the static fallback.
			if strings.HasPrefix(r.URL.Path, "/api/") {
				s.writeJSON(w, http.StatusNotFound, errorBody("unknown endpoint"))
				return
			}
			s.serveStatic(w, r)
		}

	default:
		s.writeJSON(w, http.StatusMethodNotAllowed, errorBody("method not allowed"))
	}
}

type healthBody struct {
	OK        bool            `json:"ok"`
	Embedder  string          `json:"embedder"`
	Threshold float64         `json:"threshold"`
	Inference inferenceHealth `json:"inference"`
}

// inferenceHealth tells the CLI whether the hosted provider will work here
// before it starts a run, and which models it may pick from. It reports whether
// a credential is configured — never anything about the credential itself.
type inferenceHealth struct {
	Available bool     `json:"available"`
	Model     string   `json:"model"`
	Models    []string `json:"models"`
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

// submitSiteResponse acknowledges a site submission. TipsRecorded counts the
// private notes stored for the catalog maintainers — the count and nothing
// else, because tips are write-only: they are never served back by any
// endpoint, never rendered on a board, and never part of the checklist the
// CLI imports.
type submitSiteResponse struct {
	OK           bool                `json:"ok"`
	Created      bool                `json:"created"`
	Row          leaderboard.SiteRow `json:"row"`
	TipsRecorded int                 `json:"tipsRecorded,omitempty"`
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

	// Tips ride along with the submission but are not part of it: the site row
	// is already on the board, so a failure to store them is logged and the
	// submission still succeeds.
	tipsRecorded := 0
	if len(submission.Tips) > 0 {
		if err := s.store.SaveTips(r.Context(), submission.URL, submission.Tips, time.Now()); err != nil {
			s.logger.Error("save tips failed", "error", err)
		} else {
			tipsRecorded = len(submission.Tips)
		}
	}

	action := "updated"
	status := http.StatusOK
	if created {
		action, status = "created", http.StatusCreated
	}
	s.logger.Info("submit-site", "action", action, "url", submission.URL, "mode", submission.Mode, "tips", tipsRecorded)
	s.writeJSON(w, status, submitSiteResponse{OK: true, Created: created, Row: row, TipsRecorded: tipsRecorded})
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

// submitTraceResponse acknowledges a stored chain of thought. It reports what
// was kept and what had to be clamped, and nothing about where it went: the
// server's filesystem layout is not the client's business, and there is no
// endpoint that would read the document back anyway.
type submitTraceResponse struct {
	OK             bool     `json:"ok"`
	RunID          string   `json:"runId"`
	ThinkingBlocks int      `json:"thinkingBlocks"`
	ThinkingChars  int      `json:"thinkingChars"`
	Iterations     int      `json:"iterations,omitempty"`
	Truncated      []string `json:"truncated,omitempty"`
}

// handleSubmitTrace stores one run's chain of thought.
//
// This endpoint is write-only in the strongest sense the server has: the
// document lands under a private directory (0700/0600) plus an index row, and
// nothing serves either. It is not on a board, not in GET /data/*.json, and not
// in the checklist the CLI imports — that list comes from the improvement
// categories and only from them.
//
// It is also never the consequence of another answer. The CLI asks for a trace
// as its own question, after the results question has been answered, and
// defaults it to no; this handler's job is to hold up that promise on the
// server side by storing what arrives and publishing none of it.
func (s *Server) handleSubmitTrace(w http.ResponseWriter, r *http.Request) {
	if s.traces == nil {
		s.writeJSON(w, http.StatusServiceUnavailable, errorBody(
			"this deployment does not collect chains of thought (MAKEFASTER_TRACE_DIR is unset)"))
		return
	}
	body, ok := s.readBody(w, r)
	if !ok {
		return
	}
	submission, err := trace.DecodeSubmission(body, time.Now())
	if err != nil {
		var validation *trace.ValidationError
		if errors.As(err, &validation) {
			s.writeJSON(w, http.StatusBadRequest, errorPayload{OK: false, Errors: validation.Errors})
			return
		}
		s.fail(w, err)
		return
	}

	record, err := s.traces.Save(r.Context(), submission, true)
	if err != nil {
		s.fail(w, err)
		return
	}

	status := http.StatusOK
	if record.Created {
		status = http.StatusCreated
	}
	// The log line counts; it never carries the reasoning itself.
	s.logger.Info("submit-trace",
		"runId", record.RunID,
		"agent", submission.Agent,
		"blocks", record.ThinkingBlocks,
		"chars", record.ThinkingChars,
		"iterations", record.Iterations,
		"resultsSubmitted", submission.ResultsSubmitted,
		"created", record.Created)
	s.writeJSON(w, status, submitTraceResponse{
		OK:             true,
		RunID:          record.RunID,
		ThinkingBlocks: record.ThinkingBlocks,
		ThinkingChars:  record.ThinkingChars,
		Iterations:     record.Iterations,
		Truncated:      record.Truncated,
	})
}

// readBody reads at most 256 KB of request body, answering 413 beyond that —
// except on the inference route, whose payload is a whole conversation, and the
// trace route, whose payload is a session's reasoning.
func (s *Server) readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	limit := bodyLimitBytes
	switch r.URL.Path {
	case "/api/openrouter/v1/chat/completions":
		limit = inferenceBodyLimitBytes
	case "/api/submit-trace":
		limit = traceBodyLimitBytes
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
	if err != nil {
		s.writeJSON(w, http.StatusBadRequest, errorBody("could not read request body"))
		return nil, false
	}
	if len(body) > limit {
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

// rateLimiter caps requests per IP per window. Buckets are dropped wholesale
// past a crude memory ceiling rather than swept individually.
type rateLimiter struct {
	mu      sync.Mutex
	max     int
	buckets map[string]*bucket
}

type bucket struct {
	windowStart time.Time
	count       int
}

func newRateLimiter(max int) *rateLimiter {
	return &rateLimiter{max: max, buckets: map[string]*bucket{}}
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
	return existing.count <= l.max
}
