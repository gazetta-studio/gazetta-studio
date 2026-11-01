// Package session gives commands an HTTP client signed in to an admin
// (design-agent-access.md Q15, Q16): a token source renews short-lived
// Gazetta tokens from the stored grant, and request decorators add the
// credentials each request carries. Per-platform credentials (cut 9) are
// further decorators; commands never handle grants themselves.
package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/api"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

// TokenHeader carries the Gazetta token (Q15).
const TokenHeader = "Gazetta-Token"

// renewBefore is how long before expiry a token is renewed, so a request
// never leaves with one about to lapse.
const renewBefore = 60 * time.Second

// APIBase is where an admin's API lives, below the admin URL.
func APIBase(adminURL string) string { return strings.TrimRight(adminURL, "/") + "/admin" }

// Decorator adds credentials to a request.
type Decorator = api.RequestEditorFn

// TokenSource hands out a valid Gazetta token.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// WithToken sends src's token in the Gazetta-Token header.
func WithToken(src TokenSource) Decorator {
	return func(ctx context.Context, req *http.Request) error {
		tok, err := src.Token(ctx)
		if err != nil {
			return err
		}
		req.Header.Set(TokenHeader, tok)
		return nil
	}
}

// NewClient is a client for the admin at adminURL whose requests pass
// through decorators, in order.
func NewClient(adminURL string, httpClient *http.Client, decorators ...Decorator) (*api.ClientWithResponses, error) {
	opts := []api.ClientOption{api.WithHTTPClient(httpClient)}
	for _, d := range decorators {
		opts = append(opts, api.WithRequestEditorFn(d))
	}
	return api.NewClientWithResponses(APIBase(adminURL), opts...)
}

// GrantSource renews tokens from a grant secret, keeping the current token
// in memory only.
type GrantSource struct {
	client      *api.ClientWithResponses
	grantSecret string
	now         func() time.Time
	adminURL    string

	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewGrantSource renews tokens for grantSecret from the admin at adminURL.
// client must not carry WithToken itself.
func NewGrantSource(client *api.ClientWithResponses, adminURL, grantSecret string, now func() time.Time) *GrantSource {
	return &GrantSource{client: client, grantSecret: grantSecret, now: now, adminURL: adminURL}
}

// Token returns the current token, renewing it when missing or close to
// expiry. An expired or revoked grant means signing in again (exit 3).
func (s *GrantSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && s.now().Add(renewBefore).Before(s.expires) {
		return s.token, nil
	}
	res, err := s.client.PostApiV1AuthTokensWithResponse(ctx, nil, api.PostApiV1AuthTokensJSONRequestBody{GrantSecret: s.grantSecret})
	if err != nil {
		// A request decorator's own error (a lapsed Entra sign-in) says
		// what to do; only a transport failure means the admin is out of reach.
		var e *output.Error
		if errors.As(err, &e) {
			return "", e
		}
		return "", output.Errorf(output.Failure, "can't reach %s: %v", s.adminURL, err)
	}
	if res.StatusCode() != http.StatusOK {
		p := ProblemOf(res.HTTPResponse, res.Body)
		e := p.Error()
		if e.Exit == output.NeedsLogin {
			e = output.Errorf(output.NeedsLogin, "your login to %s has expired or was revoked", s.adminURL).
				WithHint("Sign in again: gz auth login " + s.adminURL)
		}
		return "", e
	}
	var body struct {
		Token     string  `json:"token"`
		ExpiresAt float64 `json:"expiresAt"`
	}
	if err := json.Unmarshal(res.Body, &body); err != nil || body.Token == "" {
		return "", output.Errorf(output.Failure, "%s answered a token renewal gz can't read", s.adminURL)
	}
	s.token = body.Token
	s.expires = time.Unix(int64(body.ExpiresAt), 0)
	return s.token, nil
}

// GrantID is the grant a grant secret belongs to: `<grantId>.<secret>`.
func GrantID(grantSecret string) string {
	id, _, _ := strings.Cut(grantSecret, ".")
	return id
}
