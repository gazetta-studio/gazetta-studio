package profile

import (
	"errors"
	"os"
	"testing"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

func twoProfiles() *Config {
	return &Config{
		Default: "work",
		Profiles: []Profile{
			{Name: "work", URL: "https://cms.example.com"},
			{Name: "local", URL: "http://localhost:3000"},
		},
	}
}

func exitOf(t *testing.T, err error) int {
	t.Helper()
	var e *output.Error
	if !errors.As(err, &e) {
		t.Fatalf("not an output.Error: %v", err)
	}
	return e.Exit
}

func TestSelectOrder(t *testing.T) {
	cases := []struct {
		name string
		ch   Choice
		want string
	}{
		{"flag beats env and default", Choice{Flag: "local", Env: "work"}, "http://localhost:3000"},
		{"env beats default", Choice{Env: "local"}, "http://localhost:3000"},
		{"default when nothing is set", Choice{}, "https://cms.example.com"},
		{"a saved URL finds its profile", Choice{Flag: "https://cms.example.com/"}, "https://cms.example.com"},
		{"an unsaved URL is used as given", Choice{Env: "https://other.example.com/"}, "https://other.example.com"},
	}
	for _, c := range cases {
		p, err := Select(twoProfiles(), c.ch)
		if err != nil || p.URL != c.want {
			t.Fatalf("%s: got %+v, %v", c.name, p, err)
		}
	}
}

func TestSelectUnknownNameIsNotFound(t *testing.T) {
	_, err := Select(twoProfiles(), Choice{Flag: "nope"})
	if exitOf(t, err) != output.NotFound {
		t.Fatalf("got %v", err)
	}
}

func TestSelectWithNothingSuggestsALogin(t *testing.T) {
	for _, running := range []bool{true, false} {
		probed := ""
		_, err := Select(&Config{}, Choice{Probe: func(u string) bool { probed = u; return running }})
		if exitOf(t, err) != output.NeedsLogin {
			t.Fatalf("running=%v: %v", running, err)
		}
		if probed != LocalAdmin {
			t.Fatalf("probed %q", probed)
		}
		hint := err.(*output.Error).Hint
		want := "Run: gz auth login <admin-url>"
		if running {
			want = "An admin is running at http://localhost:3000. Run: gz auth login http://localhost:3000"
		}
		if hint != want {
			t.Fatalf("running=%v: hint %q", running, hint)
		}
	}
}

func TestRemoveMovesTheDefault(t *testing.T) {
	c := twoProfiles()
	if _, err := c.Remove("work"); err != nil {
		t.Fatal(err)
	}
	if c.Default != "local" || len(c.Profiles) != 1 {
		t.Fatalf("%+v", c)
	}
	if _, err := c.Remove("local"); err != nil || c.Default != "" {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestSaveAndLoad(t *testing.T) {
	path := Path(t.TempDir())
	empty, err := Load(path)
	if err != nil || len(empty.Profiles) != 0 {
		t.Fatalf("missing file: %+v %v", empty, err)
	}
	if err := twoProfiles().Save(path); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	got, err := Load(path)
	if err != nil || got.Default != "work" || len(got.Profiles) != 2 {
		t.Fatalf("%+v %v", got, err)
	}
}
