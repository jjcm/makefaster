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

	DefaultEmbeddingsModel   = "text-embedding-3-small"
	DefaultEmbeddingsBaseURL = "https://api.openai.com/v1"
)

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
	Embeddings    Embeddings
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
		Embeddings:    loadEmbeddings(),
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
