// Command server is the Makefaster leaderboard server: it migrates MariaDB,
// seeds the boards on a fresh database, then serves the SPA and the write APIs
// from a single process.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"

	"makefaster/internal/config"
	"makefaster/internal/db"
	"makefaster/internal/embedding"
	httpapi "makefaster/internal/http"
	"makefaster/internal/store"
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

	server := httpapi.NewServer(httpapi.Options{
		Store:       leaderboards,
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: cfg.FrontendDir,
		Logger:      logger,
	})

	logger.Info("makefaster server listening",
		"addr", cfg.Addr(),
		"frontend", cfg.FrontendDir,
		"embedder", embedder.ID(),
		"threshold", threshold)

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
