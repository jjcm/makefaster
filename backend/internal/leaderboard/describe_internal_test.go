package leaderboard

import "testing"

// Every name the rules can produce is a name the board will show, so every one
// of them needs a blurb — otherwise a submission lands on a technique row
// described as "Community-submitted: <name>", which is the placeholder, not a
// technique. This walks the rule tables themselves so adding a rule without a
// description fails here rather than on the public board.
func TestEveryCanonicalTechniqueHasADescription(t *testing.T) {
	names := make([]string, 0, len(canonicalRules)+len(deferBuckets)+2)
	for _, rule := range canonicalRules {
		names = append(names, rule.canonical)
	}
	for _, bucket := range deferBuckets {
		names = append(names, bucket.canonical)
	}
	// The two names canonicalNameFor spells out inline rather than in a table.
	names = append(names, "Inline Critical CSS", "Inline Shared Stylesheets")

	for _, name := range names {
		if CatalogDescription(name) == "" {
			t.Errorf("canonical technique %q has no entry in genericDescriptions", name)
		}
	}
}

// The reverse: a blurb keyed on a name no rule produces is dead weight that
// will drift out of date, so keep the two tables in step.
func TestEveryDescriptionBelongsToACanonicalTechnique(t *testing.T) {
	known := map[string]struct{}{
		categoryKey("Inline Critical CSS"):       {},
		categoryKey("Inline Shared Stylesheets"): {},
	}
	for _, rule := range canonicalRules {
		known[categoryKey(rule.canonical)] = struct{}{}
	}
	for _, bucket := range deferBuckets {
		known[categoryKey(bucket.canonical)] = struct{}{}
	}
	for key := range genericDescriptions {
		if _, expected := known[key]; !expected {
			t.Errorf("genericDescriptions has %q, which no rule can name", key)
		}
	}
}
