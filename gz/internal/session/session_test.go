package session

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func source(t *testing.T, a *fakeadmin.Admin, secret string, c *clock) *GrantSource {
	t.Helper()
	client, err := NewClient(a.URL, http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	return NewGrantSource(client, a.URL, secret, c.now)
}

func TestTokenIsRenewedOnlyWhenMissingOrNearExpiry(t *testing.T) {
	a := fakeadmin.New()
	defer a.Close()
	c := &clock{time.Unix(1_800_000_000, 0)}
	a.Now = c.now
	src := source(t, a, fakeadmin.GrantSecret, c)
	ctx := context.Background()

	first, err := src.Token(ctx)
	if err != nil || first != "tok-1" {
		t.Fatalf("missing token not fetched: %q %v", first, err)
	}
	c.t = c.t.Add(10 * time.Minute) // 5 minutes left: still fresh
	if tok, _ := src.Token(ctx); tok != "tok-1" || a.TokensIssued != 1 {
		t.Fatalf("a fresh token was renewed: %q after %d issued", tok, a.TokensIssued)
	}
	c.t = c.t.Add(4*time.Minute + 30*time.Second) // 30 seconds left
	if tok, _ := src.Token(ctx); tok != "tok-2" {
		t.Fatalf("a token about to expire wasn't renewed: %q", tok)
	}
}

func TestExpiredOrRevokedGrantMeansSigningInAgain(t *testing.T) {
	a := fakeadmin.New()
	defer a.Close()
	a.Revoked["g-1"] = true
	_, err := source(t, a, fakeadmin.GrantSecret, &clock{time.Now()}).Token(context.Background())
	var e *output.Error
	if !errors.As(err, &e) || e.Exit != output.NeedsLogin || e.Hint != "Sign in again: gz auth login "+a.URL {
		t.Fatalf("got %#v", err)
	}
}

func TestWithTokenSendsTheHeader(t *testing.T) {
	a := fakeadmin.New()
	defer a.Close()
	src := source(t, a, fakeadmin.GrantSecret, &clock{time.Now()})
	client, err := NewClient(a.URL, http.DefaultClient, WithToken(src))
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.DeleteApiV1AuthGrantsIdWithResponse(context.Background(), "g-1", nil)
	if err != nil || res.StatusCode() != http.StatusNoContent || a.TokensSeen[0] != "tok-1" {
		t.Fatalf("status %v, err %v, tokens %v", res, err, a.TokensSeen)
	}
}

func TestProblemsMapToExitCodes(t *testing.T) {
	cases := []struct {
		p    Problem
		exit int
	}{
		{Problem{Status: 401, Code: "GRANT_EXPIRED"}, output.NeedsLogin},
		{Problem{Status: 403, Code: "ELEVATION_REQUIRED"}, output.NeedsLogin},
		{Problem{Status: 409, Code: "STALE"}, output.Conflict},
		{Problem{Status: 404, Code: "NOT_FOUND"}, output.NotFound},
		{Problem{Status: 418, Code: "SOMETHING_NEW"}, output.Failure},
		{Problem{Status: 401}, output.NeedsLogin},
	}
	for _, c := range cases {
		if got := c.p.Error().Exit; got != c.exit {
			t.Errorf("%+v: exit %d, want %d", c.p, got, c.exit)
		}
	}
	if msg := (Problem{Status: 418, Code: "SOMETHING_NEW", Detail: "new"}).Error().Message; msg != "new (SOMETHING_NEW)" {
		t.Errorf("an unknown code isn't kept: %q", msg)
	}
}

func TestGrantID(t *testing.T) {
	if GrantID("abc-1.secret.with.dots") != "abc-1" {
		t.Fatal(GrantID("abc-1.secret.with.dots"))
	}
}
