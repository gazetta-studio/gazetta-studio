// Package entra signs gz in to Microsoft Entra ID with the device-code
// flow, for admins behind Azure App Service Easy Auth (design-agent-access.md
// Q15). The operator registers a public client app for gz; gz asks for a
// scope the admin's own app registration exposes, and sends the access
// token in Authorization, which Easy Auth validates.
//
// Endpoints: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
package entra

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

// DefaultAuthority is Entra's sign-in host.
const DefaultAuthority = "https://login.microsoftonline.com"

// Config is the operator's gz app registration and the admin's scope.
type Config struct {
	Authority string // DefaultAuthority unless a test or sovereign cloud sets it
	Tenant    string // tenant id or domain
	ClientID  string // the gz app registration
	Scope     string // e.g. api://<admin-app-id>/user_impersonation
}

func (c Config) endpoint(path string) string {
	a := c.Authority
	if a == "" {
		a = DefaultAuthority
	}
	return strings.TrimRight(a, "/") + "/" + url.PathEscape(c.Tenant) + "/oauth2/v2.0/" + path
}

// scopes asks for a refresh token too, so gz stays signed in.
func (c Config) scopes() string { return c.Scope + " offline_access" }

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

func post(ctx context.Context, client *http.Client, endpoint string, form url.Values, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, err
	}
	return res.StatusCode, json.Unmarshal(body, out)
}

// DeviceLogin is a device-code sign-in in progress.
type DeviceLogin struct {
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	Message         string `json:"message"`
	deviceCode      string
	interval        time.Duration
	expires         time.Time
}

// Start begins a device-code sign-in.
func Start(ctx context.Context, client *http.Client, cfg Config, now time.Time) (*DeviceLogin, error) {
	var body struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
		Message         string `json:"message"`
		Error           string `json:"error"`
		Description     string `json:"error_description"`
	}
	status, err := post(ctx, client, cfg.endpoint("devicecode"), url.Values{"client_id": {cfg.ClientID}, "scope": {cfg.scopes()}}, &body)
	if err != nil {
		return nil, output.Errorf(output.Failure, "can't reach Microsoft Entra: %v", err)
	}
	if status != http.StatusOK || body.DeviceCode == "" {
		return nil, output.Errorf(output.Failure, "Microsoft Entra refused the sign-in: %s", describe(body.Error, body.Description))
	}
	interval := time.Duration(body.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return &DeviceLogin{
		UserCode: body.UserCode, VerificationURI: body.VerificationURI, Message: body.Message,
		deviceCode: body.DeviceCode, interval: interval, expires: now.Add(time.Duration(body.ExpiresIn) * time.Second),
	}, nil
}

// Token is an Entra access token and the refresh token that renews it.
type Token struct {
	Access  string
	Refresh string
	Expires time.Time
}

// Wait polls until the person signs in, declines or the code expires.
func (d *DeviceLogin) Wait(ctx context.Context, client *http.Client, cfg Config, now func() time.Time,
	sleep func(context.Context, time.Duration) error) (Token, error) {
	interval := d.interval
	for {
		if !now().Before(d.expires) {
			return Token{}, output.Errorf(output.NeedsLogin, "the Microsoft sign-in code expired").WithHint("Run gz auth login again.")
		}
		if err := sleep(ctx, interval); err != nil {
			return Token{}, output.Errorf(output.NeedsLogin, "login cancelled")
		}
		var body tokenResponse
		_, err := post(ctx, client, cfg.endpoint("token"), url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"client_id":   {cfg.ClientID},
			"device_code": {d.deviceCode},
		}, &body)
		if err != nil {
			if ctx.Err() != nil {
				return Token{}, output.Errorf(output.NeedsLogin, "login cancelled")
			}
			return Token{}, output.Errorf(output.Failure, "can't reach Microsoft Entra: %v", err)
		}
		switch body.Error {
		case "":
			return Token{Access: body.AccessToken, Refresh: body.RefreshToken, Expires: now().Add(time.Duration(body.ExpiresIn) * time.Second)}, nil
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		case "authorization_declined":
			return Token{}, output.Errorf(output.NeedsLogin, "the Microsoft sign-in was declined")
		case "expired_token":
			return Token{}, output.Errorf(output.NeedsLogin, "the Microsoft sign-in code expired").WithHint("Run gz auth login again.")
		default:
			return Token{}, output.Errorf(output.Failure, "Microsoft Entra refused the sign-in: %s", describe(body.Error, body.Description))
		}
	}
}

func describe(code, description string) string {
	if description != "" {
		return fmt.Sprintf("%s (%s)", strings.SplitN(description, "\r\n", 2)[0], code)
	}
	if code == "" {
		return "no error code"
	}
	return code
}

// Source hands out Entra access tokens, renewing them from the refresh
// token. Entra rotates refresh tokens, so Save stores each new one.
type Source struct {
	HTTP *http.Client
	Cfg  Config
	Now  func() time.Time
	Save func(refresh string) error

	mu      sync.Mutex
	refresh string
	access  string
	expires time.Time
}

// NewSource renews from refresh; access may be empty.
func NewSource(client *http.Client, cfg Config, t Token, now func() time.Time, save func(string) error) *Source {
	return &Source{HTTP: client, Cfg: cfg, Now: now, Save: save, refresh: t.Refresh, access: t.Access, expires: t.Expires}
}

// Token returns a valid Entra access token.
func (s *Source) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.access != "" && s.Now().Add(time.Minute).Before(s.expires) {
		return s.access, nil
	}
	var body tokenResponse
	_, err := post(ctx, s.HTTP, s.Cfg.endpoint("token"), url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {s.Cfg.ClientID},
		"refresh_token": {s.refresh},
		"scope":         {s.Cfg.scopes()},
	}, &body)
	if err != nil {
		return "", output.Errorf(output.Failure, "can't reach Microsoft Entra: %v", err)
	}
	if body.Error != "" || body.AccessToken == "" {
		return "", output.Errorf(output.NeedsLogin, "your Microsoft sign-in has expired: %s", describe(body.Error, body.Description))
	}
	s.access, s.expires = body.AccessToken, s.Now().Add(time.Duration(body.ExpiresIn)*time.Second)
	if body.RefreshToken != "" && body.RefreshToken != s.refresh {
		s.refresh = body.RefreshToken
		if s.Save != nil {
			if err := s.Save(s.refresh); err != nil {
				return "", fmt.Errorf("storing the renewed Microsoft sign-in: %w", err)
			}
		}
	}
	return s.access, nil
}
