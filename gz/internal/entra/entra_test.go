package entra

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

func cfgFor(f *fakeadmin.Entra) Config {
	return Config{Authority: f.URL, Tenant: "contoso", ClientID: "gz-app", Scope: "api://admin/user_impersonation"}
}

func noSleep(now *time.Time, slept *[]time.Duration) func(context.Context, time.Duration) error {
	return func(ctx context.Context, d time.Duration) error {
		*slept = append(*slept, d)
		*now = now.Add(d)
		return ctx.Err()
	}
}

func TestDeviceCodeSignIn(t *testing.T) {
	f := fakeadmin.NewEntra()
	defer f.Close()
	now := time.Unix(1_800_000_000, 0)
	var slept []time.Duration
	d, err := Start(context.Background(), http.DefaultClient, cfgFor(f), now)
	if err != nil || d.UserCode != "WXYZ-1234" {
		t.Fatalf("%+v %v", d, err)
	}
	tok, err := d.Wait(context.Background(), http.DefaultClient, cfgFor(f), func() time.Time { return now }, noSleep(&now, &slept))
	if err != nil || tok.Access != "entra-access" || tok.Refresh != "entra-refresh" {
		t.Fatalf("%+v %v", tok, err)
	}
	if f.Polls != 2 || slept[0] != 5*time.Second {
		t.Fatalf("polled %d times, slept %v", f.Polls, slept)
	}
}

func TestDeclinedSignInExits3(t *testing.T) {
	f := fakeadmin.NewEntra()
	defer f.Close()
	f.Decision = "authorization_declined"
	now := time.Now()
	var slept []time.Duration
	d, _ := Start(context.Background(), http.DefaultClient, cfgFor(f), now)
	_, err := d.Wait(context.Background(), http.DefaultClient, cfgFor(f), func() time.Time { return now }, noSleep(&now, &slept))
	var e *output.Error
	if !errors.As(err, &e) || e.Exit != output.NeedsLogin {
		t.Fatalf("%v", err)
	}
}

func TestSourceRenewsAndSavesTheRotatedRefreshToken(t *testing.T) {
	f := fakeadmin.NewEntra()
	defer f.Close()
	now := time.Unix(1_800_000_000, 0)
	var saved []string
	src := NewSource(http.DefaultClient, cfgFor(f), Token{Refresh: "entra-refresh"}, func() time.Time { return now },
		func(r string) error { saved = append(saved, r); return nil })
	tok, err := src.Token(context.Background())
	if err != nil || tok != "entra-access-r1" || saved[0] != "entra-refresh-r1" {
		t.Fatalf("%q %v %v", tok, err, saved)
	}
	if tok, _ := src.Token(context.Background()); tok != "entra-access-r1" || f.Refreshes != 1 {
		t.Fatalf("a fresh token was renewed: %q after %d", tok, f.Refreshes)
	}
	now = now.Add(time.Hour)
	if tok, _ := src.Token(context.Background()); tok != "entra-access-r2" {
		t.Fatalf("an expired token wasn't renewed: %q", tok)
	}
}
