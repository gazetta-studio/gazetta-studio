package cli

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/content"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/manifestpath"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
)

// contentCommands are the content commands (design-agent-access.md Q37),
// the same verbs for pages and fragments.
func contentCommands() []command {
	var cmds []command
	for _, kind := range []content.Kind{content.Page, content.Fragment} {
		k, ks := string(kind), kind.Plural()
		cmds = append(cmds,
			command{ks + " list", "gz " + ks + " list", "List the " + ks + ", with routes, templates and languages", 0, 0, listItems(kind), []string{"--run"}, nil},
			command{ks + " get", "gz " + ks + " get <name> [--locale <l>]", "Print a " + k + "'s manifest and save-version", 1, 1, getItem(kind), []string{"--locale", "--run"}, nil},
			command{ks + " set", "gz " + ks + " set <name> <path>=<value>... [<name> <path>=<value>...] [--locale <l>] [--from <dir|file>]", "Change values in " + ks + "; several " + ks + " are saved all or nothing", 0, maxArgs, setItems(kind), []string{"--locale", "--from", "--run"}, nil},
			command{ks + " edit", "gz " + ks + " edit <name> [--locale <l>]", "Replace a " + k + "'s manifest from stdin, or edit it in $EDITOR", 1, 1, editItem(kind), []string{"--locale", "--run"}, nil},
			command{ks + " create", "gz " + ks + " create <name> --template <t> [--locale <l>]", "Create a " + k + ", or a language version of one", 1, 1, createItem(kind), []string{"--template", "--locale", "--run"}, nil},
		)
	}
	return append(cmds,
		command{"templates schema", "gz templates schema <name>", "Print a template's JSON Schema, the fields set can change", 1, 1, templateSchema, []string{"--run"}, nil},
		command{"validate", "gz validate", "List the site's validation issues; exits 1 on any error", 0, 0, validate, []string{"--run"}, nil},
		command{"preview", "gz preview <name|@fragment> [--locale <l>] [--html]", "Print a page's preview URL, or with --html its rendered HTML", 1, 1, preview, []string{"--locale", "--run"}, []string{"--html"}},
		command{"status", "gz status [--target <t>]", "List the changes not yet published to a target", 0, 0, status, []string{"--target", "--run"}, nil},
	)
}

// maxArgs stands for "no upper limit".
const maxArgs = 1 << 30

// service is the content service for the selected admin, as one run: --run,
// then GZ_RUN, then a fresh id for this command (Q22).
func (ctx *context) service() (*content.Service, error) {
	c, _, err := ctx.config()
	if err != nil {
		return nil, err
	}
	p, err := profile.Select(c, profile.Choice{Flag: ctx.g.admin, Env: ctx.env.Getenv("GZ_ADMIN"), Probe: ctx.env.Probe})
	if err != nil {
		return nil, err
	}
	client, err := ctx.signedIn(p)
	if err != nil {
		return nil, err
	}
	ctx.prof = p
	run := ctx.flags["--run"]
	if run == "" {
		run = ctx.env.Getenv("GZ_RUN")
	}
	if run == "" {
		run = newRunID()
	}
	return &content.Service{API: client, Run: run}, nil
}

func newRunID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "gz-" + hex.EncodeToString(b)
}

func pretty(v any) string {
	b, _ := json.MarshalIndent(v, "", "  ")
	return string(b)
}

func listItems(kind content.Kind) func(*context, []string) error {
	return func(ctx *context, _ []string) error {
		s, err := ctx.service()
		if err != nil {
			return err
		}
		rows, err := s.List(ctx.env.Ctx, kind)
		if err != nil {
			return err
		}
		var b strings.Builder
		for _, r := range rows {
			fmt.Fprintf(&b, "%s", r.Name)
			if r.Route != "" {
				fmt.Fprintf(&b, "  %s", r.Route)
			}
			if r.Template != "" {
				fmt.Fprintf(&b, "  %s", r.Template)
			}
			if len(r.Locales) > 0 {
				fmt.Fprintf(&b, "  [%s]", strings.Join(r.Locales, ", "))
			}
			if r.Archived {
				b.WriteString("  (archived)")
			}
			b.WriteString("\n")
		}
		text := strings.TrimRight(b.String(), "\n")
		if text == "" {
			text = "No " + kind.Plural() + "."
		}
		return ctx.out.Result(text, map[string]any{kind.Plural(): rows})
	}
}

func getItem(kind content.Kind) func(*context, []string) error {
	return func(ctx *context, args []string) error {
		s, err := ctx.service()
		if err != nil {
			return err
		}
		it, err := s.Get(ctx.env.Ctx, kind, args[0], ctx.flags["--locale"])
		if err != nil {
			return err
		}
		if !ctx.out.JSON {
			// The save-version goes to stderr, so stdout stays the manifest.
			fmt.Fprintf(ctx.env.Stderr, "save-version: %s\n", it.Etag)
		}
		return ctx.out.Result(pretty(it.Manifest), it)
	}
}

// change is one item a set changes: by assignments, or by a whole manifest.
type change struct {
	name     string
	locale   string
	assign   []manifestpath.Assignment
	manifest map[string]any
}

func setItems(kind content.Kind) func(*context, []string) error {
	return func(ctx *context, args []string) error {
		var changes []change
		var err error
		if from := ctx.flags["--from"]; from != "" {
			if len(args) > 0 {
				return output.Errorf(output.Usage, "give either --from or <name> <path>=<value>, not both")
			}
			changes, err = readChanges(from, ctx.flags["--locale"])
		} else {
			changes, err = parseChanges(args, ctx.flags["--locale"])
		}
		if err != nil {
			return err
		}
		s, err := ctx.service()
		if err != nil {
			return err
		}
		items := make([]content.Item, 0, len(changes))
		for _, ch := range changes {
			it, err := s.Get(ctx.env.Ctx, kind, ch.name, ch.locale)
			if err != nil {
				return err
			}
			if ch.manifest != nil {
				it.Manifest = ch.manifest
			}
			for _, a := range ch.assign {
				if err := manifestpath.Apply(it.Manifest, a); err != nil {
					return output.Errorf(output.Usage, "%s: %v", ch.name, err)
				}
			}
			items = append(items, it)
		}
		return ctx.save(s, items)
	}
}

// save writes the items: one with the single save, several with the bulk
// save, all or nothing (#1720).
func (ctx *context) save(s *content.Service, items []content.Item) error {
	var res content.Result
	var err error
	if len(items) == 1 {
		res, err = s.Save(ctx.env.Ctx, items[0])
	} else {
		res, err = s.SaveMany(ctx.env.Ctx, items)
	}
	if err != nil {
		return err
	}
	var b strings.Builder
	for _, it := range res.Items {
		name := it.Name
		if it.Locale != "" {
			name += " (" + it.Locale + ")"
		}
		fmt.Fprintf(&b, "Saved %s %s, save-version %s\n", it.Kind, name, it.Etag)
	}
	fmt.Fprintf(&b, "Run: %s", res.Run)
	return ctx.out.Result(b.String(), res)
}

// parseChanges reads `<name> <path>=<value>... [<name> ...]`.
func parseChanges(args []string, locale string) ([]change, error) {
	usage := output.Errorf(output.Usage, "give a name, then one or more <path>=<value>").
		WithHint("For example: gz pages set home components.hero.content.title=Spring")
	var changes []change
	for _, a := range args {
		if !manifestpath.IsAssignment(a) {
			changes = append(changes, change{name: a, locale: locale})
			continue
		}
		if len(changes) == 0 {
			return nil, usage
		}
		as, err := manifestpath.Parse(a, os.ReadFile)
		if err != nil {
			return nil, output.Errorf(output.Usage, "%v", err)
		}
		last := &changes[len(changes)-1]
		last.assign = append(last.assign, as)
	}
	if len(changes) == 0 {
		return nil, usage
	}
	for _, ch := range changes {
		if len(ch.assign) == 0 {
			return nil, output.Errorf(output.Usage, "%s has no <path>=<value>", ch.name)
		}
	}
	return changes, nil
}

// readChanges reads whole manifests from --from: a JSON file holding
// [{"name", "locale"?, "manifest"}], or a folder of <name>.json and
// <name>.<locale>.json files (a name with slashes lives in subfolders).
func readChanges(from, locale string) ([]change, error) {
	info, err := os.Stat(from)
	if err != nil {
		return nil, output.Errorf(output.Usage, "--from: %v", err)
	}
	if !info.IsDir() {
		b, err := os.ReadFile(from)
		if err != nil {
			return nil, err
		}
		var entries []struct {
			Name     string         `json:"name"`
			Locale   string         `json:"locale"`
			Manifest map[string]any `json:"manifest"`
		}
		if err := json.Unmarshal(b, &entries); err != nil {
			return nil, output.Errorf(output.Usage, "--from %s: expected a JSON array of {name, locale, manifest}: %v", from, err)
		}
		changes := make([]change, len(entries))
		for i, e := range entries {
			if e.Locale == "" {
				e.Locale = locale
			}
			changes[i] = change{name: e.Name, locale: e.Locale, manifest: e.Manifest}
		}
		return changes, nil
	}
	var changes []change
	err = filepath.WalkDir(from, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		// Only the file name carries the language (`about.fr.json`); a
		// folder's own dots stay in the item name.
		dir, file := pathpkg.Split(strings.TrimSuffix(filepath.ToSlash(rel), ".json"))
		name, loc, _ := strings.Cut(file, ".")
		name = dir + name
		if loc == "" {
			loc = locale
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			return output.Errorf(output.Usage, "%s: %v", path, err)
		}
		changes = append(changes, change{name: name, locale: loc, manifest: m})
		return nil
	})
	if err == nil && len(changes) == 0 {
		err = output.Errorf(output.Usage, "--from %s has no .json files", from)
	}
	return changes, err
}

func editItem(kind content.Kind) func(*context, []string) error {
	return func(ctx *context, args []string) error {
		s, err := ctx.service()
		if err != nil {
			return err
		}
		it, err := s.Get(ctx.env.Ctx, kind, args[0], ctx.flags["--locale"])
		if err != nil {
			return err
		}
		var edited []byte
		if ctx.env.Terminal {
			edited, err = ctx.editInEditor(it.Manifest)
		} else {
			edited, err = io.ReadAll(ctx.env.Stdin)
		}
		if err != nil {
			return err
		}
		var m map[string]any
		if err := json.Unmarshal(edited, &m); err != nil {
			return output.Errorf(output.Usage, "the manifest isn't a JSON object: %v", err)
		}
		if bytes.Equal(mustJSON(m), mustJSON(it.Manifest)) {
			return ctx.out.Result("No changes.", map[string]any{"run": s.Run, "items": []any{}})
		}
		it.Manifest = m
		return ctx.save(s, []content.Item{it})
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// editInEditor opens $EDITOR (then $VISUAL, then vi) on the manifest.
func (ctx *context) editInEditor(manifest map[string]any) ([]byte, error) {
	f, err := os.CreateTemp("", "gz-*.json")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(pretty(manifest) + "\n"); err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	editor := ctx.env.Getenv("EDITOR")
	if editor == "" {
		editor = ctx.env.Getenv("VISUAL")
	}
	if editor == "" {
		editor = "vi"
	}
	parts := strings.Fields(editor)
	cmd := exec.Command(parts[0], append(parts[1:], f.Name())...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s: %v", editor, err)
	}
	return os.ReadFile(f.Name())
}

func createItem(kind content.Kind) func(*context, []string) error {
	return func(ctx *context, args []string) error {
		template := ctx.flags["--template"]
		if template == "" {
			return output.Errorf(output.Usage, "--template is required").WithHint("See the templates with: gz templates schema <name>")
		}
		s, err := ctx.service()
		if err != nil {
			return err
		}
		res, err := s.Create(ctx.env.Ctx, kind, args[0], ctx.flags["--locale"], template)
		if err != nil {
			return err
		}
		it := res.Items[0]
		name := it.Name
		if it.Locale != "" {
			name += " (" + it.Locale + ")"
		}
		return ctx.out.Result(fmt.Sprintf("Created %s %s, save-version %s\nRun: %s", kind, name, it.Etag, res.Run), res)
	}
}

func templateSchema(ctx *context, args []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	schema, err := s.TemplateSchema(ctx.env.Ctx, args[0])
	if err != nil {
		return err
	}
	var v any
	if err := json.Unmarshal(schema, &v); err != nil {
		return err
	}
	return ctx.out.Result(pretty(v), v)
}

func validate(ctx *context, _ []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	issues, err := s.Issues(ctx.env.Ctx)
	if err != nil {
		return err
	}
	byItem := map[string][]string{}
	errors := 0
	for _, is := range issues {
		where := ""
		if is.ContentPath != "" {
			where = "at " + is.ContentPath + ": "
		}
		byItem[is.ItemPath] = append(byItem[is.ItemPath], fmt.Sprintf("  %s: %s%s", is.Severity, where, is.Message))
		if is.Severity == "error" {
			errors++
		}
	}
	items := make([]string, 0, len(byItem))
	for item := range byItem {
		items = append(items, item)
	}
	sort.Strings(items)
	var b strings.Builder
	for _, item := range items {
		fmt.Fprintf(&b, "%s\n%s\n", item, strings.Join(byItem[item], "\n"))
	}
	fmt.Fprintf(&b, "%d issues, %d errors", len(issues), errors)
	if len(issues) == 0 {
		b.Reset()
		b.WriteString("No issues.")
	}
	if err := ctx.out.Result(b.String(), map[string]any{"issues": issues, "errors": errors}); err != nil {
		return err
	}
	if errors > 0 {
		return &output.Error{Exit: output.Failure, Reported: true}
	}
	return nil
}

func preview(ctx *context, args []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	kind, name := content.Page, args[0]
	if strings.HasPrefix(name, "@") {
		kind, name = content.Fragment, strings.TrimPrefix(name, "@")
	}
	route := ""
	if kind == content.Page {
		it, err := s.Get(ctx.env.Ctx, kind, name, ctx.flags["--locale"])
		if err != nil {
			return err
		}
		route = it.Route
	}
	path := content.PreviewPath(kind, name, route)
	if ctx.flags["--html"] == "true" {
		html, err := s.PreviewHTML(ctx.env.Ctx, path)
		if err != nil {
			return err
		}
		return ctx.out.Result(html, map[string]any{"html": html})
	}
	u := s.PreviewURL(path)
	return ctx.out.Result(u, map[string]any{"url": u})
}

func status(ctx *context, _ []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	target := ctx.flags["--target"]
	if target == "" {
		targets, err := s.Targets(ctx.env.Ctx)
		if err != nil {
			return err
		}
		for _, t := range targets {
			if !t.Editable {
				target = t.Name
				break
			}
		}
		if target == "" {
			return output.Errorf(output.Usage, "no target to compare with").WithHint("Pass one with --target <name>.")
		}
	}
	c, err := s.Compare(ctx.env.Ctx, target)
	if err != nil {
		return err
	}
	var lines []string
	for _, g := range []struct {
		label string
		items []string
	}{{"added", c.Added}, {"modified", c.Modified}, {"only on " + target, c.Deleted}} {
		for _, it := range g.items {
			lines = append(lines, fmt.Sprintf("  %s: %s", g.label, it))
		}
	}
	n := len(lines)
	text := fmt.Sprintf("%d unpublished changes on %s", n, target)
	if n == 1 {
		text = fmt.Sprintf("1 unpublished change on %s", target)
	}
	if n > 0 {
		text += ":\n" + strings.Join(lines, "\n")
	}
	return ctx.out.Result(text, map[string]any{"target": target, "added": c.Added, "modified": c.Modified, "deleted": c.Deleted})
}
