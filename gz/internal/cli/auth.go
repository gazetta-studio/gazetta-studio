package cli

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/api"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/grant"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/login"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/version"
)

// skillHint ends a login (design-agent-access.md Q41).
const skillHint = "Using an AI agent? Run gz skill install <your agent's skills folder>."

// client is an unauthenticated client for the admin at adminURL.
func (ctx *context) client(adminURL string) (*api.ClientWithResponses, error) {
	return session.NewClient(adminURL, ctx.env.HTTP)
}

// signedIn is a client whose requests carry a Gazetta token renewed from
// the profile's grant (Q15, Q16).
func (ctx *context) signedIn(p profile.Profile) (*api.ClientWithResponses, error) {
	secret, err := ctx.env.Grants().Get(p.Name)
	if errors.Is(err, grant.ErrNotFound) {
		return nil, output.Errorf(output.NeedsLogin, "not signed in to %s", p.URL).WithHint("Run: gz auth login " + p.URL)
	}
	if err != nil {
		return nil, err
	}
	plain, err := ctx.client(p.URL)
	if err != nil {
		return nil, err
	}
	src := session.NewGrantSource(plain, p.URL, secret, ctx.env.Now)
	return session.NewClient(p.URL, ctx.env.HTTP, session.WithToken(src))
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
	if existing, ok := c.Find(adminURL); ok && name == "" {
		name = existing.Name
	}
	if name == "" {
		name = u.Host
	}
	if other, ok := c.Find(name); ok && strings.TrimRight(other.URL, "/") != adminURL {
		return output.Errorf(output.Usage, "the profile %q is already %s", name, other.URL).WithHint("Pick another name with --name.")
	}
	machine, err := ctx.env.Hostname()
	if err != nil || machine == "" {
		machine = "unknown machine"
	}
	client, err := ctx.client(adminURL)
	if err != nil {
		return err
	}
	flow := &login.Flow{
		Client:     client,
		AdminURL:   adminURL,
		GzVersion:  version.String(),
		Machine:    machine,
		Status:     ctx.env.Stderr,
		Terminal:   ctx.env.Terminal,
		Open:       ctx.env.Open,
		Sleep:      ctx.env.Sleep,
		Now:        ctx.env.Now,
		PollPeriod: ctx.env.PollPeriod,
	}
	res, err := flow.Run(ctx.env.Ctx)
	if err != nil {
		return err
	}
	if err := ctx.env.Grants().Set(name, res.GrantSecret); err != nil {
		return fmt.Errorf("storing the login: %w", err)
	}
	c.Put(profile.Profile{Name: name, URL: adminURL})
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

// loginState says whether a profile's grant still renews a token.
func (ctx *context) loginState(p profile.Profile) string {
	secret, err := ctx.env.Grants().Get(p.Name)
	if errors.Is(err, grant.ErrNotFound) {
		return "signed-out"
	}
	if err != nil {
		return "unknown"
	}
	plain, err := ctx.client(p.URL)
	if err != nil {
		return "unknown"
	}
	_, err = session.NewGrantSource(plain, p.URL, secret, ctx.env.Now).Token(ctx.env.Ctx)
	var e *output.Error
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
	res, err := client.DeleteApiV1AuthGrantsIdWithResponse(ctx.env.Ctx, session.GrantID(secret))
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
