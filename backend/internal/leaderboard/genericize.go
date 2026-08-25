package leaderboard

// Category names are the leaderboard's real identity: two submissions that
// agree on a name share a row, and a row's `count` is only meaningful if
// unrelated sites keep landing on it. A submitted name like "Lazy-load Hidden
// 262KB Changelog Rocket.gif" therefore does not describe a technique, it
// describes one repo — and left alone it becomes a permanent row of one.
//
// So every submitted name is reduced to a generic technique name before it is
// matched or created:
//
//  1. asides, measurements and identifiers are stripped from the name
//     (`sanitizeCategoryName`);
//  2. the name is checked against an ordered table of generic techniques
//     (`canonicalRules`), each keyed on technique vocabulary — "gzip",
//     "brotli", "etag", "font", "lazy-load" — never on a product name;
//  3. whatever survives is title-cased and left to the embedding matcher.
//
// The rules deliberately fold hard: the whole `lazy-load <one widget>` family
// collapses into five buckets, because "lazy-load the settings modal" and
// "lazy-load the chat side pane" are one technique, not two.
//
// The naming rule this enforces is documented for submitters in
// packages/skill/SKILL.md ("Naming an improvement").

import (
	"regexp"
	"sort"
	"strings"
)

var (
	// Parenthetical and bracketed text on this board is always a process
	// footnote — "(re-test after landscape change)", "(same as iteration 4)".
	asidePattern = regexp.MustCompile(`\s*[(\[][^)\]]*[)\]]`)

	// A measurement or a count, not a technique: "262KB", "1MB", "4", "35".
	measurementPattern = regexp.MustCompile(`(?i)^\d+(\.\d+)?(b|kb|kib|mb|mib|gb|gib|tb|k|m|ms|s|x|px|%)?$`)

	wordTokenPattern = regexp.MustCompile(`[a-z0-9]+`)
)

// keyFillers are dropped when building a fold key, so "Inline Shared
// Stylesheets" and "Inline the Shared Stylesheet" key the same.
var keyFillers = map[string]struct{}{}

func init() {
	for _, word := range []string{
		"a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of",
		"on", "or", "the", "then", "to", "via", "vs", "with",
	} {
		keyFillers[word] = struct{}{}
	}
}

// wordSpace reduces text to " word word word ", so a needle can be matched on
// word boundaries with strings.Contains and "highlight.js", "highlight-js" and
// "highlight js" all compare equal.
func wordSpace(text string) string {
	var out strings.Builder
	out.WriteByte(' ')
	pendingSpace := false
	for _, r := range strings.ToLower(text) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			if pendingSpace {
				out.WriteByte(' ')
				pendingSpace = false
			}
			out.WriteRune(r)
		default:
			pendingSpace = true
		}
	}
	out.WriteByte(' ')
	return out.String()
}

// hasWord reports whether haystack (already wordSpace'd) contains needle as
// whole words.
func hasWord(haystack, needle string) bool {
	return strings.Contains(haystack, wordSpace(needle))
}

func hasAlphanumeric(text string) bool {
	for _, r := range text {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return true
		}
	}
	return false
}

func hasAnyWord(haystack string, needles []string) bool {
	for _, needle := range needles {
		if hasWord(haystack, needle) {
			return true
		}
	}
	return false
}

// looksLikeIdentifier reports whether a token is a file, module, path or
// symbol rather than a word: "rocket.gif", "highlight.js/lib/common",
// "basic_examples", "es2015". Known acronyms are exempt so "HTTP/2", "WebP"
// and "AVIF" survive.
//
// CamelCase is deliberately NOT a signal here. "ChatControls" and
// "JavaScript" are the same shape, and stripping the second one to save the
// first would rewrite "Remove unused JavaScript" into "Remove Unused" —
// worse than the site-specific name it was trying to fix. Component names
// that survive this are caught by the rule table or the embedding matcher.
func looksLikeIdentifier(token string) bool {
	core := strings.Trim(token, `,;:"'“”‘’`)
	// A token with nothing to read is punctuation, not a symbol: the "/" in
	// "Gzip / Brotli Compression" has to survive.
	if !hasAlphanumeric(core) {
		return false
	}
	// A single trailing period is sentence punctuation, not a file extension.
	if strings.HasSuffix(core, ".") && strings.Count(core, ".") == 1 {
		core = strings.TrimSuffix(core, ".")
	}
	lower := strings.ToLower(core)
	if acronyms[lower] != "" {
		return false
	}
	// "HTTP/2" and "HTTP/3" normalize onto the "http2"/"http3" acronyms.
	if acronyms[strings.NewReplacer("/", "", ".", "", "-", "").Replace(lower)] != "" {
		return false
	}

	if strings.ContainsAny(core, "./\\_@") {
		return true
	}

	// Alphanumeric jumbles like "es2015" or "h264" are versions and codecs,
	// not techniques.
	var hasLetter, hasDigit bool
	for _, r := range core {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			hasLetter = true
		case r >= '0' && r <= '9':
			hasDigit = true
		}
	}
	return hasLetter && hasDigit
}

// sanitizeCategoryName strips the parts of a submitted name that describe one
// repo instead of one technique: asides, measurements, and identifiers.
func sanitizeCategoryName(raw string) string {
	stripped := asidePattern.ReplaceAllString(raw, " ")

	kept := make([]string, 0, 12)
	for _, token := range strings.Fields(stripped) {
		bare := strings.Trim(token, `,;:"'“”‘’`)
		if measurementPattern.MatchString(strings.TrimLeft(bare, "~<>=+")) {
			continue
		}
		if looksLikeIdentifier(token) {
			continue
		}
		kept = append(kept, token)
	}

	// A name reduced to filler ("the", "for") carries nothing; fall back to
	// the original rather than storing an empty category.
	trimmed := strings.TrimSpace(strings.Join(kept, " "))
	trimmed = strings.Trim(trimmed, " /&-–—")
	if categoryKey(trimmed) == "" {
		return strings.TrimSpace(raw)
	}
	return trimmed
}

// canonicalRule is one generic technique and the vocabulary that lands on it.
// Every group in require must match, none of exclude may match.
type canonicalRule struct {
	canonical string
	require   [][]string
	exclude   []string
}

// deferTriggers are the ways submitters say "this now loads later".
var deferTriggers = []string{
	"lazy load", "lazyload", "lazily load", "lazily loaded", "lazily",
	"lazy", "defer", "defers", "deferred", "deferring", "dynamic import",
	"dynamically import", "dynamically imported", "on demand", "on-demand",
	"code split", "code splitting", "async load", "load later",
}

// The lazy-load buckets, checked in this order. The last one is the default:
// anything deferred that is not an image, a tracker, a vendor SDK or a data
// fetch is a component.
var deferBuckets = []canonicalRule{
	{canonical: "Lazy-Load Unseen Images", require: [][]string{{
		"image", "images", "img", "gif", "gifs", "png", "jpg", "jpeg", "webp",
		"avif", "thumbnail", "thumbnails", "thumb", "photo", "photos",
		"picture", "pictures", "banner", "avatar", "poster", "artwork",
	}}},
	{canonical: "Defer Analytics Loading", require: [][]string{{
		"analytics", "telemetry", "tracking", "tracker", "trackers", "beacon",
		"beacons", "gtag", "gtm", "google tag", "tag manager", "pixel", "rum",
	}}},
	{canonical: "Lazy-Load Third-Party SDKs", require: [][]string{{
		"sdk", "sdks", "third party", "thirdparty", "vendor", "vendors",
		"widget", "widgets", "embed", "embeds", "iframe", "iframes", "captcha",
		"recaptcha", "social",
	}}},
	{canonical: "Defer Unused Data Fetches", require: [][]string{{
		"fetch", "fetches", "request", "requests", "query", "queries",
		"endpoint", "endpoints", "graphql", "xhr", "prefetch", "data",
	}}},
	{canonical: "Lazy-Load Components"},
}

// canonicalRules is the ordered generic-technique table. Order matters:
// "Prefer Brotli Over Gzip" is brotli, and "Gzip Precompress Static Assets"
// is precompression.
var canonicalRules = []canonicalRule{
	{canonical: "Precompress Static Assets", require: [][]string{{
		"precompress", "precompressed", "precompression", "pre compress",
		"pre compressed", "gz sibling", "gz siblings", "br sibling",
		"br siblings", "static compression",
	}}},
	{canonical: "Enable Brotli Compression", require: [][]string{{"brotli", "br compression"}}},
	{canonical: "Enable Gzip Compression", require: [][]string{{
		"gzip", "gzipped", "gzipping", "text compression", "response compression",
		"zlib", "deflate",
	}}},
	{canonical: "ETag Conditional Responses", require: [][]string{{
		"etag", "etags", "if none match", "conditional request",
		"conditional requests", "conditional response", "conditional responses",
	}}},
	{canonical: "Subset Syntax-Highlighter Bundle", require: [][]string{{
		"highlight js", "hljs", "highlighter", "prism js", "prismjs", "shiki",
		"syntax highlight", "syntax highlighting",
	}}},
	{canonical: "Self-Host Critical Fonts", require: [][]string{
		{"font", "fonts", "typeface", "typefaces", "webfont", "webfonts"},
		{"self host", "self hosted", "selfhost", "first party", "local copy"},
	}},
	{canonical: "Reduce Font Payload", require: [][]string{
		{"font", "fonts", "typeface", "typefaces", "webfont", "webfonts"},
		{
			"payload", "weight", "weights", "preload", "preloaded", "trim",
			"trimmed", "reduce", "reduced", "fewer", "drop", "dropped", "cut",
			"subset", "subsetting", "family", "families", "style", "styles",
			"variant", "variants",
		},
	}},
	{canonical: "Optimize Hydration Strategy", require: [][]string{{
		"hydrate", "hydrated", "hydration", "hydrating", "island", "islands",
	}}},
	{canonical: "Content-Hashed Immutable Assets", require: [][]string{
		{
			"immutable", "immutably", "content hash", "content hashed",
			"fingerprint", "fingerprinted", "versioned", "cache bust",
			"cache busted", "cache busting",
		},
		{"asset", "assets", "cache", "cached", "caching", "url", "urls", "shell", "bundle", "bundles"},
	}},
	{canonical: "Remove Duplicate CSS Bundles", require: [][]string{
		{"duplicate", "duplicated", "deduplicate", "dedupe", "identical", "near identical"},
		{"css", "stylesheet", "stylesheets", "bundle", "bundles"},
	}},
	{canonical: "Skip Redundant Fetches", require: [][]string{
		{"duplicate", "duplicated", "deduplicate", "dedupe", "redundant", "refetch", "refetched", "twice", "double"},
		{"fetch", "fetches", "request", "requests", "query", "queries", "call", "calls", "payload"},
	}},
	{canonical: "Compress SVG Assets", require: [][]string{
		{"svg", "svgs"},
		{"minify", "minified", "compress", "compressed", "optimize", "optimise", "optimized", "path", "paths", "precision"},
	}},
	{canonical: "Inline Critical HTML Shell", require: [][]string{{
		"boot shell", "html shell", "static shell", "shell html", "prerender",
		"prerendered", "static copy",
	}}},
	{canonical: "Cut Critical-Path JavaScript", require: [][]string{
		{"entry bundle", "boot bundle", "main bundle", "initial bundle", "critical path", "boot path", "non boot", "critical bundle"},
		{"js", "javascript", "script", "scripts", "bundle", "chunk", "chunks", "module", "modules", "evict", "trim", "cut", "split", "remove", "library", "libraries"},
	}},
}

// canonicalNameFor returns the generic technique name for a submitted name, or
// false when no rule applies and the name should just be sanitized.
func canonicalNameFor(name string) (string, bool) {
	haystack := wordSpace(name)

	for _, rule := range canonicalRules {
		if rule.matches(haystack) {
			return rule.canonical, true
		}
	}

	// The lazy-load family: one trigger, then the smallest bucket that fits.
	if hasAnyWord(haystack, deferTriggers) {
		for _, bucket := range deferBuckets {
			if bucket.matches(haystack) {
				return bucket.canonical, true
			}
		}
	}

	// "Inline the shared stylesheet" vs. "inline critical CSS": the same
	// technique split by how much of the stylesheet moves inline.
	if hasAnyWord(haystack, []string{"inline", "inlined", "inlining"}) &&
		hasAnyWord(haystack, []string{"css", "stylesheet", "stylesheets", "style sheet", "style sheets"}) {
		if hasAnyWord(haystack, []string{"critical", "above the fold", "above fold"}) {
			return "Inline Critical CSS", true
		}
		return "Inline Shared Stylesheets", true
	}

	return "", false
}

func (r canonicalRule) matches(haystack string) bool {
	for _, excluded := range r.exclude {
		if hasWord(haystack, excluded) {
			return false
		}
	}
	for _, group := range r.require {
		if !hasAnyWord(haystack, group) {
			return false
		}
	}
	return true
}

// GenericCategoryName is the name the leaderboard stores for a submitted
// improvement: a generic technique, title-cased.
func GenericCategoryName(name string) string {
	if canonical, ok := canonicalNameFor(name); ok {
		return TitleCaseCategoryName(canonical)
	}
	return SanitizedCategoryName(name)
}

// SanitizedCategoryName is the submitted name with the repo-specific parts
// removed but no rule applied — what the submitter meant, cleaned up. A
// submitter who already used a good generic name ("Gzip / Brotli Compression")
// must land on that row rather than be rewritten by a rule, so Categorize
// tries this name against the board before the canonical one.
func SanitizedCategoryName(name string) string {
	return TitleCaseCategoryName(sanitizeCategoryName(name))
}

// categoryKey is the fold key for a category name: its significant word stems,
// deduplicated and sorted. Two names with the same key are the same technique
// worded differently ("Inline Shared Stylesheets" / "Inline the shared
// stylesheet"), so they share a row without consulting the embedder.
func categoryKey(name string) string {
	tokens := wordTokenPattern.FindAllString(strings.ToLower(name), -1)
	seen := make(map[string]struct{}, len(tokens))
	stems := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if len(token) < 2 {
			continue
		}
		if _, filler := keyFillers[token]; filler {
			continue
		}
		stem := keyStem(token)
		if _, duplicate := seen[stem]; duplicate {
			continue
		}
		seen[stem] = struct{}{}
		stems = append(stems, stem)
	}
	sort.Strings(stems)
	return strings.Join(stems, " ")
}

// keyStem folds the plural so "component" and "components" key the same. It is
// deliberately weaker than the embedder's stemmer: the key decides an exact
// fold, so it must not collapse words that mean different things.
func keyStem(token string) string {
	switch {
	case len(token) > 4 && strings.HasSuffix(token, "ies"):
		return token[:len(token)-3] + "y"
	case len(token) > 4 && strings.HasSuffix(token, "es") && !strings.HasSuffix(token, "ses"):
		return token[:len(token)-2]
	case len(token) > 3 && strings.HasSuffix(token, "s") && !strings.HasSuffix(token, "ss"):
		return token[:len(token)-1]
	}
	return token
}
