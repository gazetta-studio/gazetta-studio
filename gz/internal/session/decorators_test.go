package session

import (
	"context"
	"net/http"
	"testing"
)

type fixed string

func (f fixed) Token(context.Context) (string, error) { return string(f), nil }

func apply(t *testing.T, d Decorator) http.Header {
	t.Helper()
	req, _ := http.NewRequest("GET", "http://x", nil)
	if err := d(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	return req.Header
}

func TestDecoratorHeaders(t *testing.T) {
	cf := apply(t, CloudflareAccess("id.access", "secret"))
	if cf.Get("CF-Access-Client-Id") != "id.access" || cf.Get("CF-Access-Client-Secret") != "secret" || cf.Get("Authorization") != "" {
		t.Errorf("cloudflare: %v", cf)
	}
	if h := apply(t, WithBearerToken(fixed("tok"))); h.Get("Authorization") != "Bearer tok" || h.Get(TokenHeader) != "" {
		t.Errorf("bearer: %v", h)
	}
	if h := apply(t, WithToken(fixed("tok"))); h.Get(TokenHeader) != "tok" || h.Get("Authorization") != "" {
		t.Errorf("gazetta token: %v", h)
	}
}

func TestCredentialsRoundTrip(t *testing.T) {
	if got := ParseCredentials("g-1.secret"); got != (Credentials{Grant: "g-1.secret"}) {
		t.Fatalf("a cut 12 grant: %+v", got)
	}
	if s := (Credentials{Grant: "g"}).String(); s != "g" {
		t.Fatalf("a grant alone is stored as before: %q", s)
	}
	c := Credentials{Grant: "g", CFClientID: "id", CFClientSecret: "s", EntraRefreshToken: "r"}
	if got := ParseCredentials(c.String()); got != c {
		t.Fatalf("round trip: %+v", got)
	}
}
