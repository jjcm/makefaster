package embedding

import "log/slog"

// DefaultThresholdLocal and DefaultThresholdRemote are the cosine-similarity
// cutoffs above which an incoming improvement folds into an existing category
// instead of creating a new one. The local value is pinned by the
// paraphrase/novel separation test in embedding_test.go.
const (
	DefaultThresholdLocal  = 0.3
	DefaultThresholdRemote = 0.55
)

// Options selects the backend. An empty APIKey means the local embedder.
type Options struct {
	APIKey  string
	Model   string
	BaseURL string

	// ThresholdOverride wins over the per-backend default when non-zero.
	ThresholdOverride float64
}

// New picks the embedding backend and resolves the match threshold that goes
// with it.
func New(opts Options, logger *slog.Logger) (Embedder, float64) {
	var embedder Embedder
	if opts.APIKey != "" {
		embedder = NewRemote(opts.APIKey, opts.BaseURL, opts.Model, logger)
	} else {
		embedder = NewLocal()
	}

	threshold := DefaultThresholdLocal
	if embedder.Kind() == "remote" {
		threshold = DefaultThresholdRemote
	}
	if opts.ThresholdOverride > 0 {
		threshold = opts.ThresholdOverride
	}
	return embedder, threshold
}
