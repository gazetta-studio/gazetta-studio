// Package fakeadmin is an in-memory admin for gz's tests: the version and
// CLI login routes, answering as the real admin does.
package fakeadmin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"
)

// Admin is the fake's state; tests change it between requests.
type Admin struct {
	*httptest.Server

	mu sync.Mutex
	// Majors is what GET /api/version answers.
	Majors []string
	// Decision is what redeem answers once the login has been polled
	// PendingPolls times: "approved", "denied" or "expired".
	Decision     string
	PendingPolls int
	// CodeTTL is how long a started code lives.
	CodeTTL time.Duration
	// TokenTTL is the lifetime of issued tokens.
	TokenTTL time.Duration
	Now      func() time.Time

	Polls, TokensIssued int
	Machines            []string
	Revoked             map[string]bool
	TokensSeen          []string // the Gazetta token on authenticated calls
	// Headers holds every request's headers, in order.
	Headers []http.Header
}

const grantID = "g-1"

// GrantSecret is the secret an approved login hands out.
const GrantSecret = grantID + ".s3cret"

// New starts a fake admin that approves logins on the first poll.
func New() *Admin {
	a := &Admin{
		Majors: []string{"v1"}, Decision: "approved", CodeTTL: 10 * time.Minute,
		TokenTTL: 15 * time.Minute, Now: time.Now, Revoked: map[string]bool{},
	}
	a.Server = httptest.NewServer(http.HandlerFunc(a.serve))
	return a
}

func problem(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"type":"about:blank","title":%q,"status":%d,"code":%q,"detail":"fake %s"}`,
		http.StatusText(status), status, code, code)
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (a *Admin) token() map[string]any {
	a.TokensIssued++
	return map[string]any{
		"token":     fmt.Sprintf("tok-%d", a.TokensIssued),
		"expiresAt": a.Now().Add(a.TokenTTL).Unix(),
	}
}

func (a *Admin) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.Headers = append(a.Headers, r.Header.Clone())
	path := strings.TrimPrefix(r.URL.Path, "/admin")
	switch {
	case r.Method == "GET" && path == "/api/version":
		reply(w, 200, map[string]any{"majors": a.Majors})
	case r.Method == "POST" && path == "/api/v1/auth/logins":
		var body struct{ Machine string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		a.Machines = append(a.Machines, body.Machine)
		reply(w, 201, map[string]any{
			"code": "ABCD-EFGH", "approveUrl": a.URL + "/admin/cli-login/ABCD-EFGH", "pollSecret": "poll",
			"expiresAt": a.Now().Add(a.CodeTTL).UTC().Format(time.RFC3339),
		})
	case r.Method == "POST" && path == "/api/v1/auth/logins/ABCD-EFGH/redeem":
		a.Polls++
		if a.Polls <= a.PendingPolls {
			reply(w, 200, map[string]any{"status": "pending"})
			return
		}
		switch a.Decision {
		case "denied":
			problem(w, 403, "LOGIN_DENIED")
		case "expired":
			problem(w, 410, "LOGIN_EXPIRED")
		default:
			body := a.token()
			body["status"], body["grantId"], body["grantSecret"] = "approved", grantID, GrantSecret
			reply(w, 200, body)
		}
	case r.Method == "POST" && path == "/api/v1/auth/tokens":
		var body struct{ GrantSecret string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		id, _, _ := strings.Cut(body.GrantSecret, ".")
		switch {
		case body.GrantSecret != GrantSecret:
			problem(w, 401, "GRANT_INVALID")
		case a.Revoked[id]:
			problem(w, 401, "GRANT_EXPIRED")
		default:
			reply(w, 200, a.token())
		}
	case r.Method == "DELETE" && path == "/api/v1/auth/grants/"+grantID:
		tok := r.Header.Get("Gazetta-Token")
		if tok == "" {
			tok = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		a.TokensSeen = append(a.TokensSeen, tok)
		if tok == "" {
			problem(w, 401, "TOKEN_REQUIRED")
			return
		}
		a.Revoked[grantID] = true
		w.WriteHeader(http.StatusNoContent)
	default:
		problem(w, 404, "NOT_FOUND")
	}
}

// Set changes the fake's state under its lock.
func (a *Admin) Set(f func(a *Admin)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f(a)
}

// Entra is a fake Microsoft Entra token endpoint for the device-code flow:
// the first poll is pending, the second signs in; refreshes rotate the
// refresh token.
type Entra struct {
	*httptest.Server

	mu        sync.Mutex
	Polls     int
	Refreshes int
	// Decision is what the second poll answers: "" signs in, else the error.
	Decision string
	// RefuseRefresh makes refreshes answer invalid_grant, as a lapsed session does.
	RefuseRefresh bool
}

// NewEntra starts the fake.
func NewEntra() *Entra {
	e := &Entra{}
	e.Server = httptest.NewServer(http.HandlerFunc(e.serve))
	return e
}

func (e *Entra) serve(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = r.ParseForm()
	switch {
	case strings.HasSuffix(r.URL.Path, "/oauth2/v2.0/devicecode"):
		reply(w, 200, map[string]any{
			"device_code": "dev-code", "user_code": "WXYZ-1234", "verification_uri": "https://microsoft.com/devicelogin",
			"expires_in": 900, "interval": 5, "message": "To sign in, use a web browser",
		})
	case strings.HasSuffix(r.URL.Path, "/oauth2/v2.0/token") && r.Form.Get("grant_type") == "refresh_token":
		if e.RefuseRefresh {
			reply(w, 400, map[string]any{"error": "invalid_grant", "error_description": "the session expired"})
			return
		}
		e.Refreshes++
		reply(w, 200, map[string]any{
			"access_token": fmt.Sprintf("entra-access-r%d", e.Refreshes), "expires_in": 3600,
			"refresh_token": fmt.Sprintf("entra-refresh-r%d", e.Refreshes),
		})
	case strings.HasSuffix(r.URL.Path, "/oauth2/v2.0/token"):
		e.Polls++
		if e.Polls == 1 {
			reply(w, 400, map[string]any{"error": "authorization_pending"})
			return
		}
		if e.Decision != "" {
			reply(w, 400, map[string]any{"error": e.Decision, "error_description": "fake " + e.Decision})
			return
		}
		reply(w, 200, map[string]any{"access_token": "entra-access", "refresh_token": "entra-refresh", "expires_in": 3600})
	default:
		w.WriteHeader(404)
	}
}
