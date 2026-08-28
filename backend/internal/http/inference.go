package httpapi

import (
	"errors"
	"net/http"

	"makefaster/internal/inference"
)

// POST /api/openrouter/v1/chat/completions
//
// The OpenAI-compatible surface the CLI's `makefaster` provider used to talk
// to: an ordinary chat-completions client points at `<api-base>/api/openrouter/v1`
// and sends no credential, because the credential is here. That provider is
// gone, so nothing in this repo calls it any more.
//
// This is the only endpoint that costs money per request, so it is rate limited
// on its own budget rather than sharing the write endpoints' allowance, and the
// model has to be one the proxy allowlists (see internal/inference).
func (s *Server) handleInferenceChat(w http.ResponseWriter, r *http.Request) {
	if !s.inference.Available() {
		s.writeJSON(w, http.StatusServiceUnavailable, errorBody(inference.ErrUnavailable.Error()))
		return
	}
	if !s.inferenceLimiter.allow(clientIP(r)) {
		s.writeJSON(w, http.StatusTooManyRequests, errorBody(
			"the model proxy is rate limited — it is subsidized, so it is capped per IP. Wait a minute, or run makefaster with your own agent CLI (--cli cursor|claude|codex)."))
		return
	}

	body, ok := s.readBody(w, r)
	if !ok {
		return
	}

	status, payload, err := s.inference.ChatCompletions(r.Context(), body)
	if err != nil {
		var invalid *inference.InvalidRequestError
		switch {
		case errors.As(err, &invalid):
			s.writeJSON(w, http.StatusBadRequest, errorBody(invalid.Reason))
		case errors.Is(err, inference.ErrUnavailable):
			s.writeJSON(w, http.StatusServiceUnavailable, errorBody(err.Error()))
		default:
			// The proxy already summarized this without the credential in it.
			s.logger.Error("inference proxy failed", "error", err)
			s.writeJSON(w, http.StatusBadGateway, errorBody(err.Error()))
		}
		return
	}

	// Upstream's own JSON, verbatim (scrubbed by the proxy) so an OpenAI-shaped
	// client — including its error handling — works unchanged.
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
