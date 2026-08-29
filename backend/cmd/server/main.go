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
	"path/filepath"
	"time"

	"github.com/joho/godotenv"

	"makefaster/internal/config"
	"makefaster/internal/db"
	"makefaster/internal/embedding"
	"makefaster/internal/favicon"
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

	// The hosted model proxy. Booting without a credential is the expected
	// state now that no client in this repo calls it: the endpoint answers 503
	// and nothing else on the box is affected.
	models := inference.New(cfg.Inference.APIKey, cfg.Inference.BaseURL, logger)
	if !models.Available() {
		logger.Warn("OPENROUTER_API_KEY is not set; the model proxy will answer 503",
			"models", models.Models())
	}

	// The private trace store. A directory that cannot be prepared is not a
	// reason to refuse to boot — the leaderboards are the product — so the
	// endpoint answers 503 and the reason is logged once, here.
	traces := openTraceVault(cfg, pool, logger)

	// The board's icons, downloaded from each site's own origin and served from
	// here. Also not a reason to refuse to boot: without it the board shows
	// each site's initial, which is what it already does for a row with no
	// favicon at all.
	favicons := openFaviconCache(cfg, leaderboards, logger)

	server := httpapi.NewServer(httpapi.Options{
		Store:       leaderboards,
		Embedder:    embedder,
		Threshold:   threshold,
		FrontendDir: cfg.FrontendDir,
		Logger:      logger,
		Inference:   models,
		Traces:      traces,
		Favicons:    favicons,
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

// openFaviconCache prepares the directory the site leaderboard's icons are
// downloaded into, or returns nil when this deployment serves none.
//
// The configured directory is deliberately outside the repo, which on a
// developer's machine usually means somewhere unwritable. Rather than dropping
// the icons from every local board, an unwritable directory falls back to a
// cache under the system temporary directory: these files are derived from
// public URLs and are re-downloadable, so losing them on reboot costs nothing.
// A deployment that wants them to survive one sets MAKEFASTER_FAVICON_DIR.
func openFaviconCache(cfg config.Config, leaderboards *store.Store, logger *slog.Logger) *favicon.Cache {
	if !cfg.FaviconsEnabled() {
		logger.Info("site favicons are off; the board will show each site's initial",
			"faviconDir", cfg.FaviconDir)
		return nil
	}
	options := favicon.Options{
		Dir:      cfg.FaviconDir,
		Resolver: leaderboards.SiteFavicon,
		Logger:   logger,
	}
	cache, err := favicon.New(options)
	if err != nil {
		fallback := filepath.Join(os.TempDir(), "makefaster-favicons")
		logger.Warn("could not prepare the favicon directory; using a temporary one",
			"faviconDir", cfg.FaviconDir, "fallback", fallback, "error", err)
		options.Dir = fallback
		if cache, err = favicon.New(options); err != nil {
			logger.Warn("could not prepare a favicon directory; the board will show each site's initial",
				"faviconDir", fallback, "error", err)
			return nil
		}
	}
	logger.Info("site favicons are downloaded from each origin once and served from this one",
		"faviconDir", cache.Dir(), "route", favicon.URLPrefix, "size", favicon.Size)
	return cache
}
