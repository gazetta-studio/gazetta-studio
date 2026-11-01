package cli

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/grant"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
)

func withAdmin(t *testing.T) (*harness, *fakeadmin.Admin) {
	t.Helper()
	a := fakeadmin.New()
	t.Cleanup(a.Close)
	h := newHarness(t, nil)
	h.env.HTTP = http.DefaultClient
	return h, a
}

func TestLoginStoresTheGrantAndMakesTheFirstProfileTheDefault(t *testing.T) {
	h, a := withAdmin(t)
	if code := h.run("auth", "login", a.URL, "--name", "dev", "--json"); code != output.OK {
		t.Fatalf("login: %d %q %q", code, h.stdout.String(), h.stderr.String())
	}
	got := h.json(t)
	if got["name"] != "dev" || got["url"] != a.URL || got["default"] != true || got["grantId"] != "g-1" {
		t.Fatalf("json %v", got)
	}
	if secret, err := h.env.Grants().Get("dev"); err != nil || secret != fakeadmin.GrantSecret {
		t.Fatalf("grant %q %v", secret, err)
	}
	if a.Machines[0] != "laptop" {
		t.Fatalf("machine %v", a.Machines)
	}
	if !strings.Contains(h.stderr.String(), "ABCD-EFGH") {
		t.Fatalf("the code isn't shown: %q", h.stderr.String())
	}

	// Plain output ends with the skill hint (Q41).
	if code := h.run("auth", "login", a.URL); code != output.OK || !strings.HasSuffix(h.stdout.String(), skillHint+"\n") {
		t.Fatalf("relogin: %d %q", code, h.stdout.String())
	}
	c, _ := profile.Load(profile.Path(h.env.ConfigDir))
	if len(c.Profiles) != 1 || c.Default != "dev" {
		t.Fatalf("a second login to the same admin added a profile: %+v", c)
	}
}

func TestFailedLoginStoresNothing(t *testing.T) {
	for _, decision := range []string{"denied", "expired"} {
		h, a := withAdmin(t)
		a.Decision = decision
		if code := h.run("auth", "login", a.URL); code != output.NeedsLogin {
			t.Fatalf("%s: %d", decision, code)
		}
		if _, err := h.env.Grants().Get(strings.TrimPrefix(a.URL, "http://")); err != grant.ErrNotFound {
			t.Fatalf("%s: grant stored", decision)
		}
		if c, _ := profile.Load(profile.Path(h.env.ConfigDir)); len(c.Profiles) != 0 {
			t.Fatalf("%s: profile saved", decision)
		}
	}
}

func TestStatusShowsWhichLoginsRenew(t *testing.T) {
	h, a := withAdmin(t)
	h.run("auth", "login", a.URL, "--name", "dev")
	c, _ := profile.Load(profile.Path(h.env.ConfigDir))
	c.Put(profile.Profile{Name: "old", URL: "http://old.example"})
	_ = c.Save(profile.Path(h.env.ConfigDir))

	if code := h.run("auth", "status", "--json"); code != output.OK {
		t.Fatalf("status: %d %q", code, h.stdout.String())
	}
	rows := h.json(t)["profiles"].([]any)
	if rows[0].(map[string]any)["login"] != "renews" || rows[1].(map[string]any)["login"] != "signed-out" {
		t.Fatalf("rows %v", rows)
	}
	a.Revoked["g-1"] = true
	h.run("auth", "status", "--json")
	if got := h.json(t)["profiles"].([]any)[0].(map[string]any)["login"]; got != "expired" {
		t.Fatalf("a revoked grant shows %v", got)
	}
}

func TestLogoutRevokesTheGrantOnTheAdmin(t *testing.T) {
	h, a := withAdmin(t)
	h.run("auth", "login", a.URL, "--name", "dev")
	if code := h.run("auth", "logout", "--json"); code != output.OK || h.json(t)["revoked"] != true {
		t.Fatalf("logout: %d %q", code, h.stdout.String())
	}
	if !a.Revoked["g-1"] || a.TokensSeen[0] == "" {
		t.Fatalf("not revoked on the admin: %v %v", a.Revoked, a.TokensSeen)
	}
	if _, err := h.env.Grants().Get("dev"); err != grant.ErrNotFound {
		t.Fatal("grant kept")
	}
}

func TestLogoutWithoutTheAdminSaysTheLoginStaysValid(t *testing.T) {
	h, a := withAdmin(t)
	h.run("auth", "login", a.URL, "--name", "dev")
	a.Close()
	if code := h.run("auth", "logout"); code != output.OK || !strings.Contains(h.stdout.String(), "stays valid there") {
		t.Fatalf("logout: %d %q", code, h.stdout.String())
	}
	if _, err := h.env.Grants().Get("dev"); err != grant.ErrNotFound {
		t.Fatal("grant kept")
	}
}

func TestCommandFlags(t *testing.T) {
	h := newHarness(t, nil)
	for _, args := range [][]string{
		{"auth", "login", "http://x", "--bogus"},
		{"auth", "list", "--name", "x"},
		{"auth", "login", "http://x", "--name"},
		{"auth", "login", "not a url"},
	} {
		if code := h.run(args...); code != output.Usage {
			t.Errorf("%v: got %d", args, code)
		}
	}
}

func TestLoginRefusesAnAdminOnAnotherMajor(t *testing.T) {
	h, a := withAdmin(t)
	a.Majors = []string{"v2"}
	if code := h.run("auth", "login", a.URL); code != output.Failure || !strings.Contains(h.stderr.String(), "Upgrade gz") {
		t.Fatalf("%d %q", code, h.stderr.String())
	}
}
