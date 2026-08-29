package inference_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"makefaster/internal/inference"
)

// fakeKey is a placeholder, not a credential. No test in this repo needs a real
// one: every upstream call goes to an httptest server.
const fakeKey = "test-not-a-real-key"

// upstream stands in for OpenRouter and records what it was asked for.
type upstream struct {
	server   *httptest.Server
	requests []map[string]any
	headers  []http.Header
	status   int
	body     string
}

func newUpstream(t *testing.T) *upstream {
	t.Helper()
	fake := &upstream{status: http.StatusOK, body: `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("upstream path: got %q, want /chat/completions", r.URL.Path)
		}
		payload, _ := io.ReadAll(r.Body)
		var parsed map[string]any
		_ = json.Unmarshal(payload, &parsed)
		fake.requests = append(fake.requests, parsed)
		fake.headers = append(fake.headers, r.Header.Clone())
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(fake.status)
		_, _ = w.Write([]byte(fake.body))
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func request(t *testing.T, body string) []byte {
	t.Helper()
	return []byte(body)
}

// The user picks the model, from the set the server is willing to spend its
// credential on. Every id on that list is forwarded exactly as asked for.
func TestChatCompletionsForwardsEveryAllowlistedModel(t *testing.T) {
	if len(inference.AllowedModels) < 2 {
		t.Fatalf("the proxy is meant to allowlist a choice of models, got %v", inference.AllowedModels)
	}
	for _, model := range inference.AllowedModels {
		fake := newUpstream(t)
		proxy := inference.New(fakeKey, fake.server.URL, nil)

		body := `{"model":"` + model + `","messages":[{"role":"user","content":"hi"}],"max_tokens":900000}`
		status, payload, err := proxy.ChatCompletions(context.Background(), request(t, body))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", model, err)
		}
		if status != http.StatusOK {
			t.Errorf("%s: status %d", model, status)
		}
		if !strings.Contains(string(payload), "assistant") {
			t.Errorf("%s: upstream body was not returned: %s", model, payload)
		}
		if len(fake.requests) != 1 {
			t.Fatalf("%s: expected 1 forwarded request, got %d", model, len(fake.requests))
		}
		if got := fake.requests[0]["model"]; got != model {
			t.Errorf("forwarded model: got %v, want %q", got, model)
		}
		if tokens, ok := fake.requests[0]["max_tokens"].(float64); !ok || tokens > 8192 {
			t.Errorf("%s: max_tokens: got %v, want a value capped at 8192", model, fake.requests[0]["max_tokens"])
		}
	}
}

// Naming no model is the one case that gets a substitution, and it gets the
// default rather than whatever the client last sent.
func TestChatCompletionsDefaultsTheModelWhenNoneIsAskedFor(t *testing.T) {
	fake := newUpstream(t)
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	for _, body := range []string{
		`{"messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"","messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"  ","messages":[{"role":"user","content":"hi"}]}`,
	} {
		if _, _, err := proxy.ChatCompletions(context.Background(), request(t, body)); err != nil {
			t.Fatalf("%s: unexpected error: %v", body, err)
		}
	}
	for i, forwarded := range fake.requests {
		if forwarded["model"] != inference.DefaultModel {
			t.Errorf("request %d model: got %v, want %q", i, forwarded["model"], inference.DefaultModel)
		}
	}
}

// The choice is between the allowlisted ids, and that is the whole choice. This
// is not an arbitrary-model proxy: an id nobody chose is refused before it can
// cost anything, and the refusal names what the caller could have asked for.
func TestChatCompletionsRefusesAModelThatIsNotOnTheAllowlist(t *testing.T) {
	fake := newUpstream(t)
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	for _, body := range []string{
		`{"model":"anthropic/claude-opus-4","messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"stealth/ox-alpha-turbo","messages":[{"role":"user","content":"hi"}]}`,
	} {
		_, _, err := proxy.ChatCompletions(context.Background(), request(t, body))
		var invalid *inference.InvalidRequestError
		if !errors.As(err, &invalid) {
			t.Errorf("%s: got error %v, want an InvalidRequestError", body, err)
			continue
		}
		if !strings.Contains(invalid.Reason, inference.DefaultModel) {
			t.Errorf("%s: the refusal should name what is on offer, got %q", body, invalid.Reason)
		}
	}
	// And a model that is not even a name is a client mistake, not a default.
	_, _, err := proxy.ChatCompletions(context.Background(), request(t, `{"model":42,"messages":[{"role":"user","content":"hi"}]}`))
	var invalid *inference.InvalidRequestError
	if !errors.As(err, &invalid) || !strings.Contains(invalid.Reason, "must be a string") {
		t.Errorf("a non-string model: got %v", err)
	}

	if len(fake.requests) != 0 {
		t.Errorf("a refused model must not reach upstream; got %d requests", len(fake.requests))
	}
}

// The allowlist is the server's, so a caller cannot grow it.
func TestModelsIsACopyOfTheAllowlist(t *testing.T) {
	proxy := inference.New(fakeKey, "https://example.invalid/v1", nil)
	models := proxy.Models()
	if len(models) != len(inference.AllowedModels) {
		t.Fatalf("Models(): got %v, want %v", models, inference.AllowedModels)
	}
	models[0] = "somebody/elses-model"
	if inference.AllowedModels[0] == "somebody/elses-model" {
		t.Error("Models() handed out the allowlist itself")
	}
	if !inference.ModelAllowed(inference.DefaultModel) {
		t.Errorf("the default model %q is not on the allowlist", inference.DefaultModel)
	}
	if inference.ModelAllowed("somebody/elses-model") {
		t.Error("ModelAllowed said yes to a model nobody chose")
	}
}

// Everything that decides what a request costs is overridden, and nothing the
// client sent can carry a credential upstream.
func TestChatCompletionsRefusesStreamingAndStripsClientCredentials(t *testing.T) {
	fake := newUpstream(t)
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	body := `{"messages":[{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true},
		"api_key":"sk-somebody-elses","authorization":"Bearer sk-somebody-elses","temperature":0.2}`
	if _, _, err := proxy.ChatCompletions(context.Background(), request(t, body)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	forwarded := fake.requests[0]
	for _, field := range []string{"stream", "stream_options", "api_key", "authorization"} {
		if _, present := forwarded[field]; present {
			t.Errorf("%q was forwarded upstream", field)
		}
	}
	// A legitimate knob still goes through.
	if forwarded["temperature"] != 0.2 {
		t.Errorf("temperature: got %v, want 0.2", forwarded["temperature"])
	}
	// The server's own credential is the only authorization upstream sees.
	if got := fake.headers[0].Get("authorization"); got != "Bearer "+fakeKey {
		t.Errorf("upstream authorization: got %q", got)
	}
}

func TestChatCompletionsRejectsRequestsThatWouldCostNothingUseful(t *testing.T) {
	fake := newUpstream(t)
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	for _, body := range []string{"", "   ", "not json", `{"messages":[]}`, `{"messages":"hi"}`, `{}`, `[]`} {
		_, _, err := proxy.ChatCompletions(context.Background(), request(t, body))
		var invalid *inference.InvalidRequestError
		if !errors.As(err, &invalid) {
			t.Errorf("%q: got error %v, want an InvalidRequestError", body, err)
		}
	}
	if len(fake.requests) != 0 {
		t.Errorf("a rejected request must not reach upstream; got %d", len(fake.requests))
	}
}

// Without a credential the proxy is unavailable rather than broken, and it never
// calls out.
func TestChatCompletionsWithoutACredentialIsUnavailable(t *testing.T) {
	fake := newUpstream(t)
	proxy := inference.New("", fake.server.URL, nil)

	if proxy.Available() {
		t.Error("a proxy with no key must not report itself available")
	}
	_, _, err := proxy.ChatCompletions(context.Background(), request(t, `{"messages":[{"role":"user","content":"hi"}]}`))
	if !errors.Is(err, inference.ErrUnavailable) {
		t.Errorf("got %v, want ErrUnavailable", err)
	}
	if len(fake.requests) != 0 {
		t.Error("an unavailable proxy must not call upstream")
	}
}

// An upstream error is the CLI's business — it has to see the reason — so it is
// passed through rather than flattened into a 500.
func TestUpstreamErrorsArePassedThrough(t *testing.T) {
	fake := newUpstream(t)
	fake.status = http.StatusPaymentRequired
	fake.body = `{"error":{"message":"insufficient credits","code":402}}`
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	status, payload, err := proxy.ChatCompletions(context.Background(), request(t, `{"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != http.StatusPaymentRequired {
		t.Errorf("status: got %d, want 402", status)
	}
	if !strings.Contains(string(payload), "insufficient credits") {
		t.Errorf("the upstream reason was lost: %s", payload)
	}
}

// The credential never leaves the server, even if an upstream ever echoed it.
func TestTheCredentialIsNeverReturned(t *testing.T) {
	fake := newUpstream(t)
	fake.body = `{"error":{"message":"bad key: ` + fakeKey + `"}}`
	fake.status = http.StatusUnauthorized
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	_, payload, err := proxy.ChatCompletions(context.Background(), request(t, `{"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(string(payload), fakeKey) {
		t.Fatalf("the credential was echoed to the client: %s", payload)
	}
	if !strings.Contains(string(payload), "[redacted]") {
		t.Errorf("expected the credential to be redacted, got %s", payload)
	}
}

func TestUnreachableUpstreamIsSummarized(t *testing.T) {
	proxy := inference.New(fakeKey, "http://127.0.0.1:1/v1", nil)
	_, _, err := proxy.ChatCompletions(context.Background(), request(t, `{"messages":[{"role":"user","content":"hi"}]}`))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), fakeKey) {
		t.Errorf("the credential leaked into an error: %v", err)
	}
	if !strings.Contains(err.Error(), "could not be reached") {
		t.Errorf("unexpected error text: %v", err)
	}
}
