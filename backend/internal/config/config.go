// Package config resolves the server's runtime configuration from the
// environment. Every value has a working default so `./run.sh` boots against a
// local MariaDB with no .env file at all.
package config

import (
	"os"
	"strconv"
	"strings"
)

const (
	DefaultPort          = 8787
	DefaultHost          = "0.0.0.0"
	DefaultMariaDSN      = "root:root@tcp(127.0.0.1:3306)/makefaster?parseTime=true"
	DefaultMigrationsDir = "./internal/db/migrations"
	DefaultFrontendDir   = "../frontend"
	DefaultSeedDir       = "../data"

	// Where the private chain-of-thought traces are stored. Outside the repo
	// and outside FRONTEND_DIR on purpose: the one thing that must never
	// happen to a trace is being served as a static file. Setting
	// MAKEFASTER_TRACE_DIR to "off" turns collection off entirely.
	DefaultTraceDir = "/var/lib/makefaster/traces"

	DefaultEmbeddingsModel   = "text-embedding-3-small"
	DefaultEmbeddingsBaseURL = "https://api.openai.com/v1"

	DefaultOpenRouterBaseURL = "https://openrouter.ai/api/v1"
)

// Inference configures the subsidized model proxy that the CLI's `makefaster`
// provider used to run on: this server holds the OpenRouter credential and
// forwards chat completions on a client's behalf.
//
// APIKey empty is a supported state, not a misconfiguration, and it is the
// expected one now that the provider is gone and nothing in this repo calls the
// endpoint: the proxy answers 503 with an explanation.
type Inference struct {
	APIKey  string
	BaseURL string
}

// Available reports whether the proxy can actually reach OpenRouter.
func (i Inference) Available() bool { return i.APIKey != "" }

// Embeddings selects the embedding backend. An empty APIKey means the
// deterministic local feature-hashing embedder.
type Embeddings struct {
	APIKey  string
	Model   string
	BaseURL string

	// ThresholdOverride is MAKEFASTER_MATCH_THRESHOLD when it parsed to a
	// value in (0, 1); zero means "use the per-backend default".
	ThresholdOverride float64
}

type Config struct {
	Port          int
	Host          string
	MariaDSN      string
	MigrationsDir string
	FrontendDir   string
	SeedDir       string
	TraceDir      string
	Embeddings    Embeddings
	Inference     Inference
}

// TracesEnabled reports whether this deployment collects chains of thought. An
// explicit "off" (or an empty value) means it does not, and
// POST /api/submit-trace answers 503 saying so.
func (c Config) TracesEnabled() bool {
	return c.TraceDir != "" && !strings.EqualFold(c.TraceDir, "off")
}

// Addr is the host:port passed to net/http.
func (c Config) Addr() string {
	return c.Host + ":" + strconv.Itoa(c.Port)
}

// Load reads the configuration from the process environment.
func Load() Config {
	return Config{
		Port:          envInt("PORT", DefaultPort),
		Host:          envString("HOST", DefaultHost),
		MariaDSN:      envString("MARIADB_DSN", DefaultMariaDSN),
		MigrationsDir: envString("MIGRATIONS_DIR", DefaultMigrationsDir),
		FrontendDir:   envString("FRONTEND_DIR", DefaultFrontendDir),
		SeedDir:       envString("SEED_DIR", DefaultSeedDir),
		TraceDir:      envString("MAKEFASTER_TRACE_DIR", DefaultTraceDir),
		Embeddings:    loadEmbeddings(),
		Inference:     loadInference(),
	}
}

func loadInference() Inference {
	return Inference{
		APIKey:  envString("OPENROUTER_API_KEY", ""),
		BaseURL: envString("MAKEFASTER_OPENROUTER_BASE_URL", DefaultOpenRouterBaseURL),
	}
}

func loadEmbeddings() Embeddings {
	apiKey := envString("MAKEFASTER_EMBEDDINGS_API_KEY", "")
	if apiKey == "" {
		apiKey = envString("OPENAI_API_KEY", "")
	}
	return Embeddings{
		APIKey:            apiKey,
		Model:             envString("MAKEFASTER_EMBEDDINGS_MODEL", DefaultEmbeddingsModel),
		BaseURL:           envString("MAKEFASTER_EMBEDDINGS_BASE_URL", DefaultEmbeddingsBaseURL),
		ThresholdOverride: thresholdOverride(os.Getenv("MAKEFASTER_MATCH_THRESHOLD")),
	}
}

// thresholdOverride mirrors the Node server: only a finite value strictly
// between 0 and 1 wins over the per-backend default.
func thresholdOverride(raw string) float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || value <= 0 || value >= 1 {
		return 0
	}
	return value
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
