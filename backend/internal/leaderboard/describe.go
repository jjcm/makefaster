package leaderboard

// A category's description is the line the improvement leaderboard prints under
// the technique name, so it has to answer "what would I do on my site?" —
// exactly like the name, and for the same reason. Names were fixed first (see
// genericize.go); the descriptions they were created with stayed changelogs:
//
//	Reduce Font Payload
//	  Playfair Display cut from 4 weights x 2 styles to the single 400-italic
//	  actually used; disabled preload for Playfair, Geist Mono and Noto Sans…
//
// That sentence is true of one repo on one day. The next site reading the board
// learns nothing it can act on, and the row's `count` — the whole point of the
// board — is advertising a technique the row does not describe.
//
// So a submitted description is treated as evidence, not as copy. Two things
// happen to it:
//
//  1. siteSpecificMarkers reads it for the things that can only mean one repo:
//     module and file names, route paths, CSS declarations, byte sizes and
//     other measurements-as-anecdotes, known product nouns, and the past-tense
//     changelog voice ("Added…", "…was fetched…") that always comes with them;
//  2. anything marked is replaced — by the catalog blurb for the technique when
//     the board knows one (genericDescriptions, keyed by the same generic name
//     the ingest already decided), otherwise by the submission with the
//     site-specific tokens stripped, otherwise by a placeholder.
//
// Detection is deliberately conservative in one direction only: a marker means
// "definitely one repo", never "probably". Prose that is quietly about one site
// but names nothing ("the boot screen lockup animated from opacity 0") can slip
// through, which is why the rule is documented for submitters in
// packages/skill/SKILL.md ("Naming and describing an improvement") too. This is
// a backstop, not a copywriter.

import (
	"regexp"
	"strings"
)

// communityDescriptionPrefix marks a category created from a submission that
// carried no usable description. It is a placeholder, not a technique blurb, so
// a later submission is allowed to replace it.
const communityDescriptionPrefix = "Community-submitted: "

var (
	// A measurement from one run: "262KB", "1.64 MB", "~170KB-gzip", "512x512".
	// Bare numbers are fine — "honor If-None-Match with 304" is a technique, and
	// "Early Hints (103)" is a spec.
	byteMeasurementPattern = regexp.MustCompile(`(?i)\d+(\.\d+)?\s*(b|kb|kib|mb|mib|gb|gib|tb)\b`)
	timeMeasurementPattern = regexp.MustCompile(`(?i)\d+(\.\d+)?\s*(ms|sec|secs|second|seconds|fps)\b`)
	unitMeasurementPattern = regexp.MustCompile(`(?i)\d+(\.\d+)?(px|%)\b`)
	dimensionsPattern      = regexp.MustCompile(`(?i)\d+\s*[x×]\s*\d+`)

	// "~35 languages", "~18 chunks": an approximate count of things in one repo.
	approximateCountPattern = regexp.MustCompile(`~\s*\d`)

	// "28.8KB->11KB", "46.7KB → 41.1KB": a before/after pair belongs in the
	// deltas, not in the description of the technique.
	beforeAfterPattern = regexp.MustCompile(`->|=>|→`)
)

// descriptionVocabulary is the spelling allowlist: terms that may appear in a
// technique description even though they are capitalized oddly ("ETag"),
// contain a slash ("HTTP/1.1"), or would otherwise read as a product name.
// Everything here names a protocol, a format, a spec or a browser API — things
// every site has — never a library or a service.
var descriptionVocabulary = map[string]struct{}{}

func init() {
	for spelling := range acronyms {
		descriptionVocabulary[spelling] = struct{}{}
	}
	for _, term := range []string{
		// Protocols and transport.
		"http/1", "http/1.1", "http/2", "http/3", "https", "dns", "tcp", "tls",
		"ssl", "rtt", "websocket", "websockets", "webtransport", "grpc",
		// HTTP header and cache vocabulary.
		"etag", "cache-control", "if-none-match", "if-modified-since",
		"last-modified", "accept-encoding", "content-encoding", "content-type",
		"content-length", "no-cache", "no-store", "stale-while-revalidate",
		"max-age", "vary",
		// Formats, codecs and the extensions they are served under.
		"gzip", "brotli", "zstd", "deflate", "gif", "png", "jpeg", "jpg",
		"woff", "woff2", "ttf", "otf", "utf-8", "base64", "gz", "br", "zst",
		// Browser and platform APIs.
		"javascript", "typescript", "webassembly", "wasm", "indexeddb",
		"localstorage", "requestidlecallback", "intersectionobserver",
		"performanceobserver", "serviceworker", "webworker", "xhr", "sdk",
		"sdks", "cpu", "gpu", "ram",
		// Metrics and tooling every site can name.
		"lighthouse", "webpagetest", "devtools", "rum", "crux",
	} {
		descriptionVocabulary[term] = struct{}{}
	}
}

// siteSpecificNouns are the product, library and service names that keep
// showing up in submitted descriptions. A technique blurb never needs one: the
// next site runs different software and still wants the technique. Listed
// lowercase and matched on word boundaries, so "highlight.js", "highlight-js"
// and "highlight js" are all caught.
var siteSpecificNouns = []string{
	// Bundlers and frameworks.
	"vite", "rollup", "rolldown", "webpack", "esbuild", "parcel", "turbopack",
	"astro", "svelte", "sveltekit", "react", "preact", "vue", "nuxt",
	"angular", "ember", "jquery", "next.js", "gatsby", "remix", "solidjs",
	"tailwind", "bootstrap",
	// Server frameworks and runtimes.
	"aiohttp", "fastapi", "django", "flask", "rails", "laravel", "uvicorn",
	"gunicorn", "socket.io", "sockjs",
	// Libraries that have shown up on the board by name.
	"mermaid", "excalidraw", "elkjs", "pyodide", "xterm", "ag-grid",
	"react-ace", "ace-builds", "monaco", "codemirror", "emoji-mart",
	"moment.js", "moment-timezone", "lodash", "three.js", "chart.js",
	"plotly", "echarts", "katex", "mathjax", "pdf.js", "video.js", "hls.js",
	"jsonata", "svgo", "highlight.js", "hljs", "prismjs", "prism.js", "shiki",
	// Fonts.
	"playfair", "excalifont", "geist", "noto",
	// Vendors and SaaS.
	"firebase", "supabase", "cloudinary", "imgix", "mapbox", "leaflet",
	"recaptcha", "intercom", "zendesk", "amplitude", "mixpanel", "posthog",
	"hotjar", "sentry", "datadog", "growthbook", "launchdarkly", "optimizely",
	"cloudflare", "vercel", "netlify", "fastly", "akamai",
}

// changelogVoice are the words that turn a technique into a report about one
// repo: past-tense narration ("was fetched", "used the default order") and the
// verbs a commit message opens with. A description written for the next site is
// in the imperative present — "Compress text responses", "Serve content-hashed
// static files" — so none of these belong in one.
var changelogVoice = []string{
	"was", "were", "used", "had",
	"added", "removed", "switched", "inlined", "enabled", "disabled",
	"deleted", "generated", "imported", "migrated", "grouped", "hoisted",
	"eliminated", "refetched", "emitted", "shipped", "fetched", "replaced",
	"reverted",
}

// processFootnotes are the loop's own bookkeeping leaking into the catalog.
var processFootnotes = []string{
	"re test", "retest", "retested", "same change as", "same as iteration",
	"see iteration", "second attempt", "third attempt", "as noted above",
}

// pastTenseExceptions are words that end in "ed" without being past tense, so
// a description may still open with one. "Embed the boot payload" is a
// technique on this very board.
var pastTenseExceptions = map[string]struct{}{
	"embed": {}, "need": {}, "speed": {}, "feed": {}, "seed": {},
	"exceed": {}, "proceed": {}, "succeed": {}, "indeed": {}, "spread": {},
	"ahead": {}, "instead": {}, "shed": {}, "shred": {},
}

// SiteSpecificMarkers lists the reasons a description reads as one repo's
// changelog rather than as a technique. An empty result means the text is
// usable on the board as-is; the markers themselves exist so a test failure or
// a rejected description can say which word gave it away.
func SiteSpecificMarkers(description string) []string {
	text := strings.TrimSpace(description)
	if text == "" {
		return []string{"empty"}
	}
	if strings.HasPrefix(text, communityDescriptionPrefix) {
		return []string{"placeholder"}
	}

	markers := make([]string, 0, 4)
	seen := make(map[string]struct{}, 4)
	add := func(marker string) {
		if _, duplicate := seen[marker]; duplicate {
			return
		}
		seen[marker] = struct{}{}
		markers = append(markers, marker)
	}

	haystack := wordSpace(text)
	for _, noun := range siteSpecificNouns {
		if hasWord(haystack, noun) {
			add(noun)
		}
	}
	for _, verb := range changelogVoice {
		if hasWord(haystack, verb) {
			add(verb)
		}
	}
	for _, footnote := range processFootnotes {
		if hasWord(haystack, footnote) {
			add(footnote)
		}
	}
	for _, pattern := range []*regexp.Regexp{
		byteMeasurementPattern, timeMeasurementPattern, unitMeasurementPattern,
		dimensionsPattern, approximateCountPattern, beforeAfterPattern,
	} {
		if match := pattern.FindString(text); match != "" {
			add(strings.TrimSpace(match))
		}
	}

	sentenceStart := true
	for _, token := range strings.Fields(text) {
		if sentenceStart && opensInPastTense(token) {
			add(strings.ToLower(trimDescriptionToken(token)))
		}
		sentenceStart = endsSentence(token)

		if marker := descriptionTokenMarker(token); marker != "" {
			add(marker)
		}
	}
	return markers
}

// IsGenericDescription reports whether a description is a technique the next
// site could act on, rather than a report about one repo.
func IsGenericDescription(description string) bool {
	return len(SiteSpecificMarkers(description)) == 0
}

// endsSentence reports whether the next token starts a new sentence.
func endsSentence(token string) bool {
	trimmed := strings.TrimRight(token, `)]"'“”‘’`)
	return strings.HasSuffix(trimmed, ".") || strings.HasSuffix(trimmed, "!") ||
		strings.HasSuffix(trimmed, "?") || strings.HasSuffix(trimmed, ";")
}

// opensInPastTense reports whether a sentence opens on a past-tense verb, which
// is the giveaway that what follows is a commit message: "Added mtime-versioned
// CSS…", "Generated .gz siblings…", "Served a style override…".
func opensInPastTense(token string) bool {
	word := strings.ToLower(trimDescriptionToken(token))
	// A compound opener is read on its last part: "Dynamic-imported elkjs".
	if parts := strings.Split(word, "-"); len(parts) > 1 {
		word = parts[len(parts)-1]
	}
	if _, exempt := pastTenseExceptions[word]; exempt {
		return false
	}
	return len(word) > 4 && strings.HasSuffix(word, "ed")
}

// trimDescriptionToken strips the punctuation a word wears inside a sentence,
// leaving the word itself. A leading "." or "/" is deliberately kept by the
// caller that cares about it (".gz", "/api/v1/all" are the marker, not noise).
func trimDescriptionToken(token string) string {
	return strings.Trim(token, `,;:.!?()[]{}"'“”‘’—–`)
}

// descriptionTokenMarker returns the reason one word can only mean one repo, or
// "" when the word is fine. The tests in describe_test.go are the readable
// version of this list.
func descriptionTokenMarker(token string) string {
	core := trimDescriptionToken(token)
	if !hasAlphanumeric(core) {
		return ""
	}
	if _, allowed := descriptionVocabulary[canonicalSpelling(core)]; allowed {
		return ""
	}

	// A CSS class, a route path, or a file that is not just an extension the
	// vocabulary above knows — all of which open on punctuation a sentence never
	// does: ".sidebar-open", "/api/v1/all", "./src/boot".
	if strings.HasPrefix(token, ".") || strings.HasPrefix(token, "/") {
		return token
	}

	// A config or CSS declaration: "client:load", "display:none",
	// "build.cssCodeSplit:false".
	if strings.Contains(core, ":") {
		return core
	}
	// A symbol, not a word: "compress_body", "@scope/pkg", "src\app".
	if strings.ContainsAny(core, `_@\`) {
		return core
	}
	// A path or a dotted module. Each slash-separated part is read on its own so
	// "gzip/brotli", "DNS/TLS" and "JSON/API" survive as the word pairs they are.
	for _, part := range strings.Split(core, "/") {
		if part == "" {
			continue
		}
		if _, allowed := descriptionVocabulary[canonicalSpelling(part)]; allowed {
			continue
		}
		if strings.Contains(strings.Trim(part, "."), ".") || looksLikeVersionOrCodec(part) {
			return core
		}
	}
	// A spelling only a source tree uses: "manualChunks", "AppInitPage",
	// "FileResponse". Read per word so "HTML+CSS" and "WebSocket-first" are
	// judged on "HTML", "CSS", "WebSocket" and "first".
	for _, word := range splitAlphabeticRuns(core) {
		if !looksLikeProductSpelling(word) {
			continue
		}
		if _, allowed := descriptionVocabulary[canonicalSpelling(word)]; !allowed {
			return core
		}
	}
	return ""
}

// looksLikeProductSpelling reports whether a word is capitalized the way a
// library, component or symbol is — an interior capital in a word that is not
// simply an acronym. An acronym nobody has catalogued yet ("POPs", "TTL") is
// still generic vocabulary, so only mixed case counts: "ETag", "WebSocket",
// "manualChunks", "AppInitPage".
func looksLikeProductSpelling(word string) bool {
	if len([]rune(word)) < 2 || !hasUpperAfterFirst(word) {
		return false
	}
	return strings.ToUpper(strings.TrimSuffix(word, "s")) != strings.TrimSuffix(word, "s")
}

// canonicalSpelling is the key a word is looked up under in the vocabulary:
// lowercase, and singular when the plural is just an "s" ("SVGs" -> "svg",
// "ETags" -> "etag").
func canonicalSpelling(word string) string {
	lower := strings.ToLower(word)
	if _, exact := descriptionVocabulary[lower]; exact {
		return lower
	}
	if singular := strings.TrimSuffix(lower, "s"); singular != lower {
		if _, plural := descriptionVocabulary[singular]; plural {
			return singular
		}
	}
	return lower
}

// looksLikeVersionOrCodec reports the letter-and-digit jumbles that are always
// an identifier rather than a word: "es2015", "h264", "400-italic", "utf8mb4".
func looksLikeVersionOrCodec(part string) bool {
	var hasLetter, hasDigit bool
	for _, r := range part {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			hasLetter = true
		case r >= '0' && r <= '9':
			hasDigit = true
		}
	}
	return hasLetter && hasDigit
}

// splitAlphabeticRuns cuts a token into its letter runs, so a compound is
// judged word by word: "WebSocket-first" -> ["WebSocket", "first"].
func splitAlphabeticRuns(token string) []string {
	runs := make([]string, 0, 3)
	var current strings.Builder
	for _, r := range token {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			current.WriteRune(r)
			continue
		}
		if current.Len() > 0 {
			runs = append(runs, current.String())
			current.Reset()
		}
	}
	if current.Len() > 0 {
		runs = append(runs, current.String())
	}
	return runs
}

// genericDescriptions is the catalog blurb for every technique the ingest can
// name (the canonical names in genericize.go). Keyed by the fold key of the
// name, so the wording of the name does not have to match exactly.
//
// Each one is written the way the board wants to read: present tense, about any
// site, no product it was first measured on. These are the same sentences
// migration 00004 backfills onto the rows that predate this rule.
var genericDescriptions = map[string]string{}

func init() {
	for name, description := range map[string]string{
		"Lazy-Load Components":             "Import optional UI (editors, diagrams, modals, viewers) only from the surfaces that need them so they stay off the first-load bundle.",
		"Lazy-Load Unseen Images":          "Do not eagerly download images that are hidden, below the fold, or unused on the current viewport.",
		"Lazy-Load Third-Party SDKs":       "Load vendor SDKs, embeds and widgets on the interaction that needs them instead of during boot.",
		"Defer Analytics Loading":          "Load analytics, telemetry and tag managers after the page is interactive, never on the critical path.",
		"Defer Unused Data Fetches":        "Move requests the first paint never reads off the boot path and issue them when the data is actually needed.",
		"Precompress Static Assets":        "Serve compressed text: pre-generate gzip/brotli siblings for static assets, and compress responses at runtime when prebuilt siblings are not an option.",
		"Minify JavaScript":                "Serve minified JS bundles and vendored scripts so the same code costs fewer bytes on the critical path.",
		"Remove Unused CSS":                "Strip stylesheet rules and style payloads nothing on the page uses so render-blocking CSS costs fewer bytes.",
		"Content-Hashed Immutable Assets":  "Serve content-hashed static files with long-lived immutable cache headers so repeat visits skip the transfer.",
		"ETag Conditional Responses":       "Send ETags on large JSON/API payloads and honor If-None-Match with 304 so warm loads skip the body.",
		"Reduce Font Payload":              "Ship only the font files, weights, and subsets the entry page actually paints, and drop preloads for fonts it never uses.",
		"Self-Host Critical Fonts":         "Host LCP fonts on the same origin so the heading does not wait on extra DNS/TLS to a font CDN.",
		"Cut Critical-Path JavaScript":     "Move non-boot code (editors, layout engines, unused languages) off the entry bundle so less JS runs before LCP.",
		"Subset Syntax-Highlighter Bundle": "Import only the languages the product actually highlights instead of the full highlighter with every grammar.",
		"Skip Redundant Fetches":           "Do not download the same payload twice during boot; reuse the in-flight or cached response.",
		"Optimize Hydration Strategy":      "Hydrate non-critical islands on idle or interaction instead of blocking first paint with eager client hydration.",
		"Inline Critical HTML Shell":       "Paint the LCP heading/logo from static HTML+CSS instead of waiting for the app bundle to mount it.",
		"Inline Critical CSS":              "Inline the above-the-fold rules first paint needs and load the rest of the stylesheet asynchronously.",
		"Inline Shared Stylesheets":        "Inline the shared render-blocking stylesheet so first paint does not wait on a CSS round trip.",
		"Remove Duplicate CSS Bundles":     "Do not ship two overlapping CSS bundles as render-blocking; emit one shared stylesheet.",
		"Compress SVG Assets":              "Minify inline and static SVGs so the document and images cost fewer bytes on the critical path.",
	} {
		genericDescriptions[categoryKey(name)] = description
	}
}

// CatalogDescription is the board's own blurb for a technique, or "" when the
// technique is not one the catalog names.
func CatalogDescription(name string) string {
	return genericDescriptions[categoryKey(name)]
}

// GenericCategoryDescription is the description the board stores for a
// submission filed under `name`: the catalog blurb when the board has one, the
// submitted text when it is already generic, and a placeholder when neither
// survives.
func GenericCategoryDescription(name, submitted string) string {
	if blurb := CatalogDescription(name); blurb != "" {
		return truncate(blurb, categoryDescriptionMax)
	}
	if cleaned := sanitizeCategoryDescription(submitted); IsGenericDescription(cleaned) {
		return truncate(cleaned, categoryDescriptionMax)
	}
	return truncate(communityDescriptionPrefix+name, categoryDescriptionMax)
}

// sanitizeCategoryDescription keeps the leading sentence of a submitted
// description with the site-specific words removed. It is the salvage path for
// a technique the catalog has no blurb for: strip what names one repo and see
// whether a usable sentence is left. Often there is not, and the caller falls
// back to the placeholder.
func sanitizeCategoryDescription(raw string) string {
	sentence := firstSentence(asidePattern.ReplaceAllString(raw, " "))

	kept := make([]string, 0, 24)
	for _, token := range strings.Fields(sentence) {
		if descriptionTokenMarker(token) == "" &&
			!measurementPattern.MatchString(strings.TrimLeft(trimDescriptionToken(token), "~<>=+")) {
			kept = append(kept, token)
			continue
		}
		// The dropped word was the object of the preposition in front of it, so
		// that preposition goes with it: "the table in src/routes/manifest.ts at
		// build time" must not be left as "the table in at build time".
		if len(kept) > 0 && isPreposition(kept[len(kept)-1]) {
			kept = kept[:len(kept)-1]
		}
	}
	return strings.TrimSpace(strings.Trim(strings.Join(kept, " "), " ,;:-–—"))
}

func isPreposition(token string) bool {
	switch strings.ToLower(trimDescriptionToken(token)) {
	case "at", "by", "for", "from", "in", "into", "of", "on", "onto", "to",
		"under", "via", "with", "within", "without":
		return true
	}
	return false
}

// firstSentence is the first sentence of a description. Later sentences on this
// board are always the run's own numbers ("Total bytes 21.1MB -> 4.2MB"), and a
// category description is one line.
func firstSentence(text string) string {
	fields := strings.Fields(text)
	for i, token := range fields {
		if endsSentence(token) {
			return strings.Join(fields[:i+1], " ")
		}
	}
	return strings.Join(fields, " ")
}
