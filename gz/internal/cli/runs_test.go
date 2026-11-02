package cli

import (
	"slices"
	"strings"
	"testing"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

func TestRunsShowSaysWhatARevertWouldDo(t *testing.T) {
	h, a := signedIn(t)
	a.SeedRuns()
	h.must(t, "runs", "show", "r1")
	out := h.stdout.String()
	for _, want := range []string{
		"pages.home  will go back to its version before the run",
		"pages.about  changed since the run: skipped unless forced (--force pages.about)",
		"pages.promo  created by the run: will be archived",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("lacks %q:\n%s", want, out)
		}
	}
	if code := h.run("runs", "show", "nope"); code != output.NotFound {
		t.Fatalf("unknown run: exit %d", code)
	}
}

func TestRunsRevertSkipsChangedItemsUnlessForced(t *testing.T) {
	h, a := signedIn(t)
	a.SeedRuns()
	if code := h.run("runs", "revert", "r1", "--run", "undo-1"); code != output.Conflict {
		t.Fatalf("a skipped-changed item: exit %d", code)
	}
	if !strings.Contains(h.stdout.String(), "pages.about  skipped-changed") || !strings.Contains(h.stdout.String(), "1 of 3 items skipped. This revert is run undo-1.") {
		t.Fatalf("stdout %q", h.stdout.String())
	}
	h.must(t, "runs", "revert", "r1", "--force", "pages.about, pages.home")
	last := a.Runs.Reverts[len(a.Runs.Reverts)-1]
	if !slices.Equal(last.Force, []string{"pages.about", "pages.home"}) || !strings.HasPrefix(last.RevertRun, "gz-") {
		t.Fatalf("revert %+v", last)
	}
	if !strings.Contains(h.stdout.String(), "pages.about  reverted") {
		t.Fatalf("stdout %q", h.stdout.String())
	}
	a.Runs.Fail = "pages.promo"
	if code := h.run("runs", "revert", "r1", "--force", "pages.about"); code != output.Failure {
		t.Fatalf("another skipped item: exit %d", code)
	}
	a.Runs.Fail = ""
	if code := h.run("runs", "revert", "r1", "--run", "r1"); code != output.Usage {
		t.Fatalf("same run: exit %d", code)
	}
}
