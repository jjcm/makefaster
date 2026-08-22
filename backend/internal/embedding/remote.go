package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const remoteTimeout = 10 * time.Second

type remoteEmbedder struct {
	apiKey  string
	baseURL string
	model   string
	logger  *slog.Logger
	client  *http.Client

	local Embedder
	mu    sync.Mutex
	cache map[string][]float64
}

// NewRemote returns an embedder backed by any OpenAI-compatible
// /v1/embeddings endpoint, with the local embedder as its failure fallback.
func NewRemote(apiKey, baseURL, model string, logger *slog.Logger) Embedder {
	return &remoteEmbedder{
		apiKey:  apiKey,
		baseURL: strings.TrimSuffix(baseURL, "/"),
		model:   model,
		logger:  logger,
		client:  &http.Client{Timeout: remoteTimeout},
		local:   NewLocal(),
		cache:   map[string][]float64{},
	}
}

func (e *remoteEmbedder) ID() string   { return "remote:" + e.model }
func (e *remoteEmbedder) Kind() string { return "remote" }

func (e *remoteEmbedder) EmbedMany(texts []string) [][]float64 {
	e.mu.Lock()
	missing := make([]string, 0, len(texts))
	seen := map[string]struct{}{}
	for _, text := range texts {
		if _, cached := e.cache[text]; cached {
			continue
		}
		if _, queued := seen[text]; queued {
			continue
		}
		seen[text] = struct{}{}
		missing = append(missing, text)
	}
	e.mu.Unlock()

	if len(missing) > 0 {
		vectors, err := e.request(missing)
		if err != nil {
			// Whole-request fallback keeps every comparison inside one
			// embedding space; cached remote vectors are simply unused.
			e.logger.Warn("remote embeddings failed; falling back to local embedder for this request", "error", err)
			return e.local.EmbedMany(texts)
		}
		e.mu.Lock()
		for i, text := range missing {
			e.cache[text] = vectors[i]
		}
		e.mu.Unlock()
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([][]float64, len(texts))
	for i, text := range texts {
		out[i] = e.cache[text]
	}
	return out
}

type embeddingsResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float64 `json:"embedding"`
	} `json:"data"`
}

func (e *remoteEmbedder) request(texts []string) ([][]float64, error) {
	body, err := json.Marshal(map[string]any{"model": e.model, "input": texts})
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), remoteTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+e.apiKey)

	res, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		return nil, fmt.Errorf("embeddings API responded %d: %s", res.StatusCode, snippet)
	}

	var parsed embeddingsResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	if len(parsed.Data) != len(texts) {
		return nil, fmt.Errorf("embeddings API returned an unexpected payload shape")
	}

	sort.Slice(parsed.Data, func(i, j int) bool { return parsed.Data[i].Index < parsed.Data[j].Index })
	vectors := make([][]float64, len(parsed.Data))
	for i, entry := range parsed.Data {
		vectors[i] = l2Normalize(entry.Embedding)
	}
	return vectors, nil
}
