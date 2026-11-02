package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/content"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/elevation"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/state"
)

// publishCommands publish, elevate and manage assets (design-agent-access.md
// Q29, Q37). publish and elevate are on the skill's never-run list (Q32).
func publishCommands() []command {
	return []command{
		{"publish", "gz publish <page|@fragment>... --to <target> [--all] [--no-wait]", "Publish to a target; asks for an elevation when it needs one", 0, maxArgs, publish, []string{"--to", "--run"}, []string{"--all", "--no-wait"}},
		{"elevate", "gz elevate [--production] [--no-wait] [--end]", "Ask the person for an elevation ahead of time, or end yours", 0, 0, elevate, []string{"--run"}, []string{"--production", "--no-wait", "--end"}},
		{"assets list", "gz assets list [--kind <kind>]", "List the assets, with their alt text", 0, 0, assetsList, []string{"--kind", "--run"}, nil},
		{"assets upload", "gz assets upload <file>... [--name <n>] [--alt <text> | --decorative]", "Upload files to the asset library", 1, maxArgs, assetsUpload, []string{"--name", "--alt", "--run"}, []string{"--decorative"}},
		{"assets alt", "gz assets alt <name> [<text>] [--decorative] [--locale <l>]", "Set an asset's alt text", 1, 2, assetsAlt, []string{"--locale", "--run"}, []string{"--decorative"}},
	}
}

// elevationFlow asks the person for an elevation. It waits unless --no-wait,
// or in CI without a terminal, where it prints the code and exits 3 (Q29).
func (ctx *context) elevationFlow(s *content.Service) *elevation.Flow {
	wait := ctx.flags["--no-wait"] != "true" && !(ctx.env.Getenv("CI") != "" && !ctx.env.Terminal)
	return &elevation.Flow{
		Client: s.API, AdminURL: ctx.prof.URL, Status: ctx.env.Stderr, Wait: wait,
		Terminal: ctx.env.Terminal, Open: ctx.env.Open, Sleep: ctx.env.Sleep, Now: ctx.env.Now, Period: ctx.env.PollPeriod,
	}
}

// elevate asks for an elevation of scope and records it, so --end can end it.
func (ctx *context) elevate(s *content.Service, scope string) (state.Elevation, error) {
	e, err := ctx.elevationFlow(s).Start(ctx.env.Ctx, scope)
	if err != nil {
		return e, err
	}
	path := state.Path(ctx.env.ConfigDir)
	st, err := state.Load(path)
	if err != nil {
		return e, err
	}
	st.AddElevation(ctx.prof.Name, e, ctx.env.Now())
	return e, st.Save(path)
}

// publishItem turns `home`, `@header` or `home:fr` into the API's item names.
func publishItem(arg string) string {
	if strings.HasPrefix(arg, "@") {
		return "fragments/" + strings.TrimPrefix(arg, "@")
	}
	if strings.HasPrefix(arg, "pages/") || strings.HasPrefix(arg, "fragments/") {
		return arg
	}
	return "pages/" + arg
}

func publish(ctx *context, args []string) error {
	to := ctx.flags["--to"]
	if to == "" {
		return output.Errorf(output.Usage, "--to <target> is required").WithHint("See the targets with: gz status")
	}
	all := ctx.flags["--all"] == "true"
	if all == (len(args) > 0) {
		return output.Errorf(output.Usage, "name the items to publish, or pass --all")
	}
	s, err := ctx.service()
	if err != nil {
		return err
	}
	items := make([]string, len(args))
	for i, a := range args {
		items[i] = publishItem(a)
	}
	if all {
		c, err := s.Compare(ctx.env.Ctx, to)
		if err != nil {
			return err
		}
		items = append(c.Added, c.Modified...)
		if len(items) == 0 {
			return ctx.out.Result("Nothing to publish to "+to+".", map[string]any{"run": s.Run, "results": []any{}})
		}
	}
	results, refused, err := s.Publish(ctx.env.Ctx, items, []string{to})
	if err != nil {
		return err
	}
	// Publishing to production asks for two elevations in turn: the route
	// checks non-production rights first, then production (Q17). A scope
	// refused again after its elevation is reported, not asked twice.
	// On a target that needs approval, a publish without an elevation will
	// create a publish request instead (Q20, Q29), once review workflow
	// cuts 12-13 make the gate real; that path goes here.
	asked := map[string]bool{}
	for refused != nil && refused.Code == "ELEVATION_REQUIRED" && !asked[scopeOf(refused)] {
		scope := scopeOf(refused)
		asked[scope] = true
		if _, err := ctx.elevate(s, scope); err != nil {
			return err
		}
		results, refused, err = s.Publish(ctx.env.Ctx, items, []string{to})
		if err != nil {
			return err
		}
	}
	if refused != nil {
		return refused.Error()
	}
	var b strings.Builder
	failed := 0
	for _, r := range results {
		if r.Success {
			fmt.Fprintf(&b, "Published %d items to %s (%d files)\n", len(items), r.Target, r.CopiedFiles)
		} else {
			failed++
			fmt.Fprintf(&b, "Publishing to %s failed: %s\n", r.Target, r.Error)
		}
	}
	fmt.Fprintf(&b, "Run: %s", s.Run)
	if err := ctx.out.Result(b.String(), map[string]any{"run": s.Run, "items": items, "results": results}); err != nil {
		return err
	}
	if failed > 0 {
		return &output.Error{Exit: output.Failure, Reported: true}
	}
	return nil
}

// scopeOf is the scope an ELEVATION_REQUIRED refusal names.
func scopeOf(p *session.Problem) string {
	if p.Scope == elevation.Production {
		return elevation.Production
	}
	return elevation.NonProduction
}

func elevate(ctx *context, _ []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	if ctx.flags["--end"] == "true" {
		return ctx.endElevations(s)
	}
	scope := elevation.NonProduction
	if ctx.flags["--production"] == "true" {
		scope = elevation.Production
	}
	e, err := ctx.elevate(s, scope)
	if err != nil {
		return err
	}
	until := e.EndsAt.Local().Format("15:04")
	return ctx.out.Result(fmt.Sprintf("Elevated for %s targets until %s.", scope, until), e)
}

func (ctx *context) endElevations(s *content.Service) error {
	path := state.Path(ctx.env.ConfigDir)
	st, err := state.Load(path)
	if err != nil {
		return err
	}
	active := st.Active(ctx.prof.Name, ctx.env.Now())
	flow := ctx.elevationFlow(s)
	for _, e := range active {
		if err := flow.End(ctx.env.Ctx, e.ID); err != nil {
			return err
		}
	}
	delete(st.Elevations, ctx.prof.Name)
	if err := st.Save(path); err != nil {
		return err
	}
	text := fmt.Sprintf("Ended %d elevations.", len(active))
	switch len(active) {
	case 0:
		text = "No elevation of yours is active."
	case 1:
		text = "Ended your elevation."
	}
	return ctx.out.Result(text, map[string]any{"ended": len(active)})
}

func assetsList(ctx *context, _ []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	assets, err := s.Assets(ctx.env.Ctx)
	if err != nil {
		return err
	}
	kind := ctx.flags["--kind"]
	var kept []content.Asset
	var b strings.Builder
	for _, a := range assets {
		if kind != "" && a.Kind != kind && !strings.HasPrefix(a.Mime, kind+"/") {
			continue
		}
		kept = append(kept, a)
		alt := "no alt"
		switch {
		case a.Alt == nil:
		case *a.Alt == "":
			alt = "decorative"
		default:
			alt = fmt.Sprintf("alt %q", *a.Alt)
		}
		fmt.Fprintf(&b, "%s  %s  %d bytes  %s\n", a.Name, a.Mime, a.Size, alt)
	}
	text := strings.TrimRight(b.String(), "\n")
	if text == "" {
		text = "No assets."
	}
	return ctx.out.Result(text, map[string]any{"assets": kept})
}

func assetsUpload(ctx *context, args []string) error {
	if ctx.flags["--name"] != "" && len(args) > 1 {
		return output.Errorf(output.Usage, "--name names one file; upload the others separately")
	}
	var alt *string
	if ctx.flags["--decorative"] == "true" {
		empty := ""
		alt = &empty
	} else if v, ok := ctx.flags["--alt"]; ok {
		alt = &v
	}
	s, err := ctx.service()
	if err != nil {
		return err
	}
	var names []string
	for _, file := range args {
		data, err := os.ReadFile(file)
		if err != nil {
			return output.Errorf(output.Usage, "%v", err)
		}
		name := ctx.flags["--name"]
		if name == "" {
			name = strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
		}
		saved, err := s.Upload(ctx.env.Ctx, file, data, name, alt)
		if err != nil {
			return err
		}
		names = append(names, saved)
	}
	return ctx.out.Result("Uploaded "+strings.Join(names, ", "), map[string]any{"run": s.Run, "names": names})
}

func assetsAlt(ctx *context, args []string) error {
	if ctx.flags["--locale"] != "" {
		// The metadata PATCH has no locale yet (design-media.md M4, media cut 3).
		return output.Errorf(output.Usage, "alt text in another language isn't supported yet").
			WithHint("Set the default language's alt text without --locale.")
	}
	decorative := ctx.flags["--decorative"] == "true"
	if decorative == (len(args) == 2) {
		return output.Errorf(output.Usage, `give the alt text, or --decorative`).WithHint(`gz assets alt hero "A mountain at sunset"`)
	}
	alt := ""
	if !decorative {
		alt = args[1]
	}
	s, err := ctx.service()
	if err != nil {
		return err
	}
	if err := s.SetAlt(ctx.env.Ctx, args[0], alt); err != nil {
		return err
	}
	text := fmt.Sprintf("Set the alt text of %s.", args[0])
	if decorative {
		text = fmt.Sprintf("Marked %s as decorative.", args[0])
	}
	return ctx.out.Result(text, map[string]any{"run": s.Run, "name": args[0], "alt": alt})
}
