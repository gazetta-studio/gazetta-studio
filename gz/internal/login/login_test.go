package login

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
)

type fake struct {
	now    time.Time
	sleeps []time.Duration
	opened []string
	status bytes.Buffer
}

func flow(t *testing.T, a *fakeadmin.Admin, f *fake, terminal bool) *Flow {
	t.Helper()
	client, err := session.NewClient(a.URL, http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	a.Now = func() time.Time { return f.now }
	return &Flow{
		Client: client, AdminURL: a.URL, GzVersion: "0.9.0", Machine: "laptop",
		Status: &f.status, Terminal: terminal,
		Open: func(u string) error { f.opened = append(f.opened, u); return nil },
		Sleep: func(ctx context.Context, d time.Duration) error {
			f.sleeps = append(f.sleeps, d)
			f.now = f.now.Add(d)
			return ctx.Err()
		},
		Now:        func() time.Time { return f.now },
		PollPeriod: 2 * time.Second,
	}
}

func exitOf(t *testing.T, err error) int {
	t.Helper()
	var e *output.Error
	if !errors.As(err, &e) {
		t.Fatalf("not a gz error: %v", err)
	}
	return e.Exit
}

func TestApprovedLoginReturnsTheGrant(t *testing.T) {
	a := fakeadmin.New()
	defer a.Close()
	a.PendingPolls = 2
	f := &fake{now: time.Unix(1_800_000_000, 0)}
	res, err := flow(t, a, f, true).Run(context.Background())
	if err != nil || res.GrantSecret != fakeadmin.GrantSecret || res.GrantID != "g-1" {
		t.Fatalf("%+v %v", res, err)
	}
	if a.Polls != 3 || len(f.sleeps) != 3 || f.sleeps[0] != 2*time.Second {
		t.Fatalf("polled %d times, slept %v", a.Polls, f.sleeps)
	}
	if a.Machines[0] != "laptop" || len(f.opened) != 1 || !strings.HasSuffix(f.opened[0], "/admin/cli-login/ABCD-EFGH") {
		t.Fatalf("machine %v, opened %v", a.Machines, f.opened)
	}
	if !strings.Contains(f.status.String(), "ABCD-EFGH") {
		t.Fatalf("the code isn't shown: %q", f.status.String())
	}
}

func TestOutsideATerminalItPrintsAndWaitsWithoutABrowser(t *testing.T) {
	a := fakeadmin.New()
	defer a.Close()
	f := &fake{now: time.Now()}
	if _, err := flow(t, a, f, false).Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.opened) != 0 || !strings.Contains(f.status.String(), "/admin/cli-login/ABCD-EFGH") {
		t.Fatalf("opened %v, printed %q", f.opened, f.status.String())
	}
}

func TestDeniedExpiredAndCancelledExit3(t *testing.T) {
	for _, decision := range []string{"denied", "expired"} {
		a := fakeadmin.New()
		a.Decision = decision
		_, err := flow(t, a, &fake{now: time.Now()}, false).Run(context.Background())
		if exitOf(t, err) != output.NeedsLogin {
			t.Errorf("%s: %v", decision, err)
		}
		a.Close()
	}

	// The code runs out while gz waits.
	a := fakeadmin.New()
	defer a.Close()
	a.PendingPolls = 1 << 30
	a.CodeTTL = 10 * time.Second
	f := &fake{now: time.Now()}
	_, err := flow(t, a, f, false).Run(context.Background())
	if exitOf(t, err) != output.NeedsLogin || !strings.Contains(err.Error(), "expired") || a.Polls != 5 {
		t.Errorf("timeout: %v after %d polls", err, a.Polls)
	}

	// Ctrl+C.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b := fakeadmin.New()
	defer b.Close()
	_, err = flow(t, b, &fake{now: time.Now()}, false).Run(ctx)
	if exitOf(t, err) != output.NeedsLogin || !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("cancel: %v", err)
	}
}

func TestVersionCheck(t *testing.T) {
	cases := []struct {
		majors  []string
		wantErr string
	}{
		{[]string{"v1"}, ""},
		{[]string{"v0"}, "Upgrade gazetta on the admin."},
		{[]string{"v2"}, "Upgrade gz."},
	}
	for _, c := range cases {
		a := fakeadmin.New()
		a.Majors = c.majors
		err := flow(t, a, &fake{now: time.Now()}, false).CheckVersion(context.Background())
		a.Close()
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%v: %v", c.majors, err)
			}
			continue
		}
		var e *output.Error
		if !errors.As(err, &e) || e.Exit != output.Failure || e.Hint != c.wantErr ||
			!strings.Contains(e.Message, "0.9.0") || !strings.Contains(e.Message, "speaks API v1") || !strings.Contains(e.Message, c.majors[0]) {
			t.Errorf("%v: %#v", c.majors, err)
		}
	}
}
