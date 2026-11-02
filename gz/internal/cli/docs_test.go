package cli

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// docs/gz.md and gz --help list the same commands (#1738): every command
// has its place on the page, and the page names none gz doesn't have.
func TestDocsPageNamesEveryCommandAndNoOther(t *testing.T) {
	page, err := os.ReadFile("../../../docs/gz.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(page)
	have := map[string]bool{}
	for _, c := range Commands() {
		have[c] = true
		// In running text (`gz pages set`) or as a line of a code block.
		inline := regexp.MustCompile("`gz " + regexp.QuoteMeta(c) + "[ `]")
		block := regexp.MustCompile("(?m)^gz " + regexp.QuoteMeta(c) + "( |$)")
		if !inline.MatchString(text) && !block.MatchString(text) {
			t.Errorf("docs/gz.md doesn't mention `gz %s`", c)
		}
	}
	for _, m := range regexp.MustCompile("(?m)(?:`|^)gz ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?").FindAllStringSubmatch(text, -1) {
		one, two := m[1], strings.TrimSpace(m[1]+" "+m[2])
		if !have[two] && !have[one] {
			t.Errorf("docs/gz.md names `gz %s`, which gz doesn't have", two)
		}
	}
}
