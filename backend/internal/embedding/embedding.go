// Package embedding provides the text embeddings used to match submitted
// improvements against the improvement-category leaderboard.
//
// Two backends sit behind one interface:
//
//   - local  — a deterministic feature-hashing embedder (signed hashed words,
//     word bigrams, and character n-grams, L2-normalized). No model download,
//     no GPU, no network. Good enough to match short "what I sped up" blurbs
//     against category names + descriptions.
//   - remote — any OpenAI-compatible /v1/embeddings endpoint, enabled by
//     setting MAKEFASTER_EMBEDDINGS_API_KEY (or OPENAI_API_KEY).
//
// Nothing is persisted in embedding space: every request embeds the incoming
// improvements AND the current categories with the same backend, so the two
// backends can never be compared against each other's vectors. If the remote
// backend fails mid-request we fall back to local for the whole request.
//
// The local embedder is a straight port of the Node implementation it replaced
// and produces identical vectors: same tokenizer, same stemmer, same FNV-1a
// seeds, same feature weights, same accumulation order.
package embedding

import (
	"math"
	"regexp"
	"strings"
	"sync"
)

// localDims: short texts carry few word features, so hash collisions are the
// noise floor. 4096 dims keeps random cross-text collisions negligible while a
// 50-category board still fits in ~1.6 MB of vectors.
const localDims = 4096

// FNV-1a offset basis and the second seed used for the feature sign bit.
const (
	fnvIndexSeed uint32 = 0x811c9dc5
	fnvSignSeed  uint32 = 0x9747b28c
	fnvPrime     uint32 = 0x01000193
)

// Embedder turns texts into L2-normalized vectors of equal length.
type Embedder interface {
	// ID identifies the backend in API responses, e.g. "local-hash-v1".
	ID() string
	// Kind is "local" or "remote"; it selects the default match threshold.
	Kind() string
	EmbedMany(texts []string) [][]float64
}

// tokenPattern matches the runs of letters and digits that become word
// features; everything else is a separator.
var tokenPattern = regexp.MustCompile(`[a-z0-9]+`)

// stopwords are so generic in performance-speak that they match everything.
// They are dropped before hashing so "Improve image loading speed" is matched
// on image/loading, not on improve/speed.
var stopwords = map[string]struct{}{}

func init() {
	words := []string{
		"a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at",
		"from", "into", "via", "the", "our", "your", "their", "its", "is", "are",
		"was", "were", "be", "been", "it", "this", "that", "these", "those", "as",
		"we", "you", "i", "using", "use", "used", "uses", "make", "makes", "made",
		"making", "improve", "improved", "improves", "improvement", "improvements",
		"optimize", "optimized", "optimizes", "optimization", "optimizations",
		"reduce", "reduced", "reduces", "reducing", "better", "faster", "fast",
		"slow", "slower", "speed", "speedup", "site", "sites", "website",
		"websites", "page", "pages", "web", "app", "apps", "perf", "performance",
		"now", "all", "more", "less", "new", "old", "time", "times",
	}
	for _, word := range words {
		stopwords[word] = struct{}{}
	}
}

func fnv1a(text string, seed uint32) uint32 {
	hash := seed
	for i := 0; i < len(text); i++ {
		hash ^= uint32(text[i])
		hash *= fnvPrime
	}
	return hash
}

// stem is very light suffix stripping so plural/verb forms hash to the same
// word feature (fonts/font, caching/cache/cached, subsetting/subset,
// images/image) without dragging in a stemming dependency. Char n-grams still
// bridge the forms this misses (compression/compress).
func stem(token string) string {
	t := token
	switch {
	case len(t) > 5 && strings.HasSuffix(t, "ing"):
		t = t[:len(t)-3]
	case len(t) > 4 && strings.HasSuffix(t, "ies"):
		t = t[:len(t)-3] + "y"
	case len(t) > 4 && strings.HasSuffix(t, "ed"):
		t = t[:len(t)-2]
	case len(t) > 4 && strings.HasSuffix(t, "es"):
		t = t[:len(t)-2]
	case len(t) > 3 && strings.HasSuffix(t, "s") && !strings.HasSuffix(t, "ss"):
		t = t[:len(t)-1]
	}
	if len(t) > 3 && t[len(t)-1] == t[len(t)-2] {
		t = t[:len(t)-1] // subsett -> subset
	}
	if len(t) > 4 && strings.HasSuffix(t, "e") {
		t = t[:len(t)-1] // cache/caching -> cach
	}
	return t
}

func tokenize(text string) []string {
	raw := tokenPattern.FindAllString(strings.ToLower(text), -1)
	tokens := make([]string, 0, len(raw))
	for _, token := range raw {
		if len(token) < 2 {
			continue
		}
		if _, isStop := stopwords[token]; isStop {
			continue
		}
		tokens = append(tokens, stem(token))
	}
	return tokens
}

func addFeature(vector []float64, feature string, weight float64) {
	index := fnv1a(feature, fnvIndexSeed) % localDims
	if fnv1a(feature, fnvSignSeed)&1 == 1 {
		vector[index] += weight
	} else {
		vector[index] -= weight
	}
}

// Local is the deterministic local embedding: signed feature hashing over word
// unigrams, word bigrams, and per-token character 3/4-grams (word-boundary
// marked so "compress"/"compression" overlap without random cross-word grams).
func Local(text string) []float64 {
	vector := make([]float64, localDims)
	tokens := tokenize(text)

	for _, token := range tokens {
		addFeature(vector, "w:"+token, 2.0)
		// Char n-grams only bridge morphology the stemmer misses, so they carry
		// little weight — heavier grams let unrelated texts collide.
		padded := "^" + token + "$"
		for _, gram := range []struct {
			n      int
			prefix string
			weight float64
		}{{3, "c3:", 0.35}, {4, "c4:", 0.5}} {
			for i := 0; i+gram.n <= len(padded); i++ {
				addFeature(vector, gram.prefix+padded[i:i+gram.n], gram.weight)
			}
		}
	}
	for i := 0; i+1 < len(tokens); i++ {
		addFeature(vector, "b:"+tokens[i]+"_"+tokens[i+1], 1.5)
	}

	return l2Normalize(vector)
}

func l2Normalize(vector []float64) []float64 {
	sumSquares := 0.0
	for _, v := range vector {
		sumSquares += v * v
	}
	if sumSquares == 0 {
		return vector
	}
	inv := 1 / math.Sqrt(sumSquares)
	for i := range vector {
		vector[i] *= inv
	}
	return vector
}

// CosineSimilarity is the plain dot product of two L2-normalized vectors.
// Mismatched dimensions score 0 rather than panicking: a remote backend that
// changes models mid-life should degrade to "everything is novel", not crash
// the endpoint.
func CosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) {
		return 0
	}
	dot := 0.0
	for i := range a {
		dot += a[i] * b[i]
	}
	return dot
}

type localEmbedder struct {
	mu    sync.Mutex
	cache map[string][]float64
}

// NewLocal returns the local feature-hashing embedder.
func NewLocal() Embedder {
	return &localEmbedder{cache: map[string][]float64{}}
}

func (e *localEmbedder) ID() string   { return "local-hash-v1" }
func (e *localEmbedder) Kind() string { return "local" }

func (e *localEmbedder) EmbedMany(texts []string) [][]float64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	vectors := make([][]float64, len(texts))
	for i, text := range texts {
		vector, cached := e.cache[text]
		if !cached {
			vector = Local(text)
			e.cache[text] = vector
		}
		vectors[i] = vector
	}
	return vectors
}
