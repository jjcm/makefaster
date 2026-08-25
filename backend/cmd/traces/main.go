// Command traces manages the private chain-of-thought store from the box it
// lives on. It exists so a backfill of already-packed runs can be imported
// without going through the TUI, and so the stored set can be listed without an
// HTTP endpoint — there is deliberately no route that reads a trace back.
//
//	makefaster-traces import --dir /srv/backfill/2026-08
//	makefaster-traces import --tar /srv/backfill/runs.tar.gz
//	makefaster-traces list --limit 20
//
// A packed run is one directory holding:
//
//	meta.json      required — { runId?, product?, prUrl?, agent?, model?,
//	                            round?, startedAt?, submittedAt?,
//	                            resultsSubmitted? }
//	thinking.jsonl required — one {"text": "…"} per line, in order
//	results.json   optional — the run's results.json
//	diff.patch     optional — the unified patch, truncated to the size cap
//
// A --dir is a directory of those directories (or one of them). A --tar is a
// tar, gzipped when the name says so, of the same tree. Imports go through the
// same validation and the same caps as POST /api/submit-trace, so an imported
// trace and a submitted one are indistinguishable once stored — including the
// refusal to accept a tool transcript in place of thinking.
//
// Re-running an import is safe: a run already in the store is skipped unless
// --replace is given, so an interrupted backfill can simply be run again.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"

	"makefaster/internal/config"
	"makefaster/internal/db"
	"makefaster/internal/trace"
)

const usage = `makefaster-traces — the private chain-of-thought store, from the box it lives on

  makefaster-traces import --dir <path>   import every packed run under <path>
  makefaster-traces import --tar <file>   import packed runs from a tar/tar.gz
  makefaster-traces list [--limit N]      list what is stored, newest first

Flags:
  --dir <path>     a directory of packed runs, or one packed run
  --tar <file>     a tar or tar.gz of the same layout ("-" reads stdin)
  --replace        overwrite runs already in the store (default: skip them)
  --dry-run        validate and report without writing anything
  --limit N        how many rows to list (default 50)

A packed run is a directory holding meta.json and thinking.jsonl, optionally
results.json and diff.patch. Configuration comes from the environment, the same
way the server reads it: MAKEFASTER_TRACE_DIR and MARIADB_DSN.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	_ = godotenv.Load(".env")
	_ = godotenv.Load("../.env")

	var err error
	switch os.Args[1] {
	case "import":
		err = runImport(os.Args[2:], logger)
	case "list":
		err = runList(os.Args[2:], logger)
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func runImport(args []string, logger *slog.Logger) error {
	flags := flag.NewFlagSet("import", flag.ContinueOnError)
	dir := flags.String("dir", "", "a directory of packed runs, or one packed run")
	tarPath := flags.String("tar", "", `a tar or tar.gz of packed runs ("-" reads stdin)`)
	replace := flags.Bool("replace", false, "overwrite runs already in the store")
	dryRun := flags.Bool("dry-run", false, "validate and report without writing")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if (*dir == "") == (*tarPath == "") {
		return fmt.Errorf("pass exactly one of --dir or --tar")
	}

	traces, err := load(*dir, *tarPath)
	if err != nil {
		return err
	}
	if len(traces) == 0 {
		return fmt.Errorf("no packed runs found (expected directories holding %s and %s)", "meta.json", "thinking.jsonl")
	}

	if *dryRun {
		for _, candidate := range traces {
			fmt.Printf("would import %s — %d blocks, %d chars, %d iterations%s\n",
				candidate.RunID, len(candidate.Thinking), candidate.ThinkingChars(),
				candidate.IterationCount(), truncatedSuffix(candidate.Truncated))
		}
		fmt.Printf("%d run(s) validated, nothing written (--dry-run)\n", len(traces))
		return nil
	}

	vault, closeVault, err := openVault(logger)
	if err != nil {
		return err
	}
	defer closeVault()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	imported, skipped := 0, 0
	for _, candidate := range traces {
		record, err := vault.Save(ctx, candidate, *replace)
		if err != nil {
			return fmt.Errorf("import %s: %w", candidate.RunID, err)
		}
		if !record.Created && !*replace {
			skipped++
			fmt.Printf("skipped %s — already stored (pass --replace to overwrite)\n", record.RunID)
			continue
		}
		imported++
		fmt.Printf("imported %s — %d blocks, %d chars, %d iterations%s\n",
			record.RunID, record.ThinkingBlocks, record.ThinkingChars, record.Iterations,
			truncatedSuffix(record.Truncated))
	}
	fmt.Printf("%d imported, %d skipped, into %s\n", imported, skipped, vault.Dir())
	return nil
}

func runList(args []string, logger *slog.Logger) error {
	flags := flag.NewFlagSet("list", flag.ContinueOnError)
	limit := flags.Int("limit", 50, "how many rows to list")
	if err := flags.Parse(args); err != nil {
		return err
	}

	vault, closeVault, err := openVault(logger)
	if err != nil {
		return err
	}
	defer closeVault()

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	rows, err := vault.List(ctx, *limit)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		fmt.Printf("no traces stored under %s\n", vault.Dir())
		return nil
	}
	fmt.Printf("%-19s  %-7s  %-6s  %-6s  %-7s  %s\n", "STORED", "SOURCE", "BLOCKS", "CHARS", "ITERS", "RUN / PRODUCT")
	for _, row := range rows {
		fmt.Printf("%-19s  %-7s  %-6d  %-6d  %-7d  %s  %s\n",
			row.CreatedAt.UTC().Format("2006-01-02 15:04:05"), row.Source,
			row.ThinkingBlocks, row.ThinkingChars, row.Iterations, row.RunID, row.Product)
	}
	fmt.Printf("\n%d row(s). Documents are under %s and are served by no endpoint.\n", len(rows), vault.Dir())
	return nil
}

func load(dir, tarPath string) ([]trace.Trace, error) {
	if dir != "" {
		return trace.LoadDir(dir)
	}
	if tarPath == "-" {
		return trace.LoadTar(os.Stdin, false)
	}
	file, err := os.Open(tarPath)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", tarPath, err)
	}
	defer file.Close()
	gzipped := strings.HasSuffix(tarPath, ".gz") || strings.HasSuffix(tarPath, ".tgz")
	return trace.LoadTar(file, gzipped)
}

// openVault reads the same configuration the server does, so the tool cannot
// end up writing somewhere the server does not read.
func openVault(logger *slog.Logger) (*trace.Vault, func(), error) {
	cfg := config.Load()
	if !cfg.TracesEnabled() {
		return nil, nil, fmt.Errorf("MAKEFASTER_TRACE_DIR is off or unset, so there is nowhere to store traces")
	}
	pool, err := db.Open(cfg.MariaDSN)
	if err != nil {
		return nil, nil, fmt.Errorf("open mariadb: %w", err)
	}
	if err := db.Migrate(pool, cfg.MigrationsDir); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("migrate: %w", err)
	}
	vault, err := trace.NewVault(cfg.TraceDir, pool, logger)
	if err != nil {
		pool.Close()
		return nil, nil, err
	}
	return vault, func() { pool.Close() }, nil
}

func truncatedSuffix(notes []string) string {
	if len(notes) == 0 {
		return ""
	}
	return " (" + strings.Join(notes, "; ") + ")"
}
