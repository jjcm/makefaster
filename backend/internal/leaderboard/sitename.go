package leaderboard

// The site board is a list of products, so a row's name is the product's name
// and nothing else. What submitters actually send describes their own
// deployment of it:
//
//	Dify Studio (self-hosted)
//	n8n (self-hosted editor, jjcm/n8n fork)
//	Uptime Kuma (self-hosted dashboard)
//	Langflow (fork)
//
// Every one of those is "how I ran it", not "what it is". Two people measuring
// the same product would write two different names, the board would read like a
// list of one person's infrastructure, and the name is the only thing a reader
// uses to recognize the row.
//
// ProductSiteName strips the deployment story back to the product:
//
//  1. parentheticals and brackets go — on this board they are always the
//     qualifier, never the name;
//  2. fork, self-hosted and jjcm references go wherever they appear, because
//     they describe the copy that was measured;
//  3. a trailing UI-surface word ("studio", "dashboard", "editor") goes, because
//     it names the screen rather than the product.
//
// Matching is whole-token and case-insensitive, so a real name that merely
// contains those letters is untouched: "Forkify", "Editorial" and "Selfhostr"
// keep every character. Rule 3 is the one that can be wrong — "Android Studio"
// would lose its second word — but it is what turns "Dify Studio (self-hosted)"
// into "Dify", and a product whose name genuinely ends in a surface word can be
// submitted with that word inside the parentheses-free name only by losing it.
// The alternative, a hardcoded list of real product names, ages worse.

import "strings"

// siteNamePunctuation is the punctuation a name token wears in a sentence, and
// what gets trimmed before it is compared: "editor," and "editor" are the same
// word.
const siteNamePunctuation = `,;:.!?()[]{}"'“”‘’—–|/\ `

// deploymentQualifiers describe the copy of the product that was measured, not
// the product. They are dropped wherever they appear in the name.
var deploymentQualifiers = map[string]struct{}{
	"fork": {}, "forks": {}, "forked": {}, "self-hosted": {}, "selfhosted": {},
	"self": {}, "hosted": {}, "branch": {}, "mirror": {}, "instance": {},
	"localhost": {}, "staging": {}, "jjcm": {},
}

// surfaceQualifiers name the screen the loop measured rather than the product
// that serves it. They are dropped only from the end of the name, so "Uptime
// Kuma" keeps "Kuma" while "Dify Studio" loses "Studio".
var surfaceQualifiers = map[string]struct{}{
	"studio": {}, "dashboard": {}, "editor": {}, "console": {}, "admin": {},
	"panel": {}, "portal": {}, "deploy": {}, "deployment": {},
}

// ProductSiteName is the name the board stores for a submitted site: the
// product, without the deployment it was measured in. A name that is nothing
// but qualifiers is returned as it came in, because an empty row name is worse
// than a wordy one.
func ProductSiteName(raw string) string {
	stripped := asidePattern.ReplaceAllString(raw, " ")

	kept := make([]string, 0, 8)
	for _, token := range strings.Fields(stripped) {
		word := siteNameWord(token)
		if word == "" {
			continue
		}
		if _, qualifier := deploymentQualifiers[word]; qualifier {
			continue
		}
		// "jjcm/n8n", "github.com/jjcm/n8n": a reference to the fork that was
		// measured, whatever it is spelled against.
		if strings.Contains(word, "jjcm/") {
			continue
		}
		kept = append(kept, token)
	}

	// Trailing surface words, innermost last: "Dify Studio Dashboard" -> "Dify".
	for len(kept) > 1 {
		if _, surface := surfaceQualifiers[siteNameWord(kept[len(kept)-1])]; !surface {
			break
		}
		kept = kept[:len(kept)-1]
	}

	name := strings.TrimSpace(strings.Trim(strings.Join(kept, " "), siteNamePunctuation))
	if name != "" {
		return name
	}
	// Nothing survived. A name that was only a fork reference still carries the
	// product in it — "jjcm/langflow" is the repository, spelled as a path — so
	// the repository half is the best name available, spelled as submitted.
	for _, token := range strings.Fields(stripped) {
		bare := strings.Trim(token, siteNamePunctuation)
		if !strings.Contains(strings.ToLower(bare), "jjcm/") {
			continue
		}
		if repo := bare[strings.LastIndex(bare, "/")+1:]; repo != "" {
			return repo
		}
	}
	return strings.TrimSpace(raw)
}

// siteNameWord is a token reduced to the word it carries: lowercase, without
// the punctuation around it. An empty result means the token was punctuation.
func siteNameWord(token string) string {
	return strings.ToLower(strings.Trim(token, siteNamePunctuation))
}
