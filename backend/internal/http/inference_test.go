package httpapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"makefaster/internal/embedding"
	httpapi "makefaster/internal/http"
	"makefaster/internal/inference"
)

// fakeKey is a placeholder, not a credential.
const fakeKey = "test-not-a-real-key"

const inferencePath = "/api/openrouter/v1/chat/completions"

// The inference route touches no database, so these tests run everywhere —
// unlike the leaderboard tests, which need MariaDB.
func inferenceServer(t *testing.T, proxy *inference.Proxy) *httptest.Server {
	t.Helper()
	embedder, threshold := embedding.New(embedding.Options{}, nil)
	server := httpapi.NewServer(httpapi.Options{
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: t.TempDir(),
		Inference:   proxy,
	})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func fakeUpstream(t *testing.T, status int, body string) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var seen []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(r.Body)
		var parsed map[string]any
		_ = json.Unmarshal(payload, &parsed)
		seen = append(seen, parsed)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(upstream.Close)
	return upstream, &seen
}

func postInference(t *testing.T, base, body string) (*http.Response, string) {
	t.Helper()
	res, err := http.Post(base+inferencePath, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", inferencePath, err)
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(res.Body)
	return res, string(payload)
}

// The whole point of the endpoint: an OpenAI-shaped client sends no credential,
// names one of the models on offer, and gets a completion.
func TestInferenceProxyServesAnOpenAIShapedCompletion(t *testing.T) {
	for _, model := range inference.AllowedModels {
		upstream, forwarded := fakeUpstream(t, http.StatusOK, `{"choices":[{"message":{"role":"assistant","content":"hello"}}]}`)
		base := inferenceServer(t, inference.New(fakeKey, upstream.URL, nil)).URL

		res, payload := postInference(t, base, `{"model":"`+model+`","messages":[{"role":"user","content":"hi"}]}`)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: status: got %d, want 200 (%s)", model, res.StatusCode, payload)
		}
		if !strings.Contains(payload, "hello") {
			t.Errorf("%s: the completion was not returned: %s", model, payload)
		}
		if got := (*forwarded)[0]["model"]; got != model {
			t.Errorf("forwarded model: got %v, want %q", got, model)
		}
		if strings.Contains(payload, fakeKey) {
			t.Error("the credential reached the client")
		}
	}
}

// A client that asks for something else gets a 400 that names the alternatives,
// not a completion billed against a model nobody chose.
func TestInferenceProxyRefusesAModelItDoesNotServe(t *testing.T) {
	upstream, forwarded := fakeUpstream(t, http.StatusOK, `{"choices":[]}`)
	base := inferenceServer(t, inference.New(fakeKey, upstream.URL, nil)).URL

	res, payload := postInference(t, base, `{"model":"anthropic/claude-opus-4","messages":[{"role":"user","content":"hi"}]}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400 (%s)", res.StatusCode, payload)
	}
	for _, model := range inference.AllowedModels {
		if !strings.Contains(payload, model) {
			t.Errorf("the 400 should name %q as an option, got %s", model, payload)
		}
	}
	if len(*forwarded) != 0 {
		t.Errorf("a refused model must not reach upstream; got %d", len(*forwarded))
	}
}

// A deployment with no credential says so, in a way that tells the user what to
// do about it, and never pretends to work.
func TestInferenceProxyWithoutACredentialAnswers503(t *testing.T) {
	for _, proxy := range []*inference.Proxy{inference.New("", "https://openrouter.ai/api/v1", nil), nil} {
		base := inferenceServer(t, proxy).URL
		res, payload := postInference(t, base, `{"messages":[{"role":"user","content":"hi"}]}`)
		if res.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("status: got %d, want 503 (%s)", res.StatusCode, payload)
		}
		if !strings.Contains(payload, "OPENROUTER_API_KEY") || !strings.Contains(payload, "--cli") {
			t.Errorf("the 503 should explain the fix, got %s", payload)
		}
	}
}

func TestInferenceProxyRejectsAnEmptyOrBodylessRequest(t *testing.T) {
	upstream, forwarded := fakeUpstream(t, http.StatusOK, `{}`)
	base := inferenceServer(t, inference.New(fakeKey, upstream.URL, nil)).URL

	for _, body := range []string{"", `{}`, `{"messages":[]}`, "not json"} {
		res, payload := postInference(t, base, body)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: status %d, want 400 (%s)", body, res.StatusCode, payload)
		}
	}
	if len(*forwarded) != 0 {
		t.Errorf("a rejected request must not reach upstream; got %d", len(*forwarded))
	}
}

// The endpoint is subsidized, so it is capped per IP on its own budget rather
// than sharing the leaderboard writes' allowance.
func TestInferenceProxyIsRateLimitedOnItsOwnBudget(t *testing.T) {
	upstream, _ := fakeUpstream(t, http.StatusOK, `{"choices":[]}`)
	base := inferenceServer(t, inference.New(fakeKey, upstream.URL, nil)).URL
	body := `{"messages":[{"role":"user","content":"hi"}]}`

	limited := 0
	for i := 0; i < 40; i++ {
		res, _ := postInference(t, base, body)
		if res.StatusCode == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("40 completions in a burst should have hit the per-IP cap")
	}

	// And the cap explains itself rather than just saying no.
	res, payload := postInference(t, base, body)
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status: got %d, want 429", res.StatusCode)
	}
	if !strings.Contains(payload, "subsidized") {
		t.Errorf("the 429 should say why, got %s", payload)
	}
}

// GET /api/health tells the CLI whether the hosted provider will work here
// before a run starts — and says nothing about the credential itself.
func TestHealthReportsWhetherTheHostedModelIsAvailable(t *testing.T) {
	upstream, _ := fakeUpstream(t, http.StatusOK, `{}`)
	for _, test := range []struct {
		proxy     *inference.Proxy
		available bool
	}{
		{inference.New(fakeKey, upstream.URL, nil), true},
		{inference.New("", upstream.URL, nil), false},
	} {
		base := inferenceServer(t, test.proxy).URL
		res, err := http.Get(base + "/api/health")
		if err != nil {
			t.Fatalf("GET /api/health: %v", err)
		}
		payload, _ := io.ReadAll(res.Body)
		res.Body.Close()

		var health struct {
			Inference struct {
				Available bool     `json:"available"`
				Model     string   `json:"model"`
				Models    []string `json:"models"`
			} `json:"inference"`
		}
		if err := json.Unmarshal(payload, &health); err != nil {
			t.Fatalf("decode health: %v", err)
		}
		if health.Inference.Available != test.available {
			t.Errorf("available: got %v, want %v", health.Inference.Available, test.available)
		}
		if health.Inference.Model != inference.DefaultModel {
			t.Errorf("model: got %q, want %q", health.Inference.Model, inference.DefaultModel)
		}
		// The CLI checks the model it is about to run against this list, so the
		// choice it offers is the choice the server will honour.
		if !reflect.DeepEqual(health.Inference.Models, inference.AllowedModels) {
			t.Errorf("models: got %v, want %v", health.Inference.Models, inference.AllowedModels)
		}
		if strings.Contains(string(payload), fakeKey) {
			t.Error("health leaked the credential")
		}
	}
}
