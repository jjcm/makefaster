// Package inference is the subsidized model proxy behind the `makefaster`
// provider in the CLI.
//
// Every other provider makefaster supports is a CLI the user already installed
// and signed into, so the model is theirs and so is the bill. That excludes
// anyone who has none of them. This path closes that gap: the server holds one
// OpenRouter credential, the CLI holds nothing, and chat completions are
// forwarded on the CLI's behalf.
//
// Which makes this the one endpoint on the box that spends money on request, so
// the rules are deliberately narrow:
//
//   - the model must be one of AllowedModels. The user picks between them in the
//     CLI, but the set is the server's: a model that is not on the list is
//     refused rather than substituted, so nobody can turn this into an
//     arbitrary-model proxy and no request quietly bills a model the caller did
//     not ask for;
//   - `max_tokens` is clamped and streaming is refused, so one request cannot
//     run away;
//   - a request with no messages is rejected before it costs anything;
//   - the credential is never echoed. It is not in any response body, any error
//     string, or any log line, and the response is scrubbed on the way out as a
//     backstop.
//
// Rate limiting lives with the other HTTP concerns in internal/http.
package inference

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// DefaultModel is what a request that names no model gets.
const DefaultModel = "stealth/ox-alpha"

// AllowedModels is every model this proxy will ask for, in the order the CLI
// offers them. Adding one here is a decision about what the credential may be
// spent on, so the list is deliberately short and deliberately explicit — an
// empty `model` means DefaultModel, and anything else is refused.
var AllowedModels = []string{
	"stealth/ox-alpha",
	"z-ai/glm-5.2:free",
}

// ModelAllowed reports whether the proxy will forward a request for this model.
func ModelAllowed(model string) bool {
	for _, allowed := range AllowedModels {
		if model == allowed {
			return true
		}
	}
	return false
}

const (
	// A tool-calling turn is mostly prompt, so the reply cap can be modest;
	// this is the ceiling, not a default.
	maxTokensCeiling = 8192

	// Long enough for a reasoning model on a large prompt, short enough that a
	// hung upstream does not hold a connection all day.
	upstreamTimeout = 180 * time.Second

	// Enough to read a real error body without copying a whole completion into
	// a log line.
	errorSnippetBytes = 300
)

// ErrUnavailable is returned when the server holds no OpenRouter credential.
var ErrUnavailable = errors.New("this makefaster deployment has no OpenRouter credential configured, so the hosted model is unavailable — run makefaster with --cli cursor|claude|codex instead, or set OPENROUTER_API_KEY on the server")

// Proxy forwards OpenAI-compatible chat completions to OpenRouter under the
// server's own credential.
type Proxy struct {
	apiKey  string
	baseURL string
	logger  *slog.Logger
	client  *http.Client
}

// New builds a proxy. An empty apiKey yields a proxy that reports itself
// unavailable and never calls upstream.
func New(apiKey, baseURL string, logger *slog.Logger) *Proxy {
	if logger == nil {
		logger = slog.Default()
	}
	return &Proxy{
		apiKey:  strings.TrimSpace(apiKey),
		baseURL: strings.TrimSuffix(strings.TrimSpace(baseURL), "/"),
		logger:  logger,
		client:  &http.Client{Timeout: upstreamTimeout},
	}
}

// Available reports whether a credential is configured.
func (p *Proxy) Available() bool { return p != nil && p.apiKey != "" }

// Model is the default model, for anything that wants to display one.
func (p *Proxy) Model() string { return DefaultModel }

// Models is the allowlist, for anything that wants to offer a choice — the CLI's
// picker checks its own two ids against this before a run starts.
func (p *Proxy) Models() []string { return append([]string(nil), AllowedModels...) }

// InvalidRequestError is a client mistake: the caller sent something this proxy
// will not forward. The message is safe to return verbatim.
type InvalidRequestError struct{ Reason string }

func (e *InvalidRequestError) Error() string { return e.Reason }

// ChatCompletions forwards one sanitized request and returns the upstream
// status and body. A non-nil error means nothing was forwarded (or the upstream
// could not be reached), and the caller decides the status; a nil error returns
// whatever OpenRouter said, including its errors, because the CLI needs to see
// them.
func (p *Proxy) ChatCompletions(ctx context.Context, requestBody []byte) (int, []byte, error) {
	if !p.Available() {
		return 0, nil, ErrUnavailable
	}
	sanitized, model, err := sanitizeRequest(requestBody)
	if err != nil {
		return 0, nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(sanitized))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+p.apiKey)
	// OpenRouter attributes traffic with these; they identify the project, not
	// the user, and carry nothing about the repo being sped up.
	req.Header.Set("http-referer", "https://makefaster.dev")
	req.Header.Set("x-title", "makefaster")

	started := time.Now()
	res, err := p.client.Do(req)
	if err != nil {
		// The URL can carry no credential (it is a plain base URL), but the
		// error is still summarized rather than wrapped verbatim.
		return 0, nil, fmt.Errorf("the model provider could not be reached: %s", firstLine(err.Error()))
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024))
	if err != nil {
		return 0, nil, fmt.Errorf("the model provider's response could not be read")
	}

	p.logger.Info("inference proxy",
		"status", res.StatusCode,
		"model", model,
		"ms", time.Since(started).Milliseconds(),
		"bytes", len(body))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		p.logger.Warn("inference upstream rejected the request",
			"status", res.StatusCode,
			"detail", firstLine(string(p.scrub(body[:min(len(body), errorSnippetBytes)]))))
	}
	return res.StatusCode, p.scrub(body), nil
}

// scrub removes the credential from anything on its way back to a client. It
// should never fire — OpenRouter does not echo keys — which is exactly why it is
// cheap insurance rather than a real code path.
func (p *Proxy) scrub(payload []byte) []byte {
	if p.apiKey == "" {
		return payload
	}
	return bytes.ReplaceAll(payload, []byte(p.apiKey), []byte("[redacted]"))
}

// sanitizeRequest rewrites the client's request into the only shape this proxy
// forwards, and returns the model it settled on. It keeps the fields a chat
// completion needs and overrides the ones that decide what the request costs.
func sanitizeRequest(requestBody []byte) ([]byte, string, error) {
	if len(bytes.TrimSpace(requestBody)) == 0 {
		return nil, "", &InvalidRequestError{Reason: "a chat completion request body is required"}
	}
	var request map[string]any
	if err := json.Unmarshal(requestBody, &request); err != nil {
		return nil, "", &InvalidRequestError{Reason: "the request body must be a JSON object"}
	}

	messages, ok := request["messages"].([]any)
	if !ok || len(messages) == 0 {
		return nil, "", &InvalidRequestError{Reason: "messages must be a non-empty array"}
	}

	// The caller chooses from the allowlist rather than naming anything it
	// likes, and an id that is not on it is refused rather than swapped for the
	// default: silently billing a model the user did not choose is worse than
	// saying no.
	model, err := resolveModel(request["model"])
	if err != nil {
		return nil, "", err
	}
	request["model"] = model

	// Streaming would mean proxying an event stream and losing the scrub; the
	// CLI does not need it, so it is refused rather than half-supported.
	delete(request, "stream")
	delete(request, "stream_options")

	// Nothing else may carry a credential upstream.
	for _, field := range []string{"api_key", "apiKey", "authorization", "key"} {
		delete(request, field)
	}

	switch tokens, given := numberField(request["max_tokens"]); {
	case !given || tokens > maxTokensCeiling || tokens <= 0:
		request["max_tokens"] = maxTokensCeiling
	default:
		request["max_tokens"] = int(tokens)
	}

	payload, err := json.Marshal(request)
	return payload, model, err
}

// resolveModel maps what the client asked for onto the allowlist: nothing (or an
// empty string) means the default, an allowed id passes through, and anything
// else is a client error naming what it could have asked for instead.
func resolveModel(requested any) (string, error) {
	if requested == nil {
		return DefaultModel, nil
	}
	name, ok := requested.(string)
	if !ok {
		return "", &InvalidRequestError{Reason: "model must be a string"}
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return DefaultModel, nil
	}
	if !ModelAllowed(name) {
		return "", &InvalidRequestError{Reason: fmt.Sprintf(
			"%q is not a model this deployment serves — the hosted provider offers %s",
			name, strings.Join(AllowedModels, " and "))}
	}
	return name, nil
}

func numberField(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok
}

func firstLine(text string) string {
	if index := strings.IndexAny(text, "\r\n"); index >= 0 {
		text = text[:index]
	}
	return strings.TrimSpace(text)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
