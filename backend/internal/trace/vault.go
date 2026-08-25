package trace

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Where a trace came from.
const (
	SourceCLI    = "cli"    // POST /api/submit-trace, on an explicit yes
	SourceImport = "import" // a backfill of already-packed runs (cmd/traces)
)

// Vault is the private store: one JSON document per run under a directory no
// HTTP route serves, plus a row in the `traces` index so the set can be
// queried without reading every file.
//
// The directory is created 0700 and the documents 0600. That is not decoration:
// the box also serves a public SPA out of FRONTEND_DIR, and the one thing that
// must never happen to a trace is being served.
type Vault struct {
	dir    string
	db     *sql.DB
	logger *slog.Logger
}

// Record is what a save produced: enough to acknowledge the submission without
// telling the client anything about the server's filesystem.
type Record struct {
	RunID          string
	Path           string
	Created        bool
	ThinkingBlocks int
	ThinkingChars  int
	Iterations     int
	Truncated      []string
}

// ErrTracesDisabled is returned by NewVault when no directory is configured.
// It is a supported state, not a misconfiguration: a deployment that does not
// want to collect traces sets no directory, and the endpoint answers 503.
var ErrTracesDisabled = errors.New("trace storage is not configured")

// NewVault prepares the directory. A db of nil stores documents without
// indexing them, which is what a box with no database still supports.
func NewVault(dir string, db *sql.DB, logger *slog.Logger) (*Vault, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, ErrTracesDisabled
	}
	if logger == nil {
		logger = slog.Default()
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve trace dir: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("create trace dir %s: %w", absolute, err)
	}
	return &Vault{dir: absolute, db: db, logger: logger}, nil
}

// Dir is the private root, for the log line that says where traces are going.
func (v *Vault) Dir() string { return v.dir }

// Save writes the document and indexes it.
//
// A run that submits twice replaces its own trace rather than adding a second
// copy to the training set: the document path is derived from the run id, and
// the index row is keyed on it. `replace` false makes a repeat a no-op instead,
// which is what a backfill that may be re-run needs.
func (v *Vault) Save(ctx context.Context, trace Trace, replace bool) (Record, error) {
	if trace.RunID == "" {
		trace.RunID = NewRunID()
	}
	if trace.Source == "" {
		trace.Source = SourceCLI
	}
	if trace.ReceivedAt == "" {
		trace.ReceivedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	relative := documentPath(trace)
	absolute := filepath.Join(v.dir, filepath.FromSlash(relative))
	record := Record{
		RunID:          trace.RunID,
		Path:           relative,
		ThinkingBlocks: len(trace.Thinking),
		ThinkingChars:  trace.ThinkingChars(),
		Iterations:     trace.IterationCount(),
		Truncated:      trace.Truncated,
	}

	existed := false
	if _, err := os.Stat(absolute); err == nil {
		existed = true
		if !replace {
			record.Created = false
			return record, nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return Record{}, fmt.Errorf("create trace dir: %w", err)
	}
	document, err := trace.Document()
	if err != nil {
		return Record{}, fmt.Errorf("encode trace: %w", err)
	}
	if err := writeFileAtomic(absolute, document); err != nil {
		return Record{}, err
	}

	created, err := v.index(ctx, trace, relative)
	if err != nil {
		return Record{}, err
	}
	record.Created = created && !existed
	return record, nil
}

// index upserts the catalog row. The document is already on disk at this
// point, so an index write is not allowed to lose it: the error is returned and
// the caller answers 500, and the next save for the same run rewrites both.
func (v *Vault) index(ctx context.Context, trace Trace, relative string) (bool, error) {
	if v.db == nil {
		return true, nil
	}
	result, err := v.db.ExecContext(ctx, `
		INSERT INTO traces (run_id, source, product, pr_url, agent, model, round,
			thinking_blocks, thinking_chars, iterations, has_results, has_diff,
			results_submitted, path, started_at, submitted_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			source = VALUES(source), product = VALUES(product), pr_url = VALUES(pr_url),
			agent = VALUES(agent), model = VALUES(model), round = VALUES(round),
			thinking_blocks = VALUES(thinking_blocks), thinking_chars = VALUES(thinking_chars),
			iterations = VALUES(iterations), has_results = VALUES(has_results),
			has_diff = VALUES(has_diff), results_submitted = VALUES(results_submitted),
			path = VALUES(path), started_at = VALUES(started_at),
			submitted_at = VALUES(submitted_at), created_at = VALUES(created_at)`,
		trace.RunID, trace.Source, trace.Product, trace.PRURL, trace.Agent, trace.Model, trace.Round,
		len(trace.Thinking), trace.ThinkingChars(), trace.IterationCount(),
		trace.Results != nil, trace.Diff != "", trace.ResultsSubmitted, relative,
		nullableTime(trace.StartedAt), nullableTime(trace.SubmittedAt), time.Now().UTC())
	if err != nil {
		return false, fmt.Errorf("index trace: %w", err)
	}
	// MySQL reports 1 for an insert and 2 for an update through this statement.
	affected, err := result.RowsAffected()
	if err != nil {
		return true, nil // the row is stored; the driver just would not say which way
	}
	return affected == 1, nil
}

// List is the internal catalog read: the index rows, newest first. It is not an
// endpoint and it is deliberately not the source of anything the CLI reads —
// the checklist comes from GET /data/improvements.json and nothing else. This
// exists for `makefaster-traces list`, run on the box by whoever is building a
// training set.
func (v *Vault) List(ctx context.Context, limit int) ([]IndexRow, error) {
	if v.db == nil {
		return nil, errors.New("no database is configured, so there is no trace index to list")
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := v.db.QueryContext(ctx, `
		SELECT run_id, source, product, agent, model, thinking_blocks, thinking_chars,
			iterations, results_submitted, path, created_at
		FROM traces ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list traces: %w", err)
	}
	defer rows.Close()

	out := []IndexRow{}
	for rows.Next() {
		var row IndexRow
		if err := rows.Scan(&row.RunID, &row.Source, &row.Product, &row.Agent, &row.Model,
			&row.ThinkingBlocks, &row.ThinkingChars, &row.Iterations, &row.ResultsSubmitted,
			&row.Path, &row.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan trace: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// IndexRow is one row of the private catalog.
type IndexRow struct {
	RunID            string
	Source           string
	Product          string
	Agent            string
	Model            string
	ThinkingBlocks   int
	ThinkingChars    int
	Iterations       int
	ResultsSubmitted bool
	Path             string
	CreatedAt        time.Time
}

// documentPath is `<yyyy-mm>/<run id>.json`: a month per directory so a year of
// collection is still listable, and the run id as the name so a resubmission
// lands on its own document instead of beside it.
func documentPath(trace Trace) string {
	stamp := trace.ReceivedAt
	month := time.Now().UTC().Format("2006-01")
	if parsed, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
		month = parsed.UTC().Format("2006-01")
	}
	return month + "/" + safeFileName(trace.RunID) + ".json"
}

var unsafeFileChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// safeFileName keeps a client-supplied run id from choosing where its document
// lands. Path separators, dots and everything else outside the allowlist are
// folded away, and an id that reduces to nothing gets a fresh one.
func safeFileName(runID string) string {
	cleaned := unsafeFileChars.ReplaceAllString(runID, "-")
	cleaned = strings.Trim(strings.ReplaceAll(cleaned, "..", "-"), ".-")
	if len(cleaned) > maxRunID {
		cleaned = cleaned[:maxRunID]
	}
	if cleaned == "" {
		return NewRunID()
	}
	return cleaned
}

// writeFileAtomic writes 0600 through a temporary file in the same directory,
// so a reader building a training set never sees a half-written document.
func writeFileAtomic(path string, contents []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".trace-*")
	if err != nil {
		return fmt.Errorf("create trace file: %w", err)
	}
	name := temp.Name()
	defer os.Remove(name)

	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("chmod trace file: %w", err)
	}
	if _, err := temp.Write(contents); err != nil {
		temp.Close()
		return fmt.Errorf("write trace file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close trace file: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("store trace file: %w", err)
	}
	return nil
}

// NewRunID names a trace whose submitter did not name it.
func NewRunID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("run-%d", time.Now().UTC().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func nullableTime(value string) any {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	return parsed.UTC()
}
