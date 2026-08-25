package leaderboard

import (
	"math"
	"sort"
	"strings"

	"makefaster/internal/embedding"
)

const (
	categoryNameMax        = 80
	categoryDescriptionMax = 160
)

// smallWords stay lowercase in the middle of a title-cased category name.
var smallWords = map[string]struct{}{}

// acronyms are the spellings the leaderboard uses for terms that would
// otherwise be title-cased into nonsense ("Css", "Webp").
var acronyms = map[string]string{
	"css": "CSS", "js": "JS", "html": "HTML", "http": "HTTP", "http2": "HTTP/2",
	"http3": "HTTP/3", "api": "API", "apis": "APIs", "cdn": "CDN", "svg": "SVG",
	"dom": "DOM", "ssr": "SSR", "csr": "CSR", "lcp": "LCP", "fcp": "FCP", "tti": "TTI",
	"tbt": "TBT", "inp": "INP", "cls": "CLS", "ttfb": "TTFB", "quic": "QUIC",
	"avif": "AVIF", "webp": "WebP", "json": "JSON", "url": "URL", "urls": "URLs",
	"ui": "UI", "db": "DB", "sql": "SQL", "spa": "SPA", "pwa": "PWA", "srcset": "srcset",
}

func init() {
	for _, word := range []string{
		"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the",
		"to", "via", "vs", "with",
	} {
		smallWords[word] = struct{}{}
	}
}

// hasUpperAfterFirst reports whether the submitter already capitalized
// something beyond the first letter (ORM, WebP, LCP), in which case the
// spelling is preserved as-is.
func hasUpperAfterFirst(word string) bool {
	runes := []rune(word)
	for i := 1; i < len(runes); i++ {
		if runes[i] >= 'A' && runes[i] <= 'Z' {
			return true
		}
	}
	return false
}

// TitleCaseCategoryName turns "inline critical css" into "Inline Critical CSS".
func TitleCaseCategoryName(raw string) string {
	words := strings.Fields(strings.TrimSpace(raw))
	out := make([]string, 0, len(words))
	for i, word := range words {
		lower := strings.ToLower(word)
		switch {
		case hasUpperAfterFirst(word):
			out = append(out, word)
		case acronyms[lower] != "":
			out = append(out, acronyms[lower])
		case i > 0 && i < len(words)-1 && isSmallWord(lower):
			out = append(out, lower)
		default:
			out = append(out, capitalize(lower))
		}
	}
	return truncate(strings.Join(out, " "), categoryNameMax)
}

func isSmallWord(lower string) bool {
	_, ok := smallWords[lower]
	return ok
}

func capitalize(lower string) string {
	if lower == "" {
		return lower
	}
	runes := []rune(lower)
	return strings.ToUpper(string(runes[0])) + string(runes[1:])
}

// EmbeddingText is the text a category or improvement is embedded from. The
// name is doubled so name tokens outweigh description tokens.
func EmbeddingText(name, description string) string {
	return name + ". " + name + ". " + description
}

// jsRound rounds half away from +infinity, the way JavaScript's Math.round
// does: Math.round(-0.5) is 0, not -1. Go's math.Round rounds half away from
// zero, which would drift the folded averages by a millisecond here and there.
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

func roundMs(value float64) int {
	return int(jsRound(value))
}

func roundPct(value float64) float64 {
	return jsRound(value*10) / 10
}

// CategorizeResult is one entry of the POST /api/submit-improvements response.
type CategorizeResult struct {
	Input      string  `json:"input"`
	Action     string  `json:"action"`
	Category   string  `json:"category"`
	Similarity float64 `json:"similarity"`
}

// foldIntoCategory is a running-average fold. `count` approximates the sample
// count for both metrics; submissions that omit one delta leave that average
// untouched, which slightly over-weights history for that metric — acceptable
// for a leaderboard, and it avoids tracking per-metric sample counts.
func foldIntoCategory(category *Category, improvement Improvement) {
	previousCount := float64(category.Count)
	category.Count++
	if improvement.HasDeltaMs {
		previous := float64(category.AvgImprovementMs)
		category.AvgImprovementMs = roundMs((previous*previousCount + improvement.DeltaMs) / (previousCount + 1))
	}
	if improvement.HasDeltaPct {
		previous := category.AvgImprovementPct
		category.AvgImprovementPct = roundPct((previous*previousCount + improvement.DeltaPct) / (previousCount + 1))
	}
	category.Description = foldedDescription(*category, improvement)
}

// foldedDescription decides what a row says after a submission folds into it.
// The row's own text wins whenever it is already a technique: a fold is one
// more site reporting the same win, and letting the newest submitter overwrite
// the blurb would put whichever repo submitted last on the public board. A row
// that still carries a site-specific description — every row created before
// this rule existed — is upgraded instead, but only to text that is actually
// generic.
func foldedDescription(category Category, improvement Improvement) string {
	if IsGenericDescription(category.Description) {
		return category.Description
	}
	if upgraded := GenericCategoryDescription(category.Name, improvement.Description); IsGenericDescription(upgraded) {
		return upgraded
	}
	return category.Description
}

func createCategoryFrom(improvement Improvement) Category {
	name := GenericCategoryName(improvement.Name)
	description := GenericCategoryDescription(name, improvement.Description)
	category := Category{
		Rank:        0, // assigned by RerankCategories below
		Name:        name,
		Description: description,
		Count:       1,
		Icon:        "default",
	}
	if improvement.HasDeltaMs {
		category.AvgImprovementMs = roundMs(improvement.DeltaMs)
	}
	if improvement.HasDeltaPct {
		category.AvgImprovementPct = roundPct(improvement.DeltaPct)
	}
	return category
}

// RerankCategories puts the most-used technique first — times improved, count
// descending — because a category's value to the next site is how often it has
// worked, not how well it worked once. Ties break on the biggest average
// improvement (deltas are negative, so ascending pct), then on name so the
// order is stable across reranks. Every rank is rewritten to its 1-based
// position.
func RerankCategories(categories []Category) {
	sort.SliceStable(categories, func(i, j int) bool {
		a, b := categories[i], categories[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.AvgImprovementPct != b.AvgImprovementPct {
			return a.AvgImprovementPct < b.AvgImprovementPct
		}
		return compareNames(a.Name, b.Name) < 0
	})
	for i := range categories {
		categories[i].Rank = i + 1
	}
}

// compareNames approximates JavaScript's String#localeCompare for the ASCII
// names this board holds: letters order case-insensitively first, and case
// only breaks an otherwise exact tie.
func compareNames(a, b string) int {
	if folded := strings.Compare(strings.ToLower(a), strings.ToLower(b)); folded != 0 {
		return folded
	}
	return strings.Compare(a, b)
}

// Categorize folds submitted improvements into the improvement-category
// leaderboard.
//
// Every submitted name is first reduced to a generic technique name
// (GenericCategoryName), so the site-specific detail a submitter put in the
// name cannot become a row of its own — and the description the row stores goes
// through the same treatment (GenericCategoryDescription), so it cannot become
// one repo's changelog either. That name then decides the fold:
//
//   - a category whose name keys the same (categoryKey) is the same technique
//     worded differently -> fold into it, no embedding needed;
//   - otherwise the improvement is embedded from its generic name plus its
//     description and compared to every category by cosine similarity;
//     similarity >= threshold -> fold into the closest one;
//   - below threshold -> the technique is novel, so a new category is created,
//     named generically and seeded from the submission.
//
// Improvements inside one submission are processed sequentially against the
// growing category list, so two novel-but-similar entries in the same payload
// create one category, not two. The input slice is not mutated.
func Categorize(improvements []Improvement, categories []Category, embedder embedding.Embedder, threshold float64) ([]Category, []CategorizeResult) {
	working := make([]Category, len(categories))
	copy(working, categories)

	// The name the board would store for each submission, decided before any
	// matching so both the key fold and the embedding text see it.
	genericNames := make([]string, len(improvements))
	for i, improvement := range improvements {
		genericNames[i] = GenericCategoryName(improvement.Name)
	}

	texts := make([]string, 0, len(working)+len(improvements))
	for _, category := range working {
		texts = append(texts, EmbeddingText(category.Name, category.Description))
	}
	for i, improvement := range improvements {
		texts = append(texts, EmbeddingText(genericNames[i], improvement.Description))
	}
	vectors := embedder.EmbedMany(texts)
	categoryVectors := vectors[:len(working):len(working)]
	improvementVectors := vectors[len(working):]

	// Fold keys for the categories already on the board, kept in step with
	// `working` as new categories are appended.
	categoryKeys := make([]string, len(working))
	for i, category := range working {
		categoryKeys[i] = categoryKey(category.Name)
	}

	results := make([]CategorizeResult, 0, len(improvements))
	for i, improvement := range improvements {
		vector := improvementVectors[i]

		// Same technique, different wording: fold without asking the embedder,
		// so two submissions that normalize to one generic name always share a
		// row no matter how the similarity lands. The submitter's own cleaned-up
		// name is tried first, so someone who already named the technique the
		// way the board does lands on that row instead of a rule's synonym.
		match := indexOfKey(categoryKeys, categoryKey(SanitizedCategoryName(improvement.Name)))
		if match == -1 {
			match = indexOfKey(categoryKeys, categoryKey(genericNames[i]))
		}
		if match != -1 {
			foldIntoCategory(&working[match], improvement)
			results = append(results, CategorizeResult{
				Input:    improvement.Name,
				Action:   "matched",
				Category: working[match].Name,
				// An exact name fold is a 1.0 match by construction.
				Similarity: 1,
			})
			continue
		}

		bestIndex := -1
		bestSimilarity := math.Inf(-1)
		for j, categoryVector := range categoryVectors {
			similarity := embedding.CosineSimilarity(vector, categoryVector)
			if similarity > bestSimilarity {
				bestSimilarity = similarity
				bestIndex = j
			}
		}

		if bestIndex != -1 && bestSimilarity >= threshold {
			foldIntoCategory(&working[bestIndex], improvement)
			results = append(results, CategorizeResult{
				Input:      improvement.Name,
				Action:     "matched",
				Category:   working[bestIndex].Name,
				Similarity: jsRound(bestSimilarity*1000) / 1000,
			})
			continue
		}

		category := createCategoryFrom(improvement)
		working = append(working, category)
		categoryVectors = append(categoryVectors, vector)
		categoryKeys = append(categoryKeys, categoryKey(category.Name))
		similarity := 0.0
		if bestIndex != -1 {
			similarity = jsRound(bestSimilarity*1000) / 1000
		}
		results = append(results, CategorizeResult{
			Input:      improvement.Name,
			Action:     "created",
			Category:   category.Name,
			Similarity: similarity,
		})
	}

	RerankCategories(working)
	return working, results
}

func indexOfKey(keys []string, key string) int {
	if key == "" {
		return -1
	}
	for i, candidate := range keys {
		if candidate == key {
			return i
		}
	}
	return -1
}
