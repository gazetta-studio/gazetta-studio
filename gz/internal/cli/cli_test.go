package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/grant"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/skill"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/version"
)

type harness struct {
	env    Env
	stdout *bytes.Buffer
	stderr *bytes.Buffer
	vars   map[string]string
}

func newHarness(t *testing.T, profiles *profile.Config) *harness {
	t.Helper()
	dir := t.TempDir()
	if profiles != nil {
		if err := profiles.Save(profile.Path(dir)); err != nil {
			t.Fatal(err)
		}
	}
	h := &harness{stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}, vars: map[string]string{}}
	h.env = Env{
		Stdout:    h.stdout,
		Stderr:    h.stderr,
		Getenv:    func(k string) string { return h.vars[k] },
		ConfigDir: dir,
		Grants:    grant.NewFile(filepath.Join(dir, "grants")),
		Probe:     func(string) bool { return false },
	}
	return h
}

func (h *harness) run(args ...string) int {
	h.stdout.Reset()
	h.stderr.Reset()
	return Run(args, h.env)
}

func (h *harness) json(t *testing.T) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(h.stdout.Bytes(), &v); err != nil {
		t.Fatalf("not JSON: %q", h.stdout.String())
	}
	return v
}

func twoProfiles() *profile.Config {
	return &profile.Config{Default: "work", Profiles: []profile.Profile{
		{Name: "work", URL: "https://cms.example.com"},
		{Name: "local", URL: "http://localhost:3000"},
	}}
}

func TestVersion(t *testing.T) {
	h := newHarness(t, nil)
	for _, args := range [][]string{{"--version"}, {"version"}} {
		if code := h.run(args...); code != output.OK || h.stdout.String() != "gz "+version.String()+"\n" {
			t.Fatalf("%v: %d %q", args, code, h.stdout.String())
		}
	}
	h.run("--version", "--json")
	if h.json(t)["version"] != version.String() {
		t.Fatalf("json: %q", h.stdout.String())
	}
}

func TestAuthListUseLogout(t *testing.T) {
	h := newHarness(t, twoProfiles())
	if code := h.run("auth", "list"); code != output.OK || h.stdout.String() != "* work  https://cms.example.com\n  local  http://localhost:3000\n" {
		t.Fatalf("list: %d %q", code, h.stdout.String())
	}
	if code := h.run("auth", "use", "local", "--json"); code != output.OK || h.json(t)["default"] != "local" {
		t.Fatalf("use: %d %q", code, h.stdout.String())
	}
	h.run("auth", "list", "--json")
	got := h.json(t)
	if got["default"] != "local" || len(got["profiles"].([]any)) != 2 {
		t.Fatalf("list json: %v", got)
	}
	if err := h.env.Grants.Set("local", "secret"); err != nil {
		t.Fatal(err)
	}
	if code := h.run("auth", "logout", "--json"); code != output.OK {
		t.Fatalf("logout: %d %q", code, h.stdout.String())
	}
	if got := h.json(t); got["removed"] != "local" || got["default"] != "work" {
		t.Fatalf("logout json: %v", got)
	}
	if _, err := h.env.Grants.Get("local"); err != grant.ErrNotFound {
		t.Fatalf("grant kept after logout: %v", err)
	}
}

func TestAuthUseUnknownIsNotFound(t *testing.T) {
	h := newHarness(t, twoProfiles())
	if code := h.run("auth", "use", "nope", "--json"); code != output.NotFound {
		t.Fatalf("got %d", code)
	}
	if h.json(t)["error"].(map[string]any)["kind"] != "not_found" {
		t.Fatalf("%q", h.stdout.String())
	}
}

func TestAuthStatusSelection(t *testing.T) {
	h := newHarness(t, twoProfiles())
	h.vars["GZ_ADMIN"] = "local"
	if code := h.run("auth", "status"); code != output.OK || h.stdout.String() != "Using local (http://localhost:3000)\n" {
		t.Fatalf("env: %d %q", code, h.stdout.String())
	}
	if code := h.run("--admin", "work", "auth", "status", "--json"); code != output.OK || h.json(t)["url"] != "https://cms.example.com" {
		t.Fatalf("flag: %d %q", code, h.stdout.String())
	}
}

func TestAuthStatusWithNoProfileExits3(t *testing.T) {
	h := newHarness(t, nil)
	h.env.Probe = func(string) bool { return true }
	if code := h.run("auth", "status"); code != output.NeedsLogin {
		t.Fatalf("got %d", code)
	}
	if !strings.Contains(h.stderr.String(), "gz auth login http://localhost:3000") {
		t.Fatalf("stderr %q", h.stderr.String())
	}
}

func TestUsageErrorsExit2(t *testing.T) {
	h := newHarness(t, nil)
	for _, args := range [][]string{{}, {"nope"}, {"auth", "use"}, {"auth", "use", "a", "b"}, {"--bogus"}, {"--admin"}} {
		if code := h.run(args...); code != output.Usage {
			t.Fatalf("%v: got %d", args, code)
		}
	}
	if code := h.run("--help"); code != output.OK || !strings.Contains(h.stdout.String(), "gz skill install") {
		t.Fatalf("help: %d", code)
	}
}

func TestSkill(t *testing.T) {
	h := newHarness(t, nil)
	if code := h.run("skill"); code != output.OK || !strings.Contains(h.stdout.String(), `gz-version: "`+version.String()+`"`) {
		t.Fatalf("skill: %d", code)
	}
	dir := t.TempDir()
	if code := h.run("skill", "install", dir, "--json"); code != output.OK {
		t.Fatalf("install: %d %q", code, h.stderr.String())
	}
	path := h.json(t)["path"].(string)
	data, err := os.ReadFile(path)
	if err != nil || string(data) != skill.Text(version.String()) {
		t.Fatalf("%s: %v", path, err)
	}
}

// The gz half of design-agent-access.md Q32's test: every gz command the
// embedded skill names must exist.
func TestSkillNamesOnlyExistingCommands(t *testing.T) {
	have := map[string]bool{}
	for _, c := range Commands() {
		have[c] = true
	}
	for _, c := range skill.Commands() {
		if !have[c] {
			t.Errorf("the skill names `gz %s`, which gz doesn't have", c)
		}
	}
}
