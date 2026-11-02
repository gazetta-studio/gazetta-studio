package cli

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/skill"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/state"
)

func publishing(t *testing.T) (*harness, *fakeadmin.Admin) {
	t.Helper()
	h, a := signedIn(t)
	a.SeedPublish()
	return h, a
}

func TestPublishWaitsForAnElevationThenUsesIt(t *testing.T) {
	h, a := publishing(t)
	h.must(t, "publish", "home", "@header", "--to", "staging")
	e := a.Elevation
	if !slices.Equal(e.Started, []string{"non-production"}) || len(e.Published) != 1 {
		t.Fatalf("started %v published %v", e.Started, e.Published)
	}
	if !slices.Equal(e.Published[0], []string{"pages/home", "fragments/header", "staging"}) {
		t.Fatalf("published %v", e.Published[0])
	}
	if !strings.Contains(h.stderr.String(), fakeadmin.ElevationCode) || !strings.Contains(h.stdout.String(), "Published 2 items to staging") {
		t.Fatalf("stdout %q stderr %q", h.stdout.String(), h.stderr.String())
	}
	// Within the elevation, the next publish asks for nothing.
	h.must(t, "publish", "about", "--to", "staging")
	if len(e.Started) != 1 || len(e.Published) != 2 {
		t.Fatalf("started %v published %v", e.Started, e.Published)
	}
}

func TestPublishToProductionAsksForAProductionElevation(t *testing.T) {
	h, a := publishing(t)
	h.must(t, "publish", "home", "--to", "staging")
	h.must(t, "publish", "home", "--to", "production")
	if !slices.Equal(a.Elevation.Started, []string{"non-production", "production"}) {
		t.Fatalf("started %v", a.Elevation.Started)
	}
}

func TestPublishToProductionAsksForBothElevationsInTurn(t *testing.T) {
	h, a := publishing(t)
	h.must(t, "publish", "home", "--to", "production")
	if !slices.Equal(a.Elevation.Started, []string{"non-production", "production"}) || len(a.Elevation.Published) != 1 {
		t.Fatalf("started %v published %v", a.Elevation.Started, a.Elevation.Published)
	}
}

func TestPublishReportsARefusalAfterTheElevation(t *testing.T) {
	h, a := publishing(t)
	a.Elevation.Refuse = "non-production"
	if code := h.run("publish", "home", "--to", "staging"); code != output.NeedsLogin {
		t.Fatalf("exit %d stderr %q", code, h.stderr.String())
	}
	if len(a.Elevation.Started) != 1 || len(a.Elevation.Published) != 0 {
		t.Fatalf("asked again: started %v", a.Elevation.Started)
	}
}

func TestPublishWithoutWaitingExitsThree(t *testing.T) {
	for name, set := range map[string]func(h *harness) []string{
		"--no-wait": func(h *harness) []string { return []string{"--no-wait"} },
		"CI":        func(h *harness) []string { h.vars["CI"] = "true"; return nil },
	} {
		t.Run(name, func(t *testing.T) {
			h, a := publishing(t)
			args := append([]string{"publish", "home", "--to", "staging"}, set(h)...)
			if code := h.run(args...); code != output.NeedsLogin {
				t.Fatalf("exit %d stderr %q", code, h.stderr.String())
			}
			if a.Elevation.Polls != 0 || len(a.Elevation.Published) != 0 {
				t.Fatalf("polled %d published %v", a.Elevation.Polls, a.Elevation.Published)
			}
			if !strings.Contains(h.stderr.String(), fakeadmin.ElevationCode) || !strings.Contains(h.stderr.String(), "run the command again") {
				t.Fatalf("stderr %q", h.stderr.String())
			}
		})
	}
}

func TestPublishStopsWhenTheElevationIsRefused(t *testing.T) {
	for _, decision := range []string{"denied", "expired"} {
		t.Run(decision, func(t *testing.T) {
			h, a := publishing(t)
			a.Elevation.Decision, a.Elevation.PendingPolls = decision, 2
			if code := h.run("publish", "home", "--to", "staging"); code == output.OK {
				t.Fatalf("published after %s", decision)
			}
			if a.Elevation.Polls != 3 || len(a.Elevation.Published) != 0 {
				t.Fatalf("polled %d published %v", a.Elevation.Polls, a.Elevation.Published)
			}
			if !strings.Contains(h.stderr.String(), "elevation") {
				t.Fatalf("stderr %q", h.stderr.String())
			}
		})
	}
}

func TestPublishAllTakesTheChangesAndReportsAFailedTarget(t *testing.T) {
	h, a := publishing(t)
	a.Elevation.FailTarget = "staging"
	if code := h.run("publish", "--all", "--to", "staging"); code != output.Failure {
		t.Fatalf("exit %d", code)
	}
	if !slices.Equal(a.Elevation.Published[0], []string{"pages/home", "staging"}) {
		t.Fatalf("published %v", a.Elevation.Published)
	}
	if !strings.Contains(h.stdout.String(), "Publishing to staging failed: fake failure") {
		t.Fatalf("stdout %q", h.stdout.String())
	}
	for _, args := range [][]string{{"publish", "home"}, {"publish", "--to", "staging"}, {"publish", "home", "--all", "--to", "staging"}} {
		if code := h.run(args...); code != output.Usage {
			t.Fatalf("%v: exit %d", args, code)
		}
	}
}

func TestElevateAheadOfTimeAndEnd(t *testing.T) {
	h, a := publishing(t)
	h.must(t, "elevate", "--production")
	if !slices.Equal(a.Elevation.Started, []string{"production"}) || !strings.Contains(h.stdout.String(), "Elevated for production targets") {
		t.Fatalf("started %v stdout %q", a.Elevation.Started, h.stdout.String())
	}
	// The route also checks non-production rights, so the publish asks for
	// that one too, and not again for production.
	h.must(t, "publish", "home", "--to", "production")
	if !slices.Equal(a.Elevation.Started, []string{"production", "non-production"}) {
		t.Fatalf("started %v", a.Elevation.Started)
	}
	h.must(t, "elevate", "--end")
	if !slices.Equal(a.Elevation.Ended, []string{"el-1", "el-2"}) && !slices.Equal(a.Elevation.Ended, []string{"el-2", "el-1"}) || len(a.Elevation.Active) != 0 {
		t.Fatalf("ended %v active %v", a.Elevation.Ended, a.Elevation.Active)
	}
	st, _ := state.Load(state.Path(h.env.ConfigDir))
	if len(st.Elevations["dev"]) != 0 {
		t.Fatalf("state %v", st.Elevations)
	}
	h.must(t, "elevate", "--end")
	if !strings.Contains(h.stdout.String(), "No elevation of yours is active") {
		t.Fatalf("stdout %q", h.stdout.String())
	}
}

func TestElevateEndForgetsElevationsTheAdminAlreadyEnded(t *testing.T) {
	h, a := publishing(t)
	h.must(t, "elevate")
	delete(a.Elevation.Active, "el-1") // ended in the admin
	h.must(t, "elevate", "--end")
	if !strings.Contains(h.stdout.String(), "Ended your elevation") {
		t.Fatalf("stdout %q", h.stdout.String())
	}
}

func TestAssets(t *testing.T) {
	h, a := publishing(t)
	file := filepath.Join(t.TempDir(), "sunset.jpg")
	if err := os.WriteFile(file, []byte("jpeg bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.must(t, "assets", "upload", file, "--alt", "A sunset")
	h.must(t, "assets", "upload", file, "--name", "hero", "--decorative")
	if !strings.Contains(h.stdout.String(), "Uploaded hero-2") {
		t.Fatalf("stdout %q", h.stdout.String())
	}
	h.must(t, "assets", "alt", "hero", "A mountain")
	h.must(t, "assets", "list")
	out := h.stdout.String()
	for _, want := range []string{`hero  image/jpeg  1024 bytes  alt "A mountain"`, `sunset  `, `alt "A sunset"`, `hero-2  `, "decorative"} {
		if !strings.Contains(out, want) {
			t.Fatalf("list lacks %q:\n%s", want, out)
		}
	}
	h.must(t, "assets", "alt", "sunset", "--decorative")
	if a.Elevation.Assets[1]["alt"] != "" {
		t.Fatalf("assets %v", a.Elevation.Assets)
	}
	for _, args := range [][]string{
		{"assets", "alt", "hero", "Une montagne", "--locale", "fr"},
		{"assets", "alt", "hero"},
		{"assets", "alt", "hero", "text", "--decorative"},
		{"assets", "upload", file, file, "--name", "x"},
	} {
		if code := h.run(args...); code != output.Usage {
			t.Fatalf("%v: exit %d", args, code)
		}
	}
	if code := h.run("assets", "alt", "missing", "text"); code != output.NotFound {
		t.Fatalf("missing asset: exit %d %q", code, h.stderr.String())
	}
}

func TestOutdatedSkillWarnsOnceADay(t *testing.T) {
	h := newHarness(t, twoProfiles())
	day := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	h.env.Now = func() time.Time { return day }
	dir := t.TempDir()
	h.must(t, "skill", "install", dir)
	path := filepath.Join(dir, "gz", "SKILL.md")
	b, _ := os.ReadFile(path)
	old := regexpReplace(string(b), "0.0.1")
	if err := os.WriteFile(path, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	warning := "is from gz 0.0.1; refresh it with: gz skill install"
	h.must(t, "auth", "list")
	if !strings.Contains(h.stderr.String(), warning) {
		t.Fatalf("no warning: %q", h.stderr.String())
	}
	h.must(t, "auth", "list")
	if strings.Contains(h.stderr.String(), warning) {
		t.Fatalf("warned twice in a day")
	}
	h.must(t, "auth", "list", "--json")
	day = day.Add(24 * time.Hour)
	h.must(t, "auth", "list", "--json")
	if strings.Contains(h.stderr.String(), warning) {
		t.Fatalf("warned with --json")
	}
	h.must(t, "auth", "list")
	if !strings.Contains(h.stderr.String(), warning) {
		t.Fatalf("no warning the next day")
	}
}

func regexpReplace(text, version string) string {
	i := strings.Index(text, "gz-version:")
	end := i + strings.Index(text[i:], "\n")
	return text[:i] + `gz-version: "` + version + `"` + text[end:]
}

// The gz half of Q32's never-run test: every gz command is sorted, and the
// skill's never-run list names exactly the never ones (the package's test
// checks its own lists match this one).
func TestNeverRunListsExactlyTheCommandsThatChangeTargets(t *testing.T) {
	sorted := map[string]string{
		"auth login": "allowed", "auth list": "allowed", "auth use": "allowed", "auth status": "allowed", "auth logout": "allowed",
		"skill": "allowed", "skill install": "allowed", "version": "allowed",
		"pages list": "allowed", "pages get": "allowed", "pages set": "allowed", "pages edit": "allowed", "pages create": "allowed",
		"fragments list": "allowed", "fragments get": "allowed", "fragments set": "allowed", "fragments edit": "allowed", "fragments create": "allowed",
		"templates schema": "allowed", "validate": "allowed", "preview": "allowed", "status": "allowed",
		"assets list": "allowed", "assets upload": "allowed", "assets alt": "allowed",
		"publish": "never", "elevate": "never",
	}
	var have, never []string
	for _, c := range Commands() {
		have = append(have, c)
		if _, ok := sorted[c]; !ok {
			t.Errorf("gz %s isn't sorted: add it to this test as never or allowed (design-agent-access.md Q32)", c)
		}
	}
	for c, kind := range sorted {
		if !slices.Contains(have, c) {
			t.Errorf("gz %s is sorted here but gz has no such command", c)
		}
		if kind == "never" {
			never = append(never, c)
		}
	}
	sort.Strings(never)
	got := skill.NeverRun()
	sort.Strings(got)
	if !slices.Equal(got, never) {
		t.Fatalf("the skill's never-run list has %v; want %v", got, never)
	}
}
