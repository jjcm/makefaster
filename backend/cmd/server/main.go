// Command server is the Makefaster leaderboard server: it migrates MariaDB,
// seeds the boards on a fresh database, then serves the SPA and the write APIs
// from a single process.
package main

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"

	"makefaster/internal/config"
	"makefaster/internal/db"
	"makefaster/internal/embedding"
	httpapi "makefaster/internal/http"
	"makefaster/internal/inference"
	"makefaster/internal/store"
	"makefaster/internal/trace"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// The repo root is the natural place for a shared .env, but running from
	// backend/ should work too.
	_ = godotenv.Load(".env")
	_ = godotenv.Load("../.env")

	cfg := config.Load()

	pool, err := db.Open(cfg.MariaDSN)
	if err != nil {
		logger.Error("could not reach mariadb", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := db.Migrate(pool, cfg.MigrationsDir); err != nil {
		logger.Error("migrations failed", "error", err)
		os.Exit(1)
	}

	leaderboards := store.New(pool)
	seedCtx, cancelSeed := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelSeed()
	if err := leaderboards.Seed(seedCtx, cfg.SeedDir); err != nil {
		logger.Error("seeding failed", "error", err)
		os.Exit(1)
	}

	embedder, threshold := embedding.New(embedding.Options{
		APIKey:            cfg.Embeddings.APIKey,
		Model:             cfg.Embeddings.Model,
		BaseURL:           cfg.Embeddings.BaseURL,
		ThresholdOverride: cfg.Embeddings.ThresholdOverride,
	}, logger)

	// The hosted model proxy. Booting without a credential is supported: the
	// endpoint answers 503 and the CLI's other providers are unaffected.
	models := inference.New(cfg.Inference.APIKey, cfg.Inference.BaseURL, logger)
	if !models.Available() {
		logger.Warn("OPENROUTER_API_KEY is not set; the hosted `makefaster` provider will answer 503",
			"models", models.Models())
	}

	// The private trace store. A directory that cannot be prepared is not a
	// reason to refuse to boot — the leaderboards are the product — so the
	// endpoint answers 503 and the reason is logged once, here.
	traces := openTraceVault(cfg, pool, logger)

	server := httpapi.NewServer(httpapi.Options{
		Store:       leaderboards,
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: cfg.FrontendDir,
		Logger:      logger,
		Inference:   models,
		Traces:      traces,
	})

	logger.Info("makefaster server listening",
		"addr", cfg.Addr(),
		"frontend", cfg.FrontendDir,
		"embedder", embedder.ID(),
		"threshold", threshold,
		"hostedModels", models.Models(),
		"hostedModelDefault", models.Model(),
		"hostedModelAvailable", models.Available())

	httpServer := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

// openTraceVault prepares the private chain-of-thought store, or returns nil
// when this deployment does not collect traces or cannot write where it was
// told to. Nil is what makes POST /api/submit-trace answer 503 with the fix.
func openTraceVault(cfg config.Config, pool *sql.DB, logger *slog.Logger) *trace.Vault {
	if !cfg.TracesEnabled() {
		logger.Info("chain-of-thought traces are off; POST /api/submit-trace will answer 503",
			"traceDir", cfg.TraceDir)
		return nil
	}
	vault, err := trace.NewVault(cfg.TraceDir, pool, logger)
	if err != nil {
		logger.Warn("could not prepare the trace directory; POST /api/submit-trace will answer 503",
			"traceDir", cfg.TraceDir, "error", err)
		return nil
	}
	logger.Info("chain-of-thought traces are stored privately and served by nothing",
		"traceDir", vault.Dir())
	return vault
}
