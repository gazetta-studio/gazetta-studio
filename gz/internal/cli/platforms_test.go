package cli

import (
	"strings"
	"testing"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
)

func storedCreds(t *testing.T, h *harness, name string) session.Credentials {
	t.Helper()
	s, err := h.env.Grants().Get(name)
	if err != nil {
		t.Fatal(err)
	}
	return session.ParseCredentials(s)
}

func TestCloudflareServiceTokenOnEveryRequest(t *testing.T) {
	h, a := withAdmin(t)
	h.vars["GZ_CF_ACCESS_CLIENT_SECRET"] = "s3cret"
	if code := h.run("auth", "login", a.URL, "--name", "cf", "--cf-client-id", "abc.access"); code != output.OK {
		t.Fatalf("login: %d %q", code, h.stderr.String())
	}
	if c := storedCreds(t, h, "cf"); c.CFClientID != "abc.access" || c.CFClientSecret != "s3cret" || c.Grant != fakeadmin.GrantSecret {
		t.Fatalf("stored %+v", c)
	}
	h.run("auth", "logout")
	for i, hdr := range a.Headers {
		if hdr.Get("CF-Access-Client-Id") != "abc.access" || hdr.Get("CF-Access-Client-Secret") != "s3cret" {
			t.Fatalf("request %d without the service token: %v", i, hdr)
		}
		if hdr.Get("Authorization") != "" {
			t.Fatalf("request %d uses Authorization: %v", i, hdr)
		}
	}
	if !a.Revoked["g-1"] {
		t.Fatal("logout didn't revoke through Cloudflare")
	}
}

func TestCloudflareNeedsBothParts(t *testing.T) {
	h, a := withAdmin(t)
	if code := h.run("auth", "login", a.URL, "--cf-client-id", "abc.access"); code != output.Usage {
		t.Fatalf("got %d", code)
	}
}

func TestReloginKeepsThePlatform(t *testing.T) {
	h, a := withAdmin(t)
	h.run("auth", "login", a.URL, "--name", "cf", "--cf-client-id", "id", "--cf-client-secret", "s")
	n := len(a.Headers)
	if code := h.run("auth", "login", a.URL); code != output.OK {
		t.Fatalf("relogin: %d %q", code, h.stderr.String())
	}
	if a.Headers[n].Get("CF-Access-Client-Id") != "id" {
		t.Fatal("a re-login dropped the service token")
	}
}

func TestPasteFromStdinSendsBearerTokens(t *testing.T) {
	h, a := withAdmin(t)
	h.env.Stdin = strings.NewReader(fakeadmin.GrantSecret + "\n")
	if code := h.run("auth", "login", a.URL, "--name", "alb", "--paste", "--json"); code != output.OK {
		t.Fatalf("paste: %d %q %q", code, h.stdout.String(), h.stderr.String())
	}
	if a.Machines != nil {
		t.Fatal("a pasted login started a code")
	}
	if strings.Contains(h.stderr.String(), "paste it here") {
		t.Fatal("prompted outside a terminal")
	}
	c, _ := profile.Load(profile.Path(h.env.ConfigDir))
	if c.Profiles[0].Platform != profile.PlatformALB {
		t.Fatalf("profile %+v", c.Profiles[0])
	}
	h.run("auth", "logout")
	last := a.Headers[len(a.Headers)-1]
	if !strings.HasPrefix(last.Get("Authorization"), "Bearer tok-") || last.Get("Gazetta-Token") != "" {
		t.Fatalf("revoke didn't send a bearer token: %v", last)
	}
}

func TestPasteInATerminalPrompts(t *testing.T) {
	h, a := withAdmin(t)
	h.env.Terminal = true
	h.env.Open = func(string) error { return nil }
	h.env.Stdin = strings.NewReader(fakeadmin.GrantSecret + "\n")
	if code := h.run("auth", "login", a.URL, "--paste"); code != output.OK || !strings.Contains(h.stderr.String(), a.URL+"/admin/cli-signin") {
		t.Fatalf("%d %q", code, h.stderr.String())
	}
}

func TestPasteRefusesNothingOrABadSecret(t *testing.T) {
	for _, in := range []string{"", "g-1.wrong\n"} {
		h, a := withAdmin(t)
		h.env.Stdin = strings.NewReader(in)
		if code := h.run("auth", "login", a.URL, "--paste"); code != output.NeedsLogin {
			t.Fatalf("%q: %d %q", in, code, h.stderr.String())
		}
		if c, _ := profile.Load(profile.Path(h.env.ConfigDir)); len(c.Profiles) != 0 {
			t.Fatalf("%q: a profile was saved", in)
		}
	}
}

func TestEntraSignInThenGazettaLogin(t *testing.T) {
	h, a := withAdmin(t)
	f := fakeadmin.NewEntra()
	t.Cleanup(f.Close)
	h.env.EntraAuthority = f.URL
	code := h.run("auth", "login", a.URL, "--name", "az",
		"--entra-tenant", "contoso", "--entra-client-id", "gz-app", "--entra-scope", "api://admin/user_impersonation")
	if code != output.OK {
		t.Fatalf("login: %d %q", code, h.stderr.String())
	}
	if !strings.Contains(h.stderr.String(), "WXYZ-1234") {
		t.Fatalf("the Microsoft code isn't shown: %q", h.stderr.String())
	}
	if c := storedCreds(t, h, "az"); c.EntraRefreshToken != "entra-refresh" || c.Grant != fakeadmin.GrantSecret {
		t.Fatalf("stored %+v", c)
	}
	for i, hdr := range a.Headers {
		if hdr.Get("Authorization") != "Bearer entra-access" {
			t.Fatalf("request %d without the Entra token: %v", i, hdr)
		}
	}
	// Later commands renew the Entra token from the stored refresh token.
	n := len(a.Headers)
	h.run("auth", "logout")
	last := a.Headers[len(a.Headers)-1]
	if len(a.Headers) == n || last.Get("Authorization") != "Bearer entra-access-r1" || last.Get("Gazetta-Token") == "" {
		t.Fatalf("logout: %v", last)
	}
}

func TestOnePlatformAtATime(t *testing.T) {
	h, a := withAdmin(t)
	if code := h.run("auth", "login", a.URL, "--paste", "--cf-client-id", "x", "--cf-client-secret", "y"); code != output.Usage {
		t.Fatalf("got %d", code)
	}
}

func TestStatusShowsALapsedEntraSignInAsExpired(t *testing.T) {
	h, a := withAdmin(t)
	f := fakeadmin.NewEntra()
	t.Cleanup(f.Close)
	h.env.EntraAuthority = f.URL
	h.run("auth", "login", a.URL, "--name", "az",
		"--entra-tenant", "contoso", "--entra-client-id", "gz-app", "--entra-scope", "api://admin/user_impersonation")
	f.RefuseRefresh = true
	if code := h.run("auth", "status", "--json"); code != output.OK {
		t.Fatalf("status: %d %q", code, h.stdout.String())
	}
	if got := h.json(t)["profiles"].([]any)[0].(map[string]any)["login"]; got != "expired" {
		t.Fatalf("a lapsed Microsoft sign-in shows %v", got)
	}
}
