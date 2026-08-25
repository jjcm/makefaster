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

// The model is the server's decision. Whatever the client asks for is discarded,
// because the client is spending somebody else's credential.
func TestChatCompletionsPinsTheModel(t *testing.T) {
	fake := newUpstream(t)
	proxy := inference.New(fakeKey, fake.server.URL, nil)

	for _, body := range []string{
		`{"messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"anthropic/claude-opus-4","messages":[{"role":"user","content":"hi"}]}`,
		`{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"hi"}],"max_tokens":900000}`,
	} {
		status, payload, err := proxy.ChatCompletions(context.Background(), request(t, body))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", body, err)
		}
		if status != http.StatusOK {
			t.Errorf("%s: status %d", body, status)
		}
		if !strings.Contains(string(payload), "assistant") {
			t.Errorf("%s: upstream body was not returned: %s", body, payload)
		}
	}

	if len(fake.requests) != 3 {
		t.Fatalf("expected 3 forwarded requests, got %d", len(fake.requests))
	}
	for i, forwarded := range fake.requests {
		if forwarded["model"] != inference.PinnedModel {
			t.Errorf("request %d model: got %v, want %q", i, forwarded["model"], inference.PinnedModel)
		}
		if tokens, ok := forwarded["max_tokens"].(float64); !ok || tokens > 8192 {
			t.Errorf("request %d max_tokens: got %v, want a value capped at 8192", i, forwarded["max_tokens"])
		}
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
