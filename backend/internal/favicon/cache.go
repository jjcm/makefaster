// Package favicon serves the site leaderboard's icons from this origin instead
// of hotlinking them.
//
// A submitted (or derived) favicon URL points at somebody else's server, and
// plenty of them refuse the request once it comes from a page on another
// domain — hotlink protection, a CORS-flavoured 403, a redirect to an HTML
// error page. The board then showed a broken image where an icon belonged.
//
// So the server downloads the icon once, normalizes it to one size and one
// format (Size x Size PNG), stores the bytes in a writable data directory
// outside the repo, and serves that file under URLPrefix. The page only ever
// asks this origin for an image, which needs no CORS and cannot be hotlink
// blocked.
//
// Three properties the rest of the server leans on:
//
//   - Nothing blocks on a download. Prime is fire-and-forget, so
//     GET /data/sites.json answers at the speed of the database no matter how
//     slow an origin's CDN is, and the board's existing letter fallback covers
//     the gap until the file lands.
//   - A file's name carries a digest of the URL it came from, so a row that
//     starts pointing somewhere new gets a new path rather than a stale icon.
//   - A failure is not an error the page has to handle. Serve answers 404, the
//     row draws its letter, and the URL is left alone for a cooldown instead of
//     being retried on every render.
package favicon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// URLPrefix is where the served icons live. Same origin as the board, so an
// <img> needs no CORS headers and no referrer policy to load one.
const URLPrefix = "/favicons/"

const (
	// DefaultTTL is how long a stored icon is used before it is refreshed in
	// the background. Favicons change on the order of a rebrand, so this is
	// long; the stale file keeps being served while the refresh runs.
	DefaultTTL = 14 * 24 * time.Hour

	// A favicon that does not fit in a megabyte is not a favicon.
	maxDownloadBytes = 1 << 20

	fetchTimeout = 8 * time.Second

	// How long a URL that failed is left alone. Without it, a board render
	// re-downloads every broken icon on the page, every time.
	failureCooldown = 10 * time.Minute

	maxRedirects = 3

	// Background downloads run on a small budget so a first render of a large
	// board cannot open one connection per row. Priming is best-effort: over
	// budget, the icon waits for the next render or for the request the browser
	// makes for it.
	backgroundFetches = 4

	// A crude ceiling on the failure map, swept wholesale like the HTTP
	// rate limiter's buckets rather than entry by entry.
	maxFailureEntries = 10_000

	digestLength = 10

	userAgent = "makefaster-favicon/1.0 (+https://makefaster.dev)"
)

// ErrDisabled is returned by New when no directory is configured: a deployment
// that cannot (or does not want to) cache icons serves none, and the board
// falls back to letters.
var ErrDisabled = errors.New("favicon storage is not configured")

// ErrUnfetchableURL is a source URL this server will not request — a
// non-http(s) scheme, or nothing that parses as an absolute URL.
var ErrUnfetchableURL = errors.New("not a fetchable http(s) URL")

var errCoolingOff = errors.New("this favicon URL failed recently")

// A dotted hostname of sane DNS labels, matching what ingest normalizes a
// submitted site URL down to (leaderboard.NormalizeSiteURL). It is repeated
// here rather than imported because it is doing a different job: keeping a
// requested path from naming a file outside the cache directory.
var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

var digestPattern = regexp.MustCompile(`^[0-9a-f]+$`)

// Resolver answers "which favicon URL is this site's row pointing at right
// now?". It is the store lookup, injected so this package stays testable
// without a database.
//
// An empty string means the site has none, which is not an error.
type Resolver func(ctx context.Context, host string) (string, error)

type Options struct {
	// Dir is the writable directory the normalized icons are stored in.
	// Deliberately outside the repo and outside FRONTEND_DIR: a git pull must
	// not be able to delete the cache, and the static handler must not be able
	// to serve whatever else ends up in it.
	Dir string

	Resolver Resolver
	Logger   *slog.Logger

	// TTL overrides DefaultTTL. Mostly here so a test can make a stored file
	// stale without touching the clock.
	TTL time.Duration

	// AllowPrivateHosts lifts the private-address guard. Only a test serving
	// its own upstream on 127.0.0.1 should set it: in production the URL being
	// fetched is attacker-supplied, and a server that will fetch
	// http://10.0.0.1/ on request is an SSRF hole.
	AllowPrivateHosts bool

	// Client overrides the HTTP client used for downloads.
	Client *http.Client
}

// Cache is the store-and-serve half of the feature: a directory of normalized
// PNGs plus the bookkeeping that keeps one URL from being downloaded twice at
// once or retried on every render after it fails.
type Cache struct {
	dir     string
	ttl     time.Duration
	client  *http.Client
	resolve Resolver
	logger  *slog.Logger

	slots chan struct{}

	mu       sync.Mutex
	inflight map[string]*download
	failed   map[string]time.Time
}

// download is one in-flight fetch, so concurrent viewers of the same row share
// a single request instead of racing to write the same file.
type download struct {
	done chan struct{}
	data []byte
	err  error
}

// New prepares the cache directory.
//
// The directory is 0755 and the files 0644, unlike the trace vault's 0700/0600:
// these bytes are public by design — they are what the board shows — and the
// only thing that matters is that they live somewhere a deploy will not
// overwrite.
func New(opts Options) (*Cache, error) {
	if strings.TrimSpace(opts.Dir) == "" {
		return nil, ErrDisabled
	}
	absolute, err := filepath.Abs(opts.Dir)
	if err != nil {
		return nil, fmt.Errorf("resolve favicon dir: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		return nil, fmt.Errorf("create favicon dir %s: %w", absolute, err)
	}

	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	client := opts.Client
	if client == nil {
		client = newClient(opts.AllowPrivateHosts)
	}
	return &Cache{
		dir:      absolute,
		ttl:      ttl,
		client:   client,
		resolve:  opts.Resolver,
		logger:   logger,
		slots:    make(chan struct{}, backgroundFetches),
		inflight: map[string]*download{},
		failed:   map[string]time.Time{},
	}, nil
}

// Dir is the storage root, for the log line that says where icons are going.
func (c *Cache) Dir() string { return c.dir }

// Path is the same-origin URL for a site's icon, or "" when there is nothing
// to serve — no favicon URL, or one this server will not fetch. The board
// renders its letter fallback in that case rather than hotlinking.
func (c *Cache) Path(host, sourceURL string) string {
	name := fileName(host, sourceURL)
	if name == "" {
		return ""
	}
	return URLPrefix + name
}

// Prime starts a download when the stored file is missing or stale, and returns
// immediately either way. Nothing waits on the result: a slow origin must not
// be able to slow down the board.
func (c *Cache) Prime(host, sourceURL string) {
	name := fileName(host, sourceURL)
	if name == "" {
		return
	}
	if fresh, _ := c.stored(name); fresh {
		return
	}
	if c.coolingOff(name) {
		return
	}
	select {
	case c.slots <- struct{}{}:
	default:
		return
	}
	go func() {
		defer func() { <-c.slots }()
		ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
		defer cancel()
		if _, err := c.fetchOnce(ctx, name, sourceURL); err != nil && !errors.Is(err, errCoolingOff) {
			c.logger.Info("favicon not stored", "site", host, "source", sourceURL, "error", err)
		}
	}()
}

// ServeHTTP answers GET/HEAD URLPrefix<host>-<digest>.png.
//
// A hit is a file read. A miss downloads the icon inline — bounded by the fetch
// timeout, and shared with anyone else asking for the same one — because the
// browser asking for this image is exactly the moment the bytes are needed. A
// miss that cannot be filled is a 404, which the board already handles.
func (c *Cache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, ok := parseName(strings.TrimPrefix(r.URL.Path, URLPrefix))
	if !ok {
		c.writeMiss(w)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, URLPrefix)

	// The digest in the path has to match the URL the row carries now, or the
	// link is one a stale board render handed out.
	source := c.sourceFor(r.Context(), host)
	if source != "" && fileName(host, source) != name {
		source = ""
	}

	if data, modTime, err := c.read(name); err == nil {
		if source != "" && time.Since(modTime) > c.ttl {
			c.Prime(host, source)
		}
		c.writeImage(w, r, name, modTime, data)
		return
	}
	if source == "" {
		c.writeMiss(w)
		return
	}

	data, err := c.fetchOnce(r.Context(), name, source)
	if err != nil {
		c.writeMiss(w)
		return
	}
	c.writeImage(w, r, name, time.Now(), data)
}

func (c *Cache) sourceFor(ctx context.Context, host string) string {
	if c.resolve == nil {
		return ""
	}
	source, err := c.resolve(ctx, host)
	if err != nil {
		c.logger.Error("favicon lookup failed", "site", host, "error", err)
		return ""
	}
	return source
}

func (c *Cache) writeImage(w http.ResponseWriter, r *http.Request, name string, modTime time.Time, data []byte) {
	header := w.Header()
	header.Set("content-type", "image/png")
	// The path already changes when the row points at a different URL, so this
	// only has to be short enough to pick up a re-fetch of the same URL.
	header.Set("cache-control", "public, max-age=86400")
	header.Set("x-content-type-options", "nosniff")
	http.ServeContent(w, r, name, modTime, bytes.NewReader(data))
}

// writeMiss is the "there is no icon here" answer. It is cacheable for a
// minute so a board full of sites without a usable favicon does not re-ask on
// every render, and short enough that the first successful download shows up
// promptly.
func (c *Cache) writeMiss(w http.ResponseWriter) {
	header := w.Header()
	header.Set("content-type", "text/plain; charset=utf-8")
	header.Set("cache-control", "public, max-age=60")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, "no favicon\n")
}

// stored reports whether the file exists and whether it is still fresh.
func (c *Cache) stored(name string) (fresh bool, exists bool) {
	info, err := os.Stat(filepath.Join(c.dir, name))
	if err != nil || info.IsDir() {
		return false, false
	}
	return time.Since(info.ModTime()) <= c.ttl, true
}

func (c *Cache) read(name string) ([]byte, time.Time, error) {
	path := filepath.Join(c.dir, name)
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	if len(data) == 0 {
		return nil, time.Time{}, errors.New("stored favicon is empty")
	}
	return data, info.ModTime(), nil
}

func (c *Cache) coolingOff(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	until, failed := c.failed[name]
	return failed && time.Now().Before(until)
}

// fetchOnce downloads, normalizes and stores one icon, collapsing concurrent
// callers onto a single request and remembering a failure for a cooldown.
func (c *Cache) fetchOnce(ctx context.Context, name, source string) ([]byte, error) {
	c.mu.Lock()
	if until, failed := c.failed[name]; failed && time.Now().Before(until) {
		c.mu.Unlock()
		return nil, errCoolingOff
	}
	if existing, running := c.inflight[name]; running {
		c.mu.Unlock()
		select {
		case <-existing.done:
			return existing.data, existing.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	current := &download{done: make(chan struct{})}
	c.inflight[name] = current
	c.mu.Unlock()

	// The download outlives the request that started it. A viewer who navigates
	// away mid-fetch must not cancel the icon out from under the next one.
	fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
	defer cancel()

	current.data, current.err = c.storeIcon(fetchCtx, name, source)
	close(current.done)

	c.mu.Lock()
	delete(c.inflight, name)
	if current.err != nil {
		if len(c.failed) > maxFailureEntries {
			c.failed = map[string]time.Time{}
		}
		c.failed[name] = time.Now().Add(failureCooldown)
	} else {
		delete(c.failed, name)
	}
	c.mu.Unlock()

	return current.data, current.err
}

func (c *Cache) storeIcon(ctx context.Context, name, source string) ([]byte, error) {
	raw, err := c.fetch(ctx, source)
	if err != nil {
		return nil, err
	}
	normalized, err := Normalize(raw)
	if err != nil {
		return nil, fmt.Errorf("normalize %s: %w", source, err)
	}
	if err := c.write(name, normalized); err != nil {
		return nil, err
	}
	c.logger.Info("favicon stored", "file", name, "source", source,
		"sourceBytes", len(raw), "bytes", len(normalized))
	return normalized, nil
}

func (c *Cache) fetch(ctx context.Context, source string) ([]byte, error) {
	if !fetchable(source) {
		return nil, fmt.Errorf("%w: %q", ErrUnfetchableURL, source)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %q", ErrUnfetchableURL, source)
	}
	request.Header.Set("user-agent", userAgent)
	request.Header.Set("accept", "image/png,image/x-icon,image/*;q=0.8,*/*;q=0.5")

	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", source, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: upstream answered %d", source, response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", source, err)
	}
	if len(body) > maxDownloadBytes {
		return nil, fmt.Errorf("fetch %s: larger than %d bytes", source, maxDownloadBytes)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("fetch %s: upstream served an empty body", source)
	}
	return body, nil
}

// write replaces the file through a temporary in the same directory, so a
// request never reads a half-written PNG, and then drops the icons this site
// stored under an older source URL.
func (c *Cache) write(name string, data []byte) error {
	path := filepath.Join(c.dir, name)
	temp, err := os.CreateTemp(c.dir, ".favicon-*")
	if err != nil {
		return fmt.Errorf("create favicon file: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if err := temp.Chmod(0o644); err != nil {
		temp.Close()
		return fmt.Errorf("chmod favicon file: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write favicon file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close favicon file: %w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("store favicon file: %w", err)
	}
	c.pruneSuperseded(name)
	return nil
}

func (c *Cache) pruneSuperseded(name string) {
	host, ok := parseName(name)
	if !ok {
		return
	}
	matches, err := filepath.Glob(filepath.Join(c.dir, host+"-*.png"))
	if err != nil {
		return
	}
	for _, match := range matches {
		if filepath.Base(match) != name {
			_ = os.Remove(match)
		}
	}
}

// fileName is `<host>-<digest of the source URL>.png`. Putting the digest in
// the name is what makes a changed favicon URL a changed path: no metadata
// sidecar to keep in sync, and a board render that predates the change simply
// asks for a file that is no longer the current one.
func fileName(host, sourceURL string) string {
	cleaned := strings.ToLower(strings.TrimSpace(host))
	if len(cleaned) > 253 || !hostPattern.MatchString(cleaned) {
		return ""
	}
	if !fetchable(sourceURL) {
		return ""
	}
	return cleaned + "-" + digest(sourceURL) + ".png"
}

// parseName reads a requested file name back, and is the only thing standing
// between a request path and a filesystem path: a name that does not split
// into a valid hostname plus a hex digest is refused outright, so no request
// can name a file outside the cache directory.
func parseName(name string) (string, bool) {
	stem, isPNG := strings.CutSuffix(name, ".png")
	if !isPNG {
		return "", false
	}
	cut := strings.LastIndex(stem, "-")
	if cut <= 0 {
		return "", false
	}
	host, fingerprint := stem[:cut], stem[cut+1:]
	if len(fingerprint) != digestLength || !digestPattern.MatchString(fingerprint) {
		return "", false
	}
	if len(host) > 253 || !hostPattern.MatchString(host) {
		return "", false
	}
	return host, true
}

func digest(sourceURL string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(sourceURL)))
	return hex.EncodeToString(sum[:])[:digestLength]
}

// fetchable is the scheme allowlist. A stored value could be anything a
// submitter sent, and only an absolute http(s) URL is ever requested.
func fetchable(sourceURL string) bool {
	trimmed := strings.TrimSpace(sourceURL)
	if trimmed == "" || len(trimmed) > 2000 {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	return (scheme == "http" || scheme == "https") && parsed.Hostname() != ""
}

// newClient is the downloader.
//
// The URL comes from a public write endpoint, so the dialer refuses to connect
// to anything that is not a public address: without that check, POST
// /api/submit-site with `favicon: "http://169.254.169.254/…"` would make this
// server read the metadata service on the submitter's behalf. The check runs on
// the resolved address, which is what makes it survive a DNS name that points
// at 127.0.0.1 and a redirect chain that ends there.
func newClient(allowPrivateHosts bool) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	if !allowPrivateHosts {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("refusing to fetch from %q", address)
			}
			ip := net.ParseIP(host)
			if ip == nil || !publicIP(ip) {
				return fmt.Errorf("refusing to fetch a favicon from the non-public address %s", host)
			}
			return nil
		}
	}
	return &http.Client{
		Timeout: fetchTimeout,
		Transport: &http.Transport{
			DialContext:         dialer.DialContext,
			TLSHandshakeTimeout: 5 * time.Second,
			DisableKeepAlives:   true,
			MaxIdleConns:        4,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("stopped after %d redirects", maxRedirects)
			}
			if !fetchable(req.URL.String()) {
				return fmt.Errorf("%w: %q", ErrUnfetchableURL, req.URL.String())
			}
			return nil
		},
	}
}

// publicIP is the routable-internet test: everything private, local, or
// otherwise addressed at the machine's own network is out.
func publicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return false
	}
	// Carrier-grade NAT (100.64.0.0/10), which IsPrivate does not cover.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return false
	}
	return true
}
