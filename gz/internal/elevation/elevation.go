// Package elevation starts, waits for and ends elevations (design-agent-
// access.md Q12, Q17, Q29): a token publishes or deletes only while its
// person has approved a short elevation in the admin. `gz publish` and
// `gz elevate` both go through Flow; neither polls itself.
package elevation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/api"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/login"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/state"
)

// Scopes an elevation covers; production needs its own (Q17).
const (
	NonProduction = "non-production"
	Production    = "production"
)

// Flow asks the person for an elevation.
type Flow struct {
	// Client is signed in: starting an elevation needs the token.
	Client   *api.ClientWithResponses
	AdminURL string
	// Status gets the code and the link, for the person.
	Status io.Writer
	// Wait for the approval; otherwise print the code and stop (exit 3).
	Wait     bool
	Terminal bool
	Open     func(url string) error
	Sleep    func(ctx context.Context, d time.Duration) error
	Now      func() time.Time
	Period   time.Duration
}

// Start asks for an elevation of scope and, with Wait, waits for the person
// to approve it in the admin, for up to the code's 10 minutes (Q21).
func (f *Flow) Start(ctx context.Context, scope string) (state.Elevation, error) {
	body, _ := json.Marshal(map[string]string{"scope": scope})
	res, err := f.Client.PostApiV1AuthElevationsWithBodyWithResponse(ctx, nil, "application/json", bytes.NewReader(body))
	if err != nil {
		return state.Elevation{}, output.Errorf(output.Failure, "can't reach %s: %v", f.AdminURL, err)
	}
	if res.StatusCode() != http.StatusCreated {
		return state.Elevation{}, session.ProblemOf(res.HTTPResponse, res.Body).Error()
	}
	var started struct {
		Code       string `json:"code"`
		ApproveURL string `json:"approveUrl"`
		PollSecret string `json:"pollSecret"`
		ExpiresAt  string `json:"expiresAt"`
	}
	if err := json.Unmarshal(res.Body, &started); err != nil {
		return state.Elevation{}, output.Errorf(output.Failure, "%s answered an elevation gz can't read", f.AdminURL)
	}
	fmt.Fprintf(f.Status, "This needs a %s elevation. Your code: %s\nApprove it in the admin: %s\n", scope, started.Code, started.ApproveURL)
	if !f.Wait {
		return state.Elevation{}, output.Errorf(output.NeedsLogin, "the elevation isn't approved yet").
			WithHint("Approve it in the admin, then run the command again.")
	}
	fmt.Fprintln(f.Status, "Check that the code there matches. Waiting for approval…")
	if f.Terminal && f.Open != nil {
		_ = f.Open(started.ApproveURL)
	}
	got, err := login.Await(ctx, login.Poll{
		Client: f.Client, AdminURL: f.AdminURL, Code: started.Code, PollSecret: started.PollSecret,
		ExpiresAt: started.ExpiresAt, What: "elevation", Sleep: f.Sleep, Now: f.Now, Period: f.Period,
	})
	if err != nil {
		return state.Elevation{}, err
	}
	if got.Status != "elevated" {
		return state.Elevation{}, output.Errorf(output.Failure, "%s answered an unexpected elevation state %q", f.AdminURL, got.Status)
	}
	ends, err := time.Parse(time.RFC3339, got.EndsAt)
	if err != nil {
		return state.Elevation{}, output.Errorf(output.Failure, "%s answered an end time gz can't read: %q", f.AdminURL, got.EndsAt)
	}
	return state.Elevation{ID: got.ElevationID, Scope: scope, EndsAt: ends}, nil
}

// End ends an elevation now. One that already ended counts as ended.
func (f *Flow) End(ctx context.Context, id string) error {
	res, err := f.Client.DeleteApiV1AuthElevationsIdWithResponse(ctx, id, nil)
	if err != nil {
		return output.Errorf(output.Failure, "can't reach %s: %v", f.AdminURL, err)
	}
	if res.StatusCode() == http.StatusNoContent || res.StatusCode() == http.StatusNotFound {
		return nil
	}
	return session.ProblemOf(res.HTTPResponse, res.Body).Error()
}
