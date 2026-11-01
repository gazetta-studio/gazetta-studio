package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/api"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/entra"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/grant"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/login"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/version"
)

// skillHint ends a login (design-agent-access.md Q41).
const skillHint = "Using an AI agent? Run gz skill install <your agent's skills folder>."

// connection is a profile's way in: the login layer's credentials on every
// request, and a Gazetta token renewed from the grant (Q15, Q16).
type connection struct {
	// plain carries only the login layer's credentials: login, version and
	// token renewal go through it.
	plain *api.ClientWithResponses
	// tokens renews Gazetta tokens; nil before a grant exists.
	tokens *session.GrantSource
	// signedIn adds the Gazetta token; nil before a grant exists.
	signedIn *api.ClientWithResponses
}

// connect builds a profile's clients. Commands get these and never handle
// grants or platform secrets themselves.
func (ctx *context) connect(p profile.Profile, creds session.Credentials, entraToken *entra.Token) (connection, error) {
	var platform []session.Decorator
	switch p.Platform {
	case profile.PlatformCloudflare:
		platform = append(platform, session.CloudflareAccess(creds.CFClientID, creds.CFClientSecret))
	case profile.PlatformEntra:
		if p.Entra == nil {
			return connection{}, output.Errorf(output.NeedsLogin, "the profile %s has no Microsoft sign-in settings", p.Name).
				WithHint("Run gz auth login " + p.URL + " with --entra-tenant, --entra-client-id and --entra-scope.")
		}
		tok := entra.Token{Refresh: creds.EntraRefreshToken}
		if entraToken != nil {
			tok = *entraToken
		}
		save := func(refresh string) error {
			if p.Name == "" {
				return nil
			}
			creds.EntraRefreshToken = refresh
			return ctx.env.Grants().Set(p.Name, creds.String())
		}
		src := entra.NewSource(ctx.env.HTTP, ctx.entraConfig(p.Entra), tok, ctx.env.Now, save)
		platform = append(platform, session.WithBearerToken(src))
	}
	plain, err := session.NewClient(p.URL, ctx.env.HTTP, platform...)
	if err != nil {
		return connection{}, err
	}
	c := connection{plain: plain}
	if creds.Grant == "" {
		return c, nil
	}
	c.tokens = session.NewGrantSource(plain, p.URL, creds.Grant, ctx.env.Now)
	token := session.WithToken(c.tokens)
	if p.Platform == profile.PlatformALB {
		token = session.WithBearerToken(c.tokens)
	}
	c.signedIn, err = session.NewClient(p.URL, ctx.env.HTTP, append(platform, token)...)
	return c, err
}

func (ctx *context) entraConfig(e *profile.Entra) entra.Config {
	return entra.Config{Authority: ctx.env.EntraAuthority, Tenant: e.Tenant, ClientID: e.ClientID, Scope: e.Scope}
}

// credentials reads a profile's stored credentials; NeedsLogin when none.
func (ctx *context) credentials(p profile.Profile) (session.Credentials, error) {
	stored, err := ctx.env.Grants().Get(p.Name)
	if errors.Is(err, grant.ErrNotFound) {
		return session.Credentials{}, output.Errorf(output.NeedsLogin, "not signed in to %s", p.URL).WithHint("Run: gz auth login " + p.URL)
	}
	if err != nil {
		return session.Credentials{}, err
	}
	return session.ParseCredentials(stored), nil
}

// signedIn is a client whose requests carry the profile's credentials.
func (ctx *context) signedIn(p profile.Profile) (*api.ClientWithResponses, error) {
	creds, err := ctx.credentials(p)
	if err != nil {
		return nil, err
	}
	c, err := ctx.connect(p, creds, nil)
	if err != nil {
		return nil, err
	}
	return c.signedIn, nil
}

// loginPlatform reads the platform flags, falling back to the existing
// profile's platform when none is given (a re-login).
func (ctx *context) loginPlatform(existing profile.Profile, creds *session.Credentials) (profile.Profile, error) {
	p := profile.Profile{Platform: existing.Platform, Entra: existing.Entra}
	flag := func(name, env string) string {
		if v := ctx.flags[name]; v != "" {
			return v
		}
		if env != "" {
			return ctx.env.Getenv(env)
		}
		return ""
	}
	cfID, cfSecret := flag("--cf-client-id", "GZ_CF_ACCESS_CLIENT_ID"), flag("--cf-client-secret", "GZ_CF_ACCESS_CLIENT_SECRET")
	tenant, clientID, scope := flag("--entra-tenant", ""), flag("--entra-client-id", ""), flag("--entra-scope", "")
	paste := ctx.flags["--paste"] == "true"

	chosen := 0
	for _, on := range []bool{cfID != "" || cfSecret != "", tenant != "" || clientID != "" || scope != "", paste} {
		if on {
			chosen++
		}
	}
	if chosen > 1 {
		return p, output.Errorf(output.Usage, "use one of --cf-client-id, --entra-* or --paste")
	}
	switch {
	case cfID != "" || cfSecret != "":
		if cfID == "" || cfSecret == "" {
			return p, output.Errorf(output.Usage, "a Cloudflare service token needs both --cf-client-id and --cf-client-secret")
		}
		p.Platform, p.Entra = profile.PlatformCloudflare, nil
		creds.CFClientID, creds.CFClientSecret = cfID, cfSecret
	case tenant != "" || clientID != "" || scope != "":
		if tenant == "" || clientID == "" || scope == "" {
			return p, output.Errorf(output.Usage, "a Microsoft sign-in needs --entra-tenant, --entra-client-id and --entra-scope")
		}
		p.Platform, p.Entra = profile.PlatformEntra, &profile.Entra{Tenant: tenant, ClientID: clientID, Scope: scope}
	case paste:
		p.Platform, p.Entra = profile.PlatformALB, nil
	}
	return p, nil
}

func authLogin(ctx *context, args []string) error {
	adminURL := strings.TrimRight(args[0], "/")
	u, err := url.Parse(adminURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return output.Errorf(output.Usage, "%q isn't an admin URL", args[0]).WithHint("For example: gz auth login http://localhost:3000")
	}
	c, path, err := ctx.config()
	if err != nil {
		return err
	}
	name := ctx.flags["--name"]
	existing, hasExisting := c.Find(adminURL)
	if hasExisting && name == "" {
		name = existing.Name
	}
	if name == "" {
		name = u.Host
	}
	if other, ok := c.Find(name); ok && strings.TrimRight(other.URL, "/") != adminURL {
		return output.Errorf(output.Usage, "the profile %q is already %s", name, other.URL).WithHint("Pick another name with --name.")
	}

	// A re-login keeps the platform secrets already stored.
	var creds session.Credentials
	if hasExisting {
		if stored, err := ctx.env.Grants().Get(existing.Name); err == nil {
			creds = session.ParseCredentials(stored)
		}
	}
	creds.Grant = ""
	p, err := ctx.loginPlatform(existing, &creds)
	if err != nil {
		return err
	}
	p.Name, p.URL = name, adminURL

	var entraToken *entra.Token
	if p.Platform == profile.PlatformEntra {
		tok, err := ctx.entraSignIn(p.Entra)
		if err != nil {
			return err
		}
		entraToken, creds.EntraRefreshToken = &tok, tok.Refresh
	}
	conn, err := ctx.connect(p, creds, entraToken)
	if err != nil {
		return err
	}
	flow := &login.Flow{
		Client:     conn.plain,
		AdminURL:   adminURL,
		GzVersion:  version.String(),
		Status:     ctx.env.Stderr,
		Terminal:   ctx.env.Terminal,
		Open:       ctx.env.Open,
		Sleep:      ctx.env.Sleep,
		Now:        ctx.env.Now,
		PollPeriod: ctx.env.PollPeriod,
	}
	var res login.Result
	if p.Platform == profile.PlatformALB {
		res, err = ctx.pasteLogin(flow, p, creds)
	} else {
		flow.Machine, err = ctx.env.Hostname()
		if err != nil || flow.Machine == "" {
			flow.Machine = "unknown machine"
		}
		res, err = flow.Run(ctx.env.Ctx)
	}
	if err != nil {
		return err
	}
	creds.Grant = res.GrantSecret
	if err := ctx.env.Grants().Set(name, creds.String()); err != nil {
		return fmt.Errorf("storing the login: %w", err)
	}
	c.Put(p)
	if err := c.Save(path); err != nil {
		return err
	}
	text := fmt.Sprintf("Signed in to %s as profile %s.", adminURL, name)
	if c.Default == name {
		text += " It's your default admin."
	}
	return ctx.out.Result(text+"\n"+skillHint, map[string]any{
		"name": name, "url": adminURL, "default": c.Default == name, "grantId": res.GrantID,
	})
}

// entraSignIn runs Microsoft's device-code sign-in (Q15).
func (ctx *context) entraSignIn(e *profile.Entra) (entra.Token, error) {
	cfg := ctx.entraConfig(e)
	d, err := entra.Start(ctx.env.Ctx, ctx.env.HTTP, cfg, ctx.env.Now())
	if err != nil {
		return entra.Token{}, err
	}
	fmt.Fprintf(ctx.env.Stderr, "Sign in to Microsoft: open %s and enter %s\n", d.VerificationURI, d.UserCode)
	if ctx.env.Terminal && ctx.env.Open != nil {
		_ = ctx.env.Open(d.VerificationURI)
	}
	return d.Wait(ctx.env.Ctx, ctx.env.HTTP, cfg, ctx.env.Now, ctx.env.Sleep)
}

// pasteLogin reads a grant created on the admin's "Sign in a command line"
// page, behind ALB where a code can't be approved (Q15): from stdin, after
// a prompt when run in a terminal.
func (ctx *context) pasteLogin(flow *login.Flow, p profile.Profile, creds session.Credentials) (login.Result, error) {
	if err := flow.CheckVersion(ctx.env.Ctx); err != nil {
		return login.Result{}, err
	}
	if ctx.env.Terminal {
		fmt.Fprintf(ctx.env.Stderr, "Create a sign-in at %s/admin/cli-signin and paste it here: ", p.URL)
	}
	line, err := bufio.NewReader(ctx.env.Stdin).ReadString('\n')
	secret := strings.TrimSpace(line)
	if secret == "" {
		if err != nil && !errors.Is(err, io.EOF) {
			return login.Result{}, err
		}
		return login.Result{}, output.Errorf(output.NeedsLogin, "no sign-in was pasted").
			WithHint(fmt.Sprintf("Create one at %s/admin/cli-signin, then run: gz auth login %s --paste", p.URL, p.URL))
	}
	// Renewing a token proves the grant works before it's stored.
	creds.Grant = secret
	conn, err := ctx.connect(p, creds, nil)
	if err != nil {
		return login.Result{}, err
	}
	if _, err := conn.tokens.Token(ctx.env.Ctx); err != nil {
		var e *output.Error
		if errors.As(err, &e) && e.Exit == output.NeedsLogin {
			return login.Result{}, output.Errorf(output.NeedsLogin, "the pasted sign-in doesn't work on %s", p.URL).
				WithHint("Create a new one at " + p.URL + "/admin/cli-signin.")
		}
		return login.Result{}, err
	}
	return login.Result{GrantID: session.GrantID(secret), GrantSecret: secret}, nil
}

// loginState says whether a profile's grant still renews a token.
func (ctx *context) loginState(p profile.Profile) string {
	creds, err := ctx.credentials(p)
	var e *output.Error
	switch {
	case errors.As(err, &e) && e.Exit == output.NeedsLogin:
		return "signed-out"
	case err != nil:
		return "unknown"
	}
	conn, err := ctx.connect(p, creds, nil)
	if err != nil {
		return "unknown"
	}
	_, err = conn.tokens.Token(ctx.env.Ctx)
	switch {
	case err == nil:
		return "renews"
	case errors.As(err, &e) && e.Exit == output.NeedsLogin:
		return "expired"
	default:
		return "unreachable"
	}
}

var stateText = map[string]string{
	"renews":      "signed in",
	"expired":     "login expired or revoked",
	"signed-out":  "not signed in",
	"unreachable": "admin not reachable",
	"unknown":     "login can't be checked",
}

func authStatus(ctx *context, _ []string) error {
	c, _, err := ctx.config()
	if err != nil {
		return err
	}
	p, err := profile.Select(c, profile.Choice{Flag: ctx.g.admin, Env: ctx.env.Getenv("GZ_ADMIN"), Probe: ctx.env.Probe})
	if err != nil {
		return err
	}
	label := p.URL
	if p.Name != "" {
		label = p.Name + " (" + p.URL + ")"
	}
	type row struct {
		Name    string `json:"name"`
		URL     string `json:"url"`
		Default bool   `json:"default"`
		Login   string `json:"login"`
	}
	rows := make([]row, 0, len(c.Profiles))
	var b strings.Builder
	fmt.Fprintf(&b, "Using %s\n", label)
	for _, q := range c.Profiles {
		state := ctx.loginState(q)
		rows = append(rows, row{q.Name, q.URL, q.Name == c.Default, state})
		mark := " "
		if q.Name == c.Default {
			mark = "*"
		}
		fmt.Fprintf(&b, "%s %s  %s  %s\n", mark, q.Name, q.URL, stateText[state])
	}
	return ctx.out.Result(strings.TrimRight(b.String(), "\n"), map[string]any{
		"name": p.Name, "url": p.URL, "default": c.Default, "profiles": rows,
	})
}

func authLogout(ctx *context, args []string) error {
	c, path, err := ctx.config()
	if err != nil {
		return err
	}
	// The same order as every command: the name given, then --admin, then
	// GZ_ADMIN, then the default.
	name := c.Default
	for _, v := range []string{ctx.env.Getenv("GZ_ADMIN"), ctx.g.admin} {
		if v != "" {
			name = v
		}
	}
	if len(args) == 1 {
		name = args[0]
	}
	if name == "" {
		return output.Errorf(output.NotFound, "no profile to log out of").WithHint("See your profiles with: gz auth list")
	}
	p, ok := c.Find(name)
	if !ok {
		_, err := c.Remove(name)
		return err
	}
	revoked, note := ctx.revoke(p)
	if err := ctx.env.Grants().Delete(p.Name); err != nil {
		return err
	}
	if _, err := c.Remove(p.Name); err != nil {
		return err
	}
	if err := c.Save(path); err != nil {
		return err
	}
	text := "Logged out of " + p.Name
	if note != "" {
		text += "\n" + note
	}
	return ctx.out.Result(text, map[string]any{"removed": p.Name, "default": c.Default, "revoked": revoked})
}

// revoke ends the profile's grant on the admin. When that can't be done,
// the note says the login stays valid there until revoked or expired.
func (ctx *context) revoke(p profile.Profile) (bool, string) {
	secret, err := ctx.env.Grants().Get(p.Name)
	if errors.Is(err, grant.ErrNotFound) {
		return false, ""
	}
	if err != nil {
		return false, "Couldn't read the stored login, so it wasn't revoked on the admin."
	}
	stays := fmt.Sprintf("Couldn't revoke the login on %s: it stays valid there until it's revoked in the admin or expires.", p.URL)
	client, err := ctx.signedIn(p)
	if err != nil {
		return false, stays
	}
	res, err := client.DeleteApiV1AuthGrantsIdWithResponse(ctx.env.Ctx, session.GrantID(session.ParseCredentials(secret).Grant))
	if err != nil {
		var e *output.Error
		// The grant no longer renews: it's expired or revoked already.
		if errors.As(err, &e) && e.Exit == output.NeedsLogin {
			return false, ""
		}
		return false, stays
	}
	if res.StatusCode() >= 300 && res.StatusCode() != 404 {
		return false, stays
	}
	return res.StatusCode() < 300, ""
}
