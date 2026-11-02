// Package login signs gz in to an admin (design-agent-access.md Q12, Q21,
// Q43): it checks the admin's API majors, starts a login, shows the code
// and the approve link, and waits for the person to approve it in the
// browser.
package login

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/api"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
)

// Major is the API major this gz speaks (Q42).
const Major = "v1"

// PollInterval is how often gz asks whether the code was approved.
const PollInterval = 2 * time.Second

// Flow is one login. Its fields let tests drive time and the terminal.
type Flow struct {
	Client     *api.ClientWithResponses
	AdminURL   string
	GzVersion  string
	Machine    string
	Status     io.Writer // progress for the person: the code and link
	Terminal   bool      // run in a terminal: open the browser
	Open       func(url string) error
	Sleep      func(ctx context.Context, d time.Duration) error
	Now        func() time.Time
	PollPeriod time.Duration
}

// Result is a completed login.
type Result struct {
	GrantID     string
	GrantSecret string
}

// CheckVersion fails unless the admin serves the major this gz speaks,
// naming both sides and which one to upgrade.
func (f *Flow) CheckVersion(ctx context.Context) error {
	res, err := f.Client.GetApiVersionWithResponse(ctx)
	if err != nil {
		return output.Errorf(output.Failure, "can't reach %s: %v", f.AdminURL, err)
	}
	if res.JSON200 == nil {
		if res.StatusCode() == http.StatusNotFound {
			return output.Errorf(output.Failure, "%s has no Gazetta API, or one older than %s", f.AdminURL, Major).
				WithHint("Check the URL, or upgrade gazetta on the admin.")
		}
		return session.ProblemOf(res.HTTPResponse, res.Body).Error()
	}
	majors := res.JSON200.Majors
	if slices.Contains(majors, Major) {
		return nil
	}
	served := strings.Join(majors, ", ")
	upgrade := "gazetta on the admin"
	if len(majors) > 0 && majorNumber(majors[0]) > majorNumber(Major) {
		upgrade = "gz"
	}
	return output.Errorf(output.Failure, "gz %s speaks API %s, but %s serves %s", f.GzVersion, Major, f.AdminURL, served).
		WithHint("Upgrade " + upgrade + ".")
}

func majorNumber(m string) int {
	n := 0
	fmt.Sscanf(strings.TrimPrefix(m, "v"), "%d", &n)
	return n
}

// Run starts a login and waits until it's approved, denied or expired.
// Ctrl+C at any point is a cancelled login (exit 3).
func (f *Flow) Run(ctx context.Context) (Result, error) {
	res, err := f.run(ctx)
	if err != nil && ctx.Err() != nil {
		return Result{}, cancelled(ctx.Err())
	}
	return res, err
}

func (f *Flow) run(ctx context.Context) (Result, error) {
	if err := f.CheckVersion(ctx); err != nil {
		return Result{}, err
	}
	start, err := f.Client.PostApiV1AuthLoginsWithResponse(ctx, nil, api.PostApiV1AuthLoginsJSONRequestBody{Machine: f.Machine})
	if err != nil {
		return Result{}, output.Errorf(output.Failure, "can't reach %s: %v", f.AdminURL, err)
	}
	if start.JSON201 == nil {
		return Result{}, session.ProblemOf(start.HTTPResponse, start.Body).Error()
	}
	s := start.JSON201
	fmt.Fprintf(f.Status, "Your code: %s\nApprove it in the admin: %s\nCheck that the code there matches. Waiting for approval…\n", s.Code, s.ApproveUrl)
	if f.Terminal && f.Open != nil {
		_ = f.Open(s.ApproveUrl)
	}
	got, err := Await(ctx, Poll{
		Client: f.Client, AdminURL: f.AdminURL, Code: s.Code, PollSecret: s.PollSecret, ExpiresAt: s.ExpiresAt,
		What: "login", Sleep: f.Sleep, Now: f.Now, Period: f.PollPeriod,
	})
	if err != nil {
		return Result{}, err
	}
	if got.Status != "approved" {
		return Result{}, output.Errorf(output.Failure, "%s answered an unexpected login state %q", f.AdminURL, got.Status)
	}
	return Result{GrantID: got.GrantID, GrantSecret: got.GrantSecret}, nil
}

// Poll is a started code to wait on: a login, or an elevation (Q17), which
// the admin answers through the same redeem route.
type Poll struct {
	Client                      *api.ClientWithResponses
	AdminURL                    string
	Code, PollSecret, ExpiresAt string
	What                        string // "login" or "elevation", for messages
	Sleep                       func(ctx context.Context, d time.Duration) error
	Now                         func() time.Time
	Period                      time.Duration
}

// Redeemed is what an approved code answered.
type Redeemed struct {
	Status      string `json:"status"` // "approved" (a login) or "elevated"
	GrantID     string `json:"grantId"`
	GrantSecret string `json:"grantSecret"`
	ElevationID string `json:"elevationId"`
	EndsAt      string `json:"endsAt"`
}

// Await polls until the person approves or denies the code, or it expires.
// Denied and expired exit 3 (Q38).
func Await(ctx context.Context, p Poll) (Redeemed, error) {
	expires, err := time.Parse(time.RFC3339, p.ExpiresAt)
	if err != nil {
		return Redeemed{}, output.Errorf(output.Failure, "%s answered an expiry gz can't read: %q", p.AdminURL, p.ExpiresAt)
	}
	for {
		if !p.Now().Before(expires) {
			return Redeemed{}, expiredCode(p.What)
		}
		if err := p.Sleep(ctx, p.Period); err != nil {
			return Redeemed{}, cancelled(err)
		}
		r, err := p.Client.PostApiV1AuthLoginsCodeRedeemWithResponse(ctx, p.Code, nil, api.PostApiV1AuthLoginsCodeRedeemJSONRequestBody{PollSecret: p.PollSecret})
		if err != nil {
			return Redeemed{}, output.Errorf(output.Failure, "can't reach %s: %v", p.AdminURL, err)
		}
		if r.StatusCode() != http.StatusOK {
			prob := session.ProblemOf(r.HTTPResponse, r.Body)
			switch prob.Code {
			case "LOGIN_DENIED":
				return Redeemed{}, output.Errorf(output.NeedsLogin, "the %s was denied in the admin", p.What)
			case "LOGIN_EXPIRED":
				return Redeemed{}, expiredCode(p.What)
			}
			return Redeemed{}, prob.Error()
		}
		var got Redeemed
		if err := json.Unmarshal(r.Body, &got); err != nil {
			return Redeemed{}, output.Errorf(output.Failure, "%s answered a %s gz can't read", p.AdminURL, p.What)
		}
		if got.Status != "pending" {
			return got, nil
		}
	}
}

func expiredCode(what string) error {
	hint := "Run gz auth login again."
	if what != "login" {
		hint = "Run the command again for a new code."
	}
	return output.Errorf(output.NeedsLogin, "the code expired before it was approved").WithHint(hint)
}

func cancelled(err error) error {
	if errors.Is(err, context.Canceled) {
		return output.Errorf(output.NeedsLogin, "login cancelled")
	}
	return output.Errorf(output.NeedsLogin, "login stopped: %v", err)
}

// SleepContext waits d, or until ctx ends.
func SleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
