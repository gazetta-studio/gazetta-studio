// Package cli is gz's command line: global flags, the command table, and
// each command's output and exit code (design-agent-access.md Q37, Q38).
package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/grant"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/skill"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/version"
)

// Env is what a command reads and writes; tests give their own.
type Env struct {
	Stdout    io.Writer
	Stderr    io.Writer
	Getenv    func(string) string
	ConfigDir string
	// Grants opens the grant store; only commands that read or write a
	// grant call it, so --version and --help never touch the keychain.
	Grants func() grant.Store
	Probe  func(url string) bool
}

// DefaultEnv is the real process environment.
func DefaultEnv() (Env, error) {
	dir := os.Getenv("GZ_CONFIG_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return Env{}, err
		}
		dir = filepath.Join(base, "gz")
	}
	var once sync.Once
	var store grant.Store
	return Env{
		Stdout:    os.Stdout,
		Stderr:    os.Stderr,
		Getenv:    os.Getenv,
		ConfigDir: dir,
		Grants: func() grant.Store {
			once.Do(func() { store = grant.Default(filepath.Join(dir, "grants")) })
			return store
		},
		Probe: probe,
	}, nil
}

// probe says whether a Gazetta admin answers at url, without sending
// credentials: its health route answers 200 with {"ok": true}.
func probe(url string) bool {
	client := http.Client{Timeout: 500 * time.Millisecond}
	res, err := client.Get(url + "/admin/api/health")
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		OK bool `json:"ok"`
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&body) == nil && body.OK
}

type globals struct {
	json  bool
	admin string
	help  bool
}

type command struct {
	name    string // "auth list"
	usage   string
	summary string
	minArgs int
	maxArgs int
	run     func(ctx *context, args []string) error
}

type context struct {
	env Env
	out output.Printer
	g   globals
}

// Commands lists every command gz has, by name.
func Commands() []string {
	names := make([]string, 0, len(commands))
	for _, c := range commands {
		names = append(names, c.name)
	}
	return names
}

var commands []command

func init() {
	commands = []command{
		{"auth list", "gz auth list", "List your admin profiles", 0, 0, authList},
		{"auth use", "gz auth use <name>", "Make a profile the default", 1, 1, authUse},
		{"auth status", "gz auth status", "Show which admin gz uses", 0, 0, authStatus},
		{"auth logout", "gz auth logout [name]", "Remove a profile and its login", 0, 1, authLogout},
		{"skill", "gz skill", "Print the agent skill", 0, 0, skillPrint},
		{"skill install", "gz skill install <dir>", "Write the agent skill into an agent's skills folder", 1, 1, skillInstall},
		{"version", "gz version", "Print the gz version", 0, 0, showVersion},
	}
}

// Run runs gz with args and returns the exit code.
func Run(args []string, env Env) int {
	g, rest, err := parseGlobals(args, env)
	out := output.Printer{Out: env.Stdout, Err: env.Stderr, JSON: g.json}
	if err != nil {
		return out.Fail(err)
	}
	ctx := &context{env: env, out: out, g: g}
	if len(rest) == 0 {
		if g.help {
			printHelp(env.Stdout)
			return output.OK
		}
		printHelp(env.Stderr)
		return output.Usage
	}
	cmd, cmdArgs := lookup(rest)
	if cmd == nil {
		return out.Fail(output.Errorf(output.Usage, "unknown command %q", strings.Join(rest, " ")).
			WithHint("Run gz --help to see the commands."))
	}
	if g.help {
		fmt.Fprintf(env.Stdout, "%s\n\n%s\n", cmd.usage, cmd.summary)
		return output.OK
	}
	if len(cmdArgs) < cmd.minArgs || len(cmdArgs) > cmd.maxArgs {
		return out.Fail(output.Errorf(output.Usage, "usage: %s", cmd.usage))
	}
	if err := cmd.run(ctx, cmdArgs); err != nil {
		return out.Fail(err)
	}
	return output.OK
}

// parseGlobals pulls the global flags out of args, wherever they are.
func parseGlobals(args []string, env Env) (globals, []string, error) {
	var g globals
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
			g.json = true
		case a == "-h" || a == "--help":
			g.help = true
		case a == "--version":
			rest = []string{"version"}
		case a == "--admin":
			if i+1 >= len(args) {
				return g, nil, output.Errorf(output.Usage, "--admin needs a profile name or URL")
			}
			i++
			g.admin = args[i]
		case strings.HasPrefix(a, "--admin="):
			g.admin = strings.TrimPrefix(a, "--admin=")
		case strings.HasPrefix(a, "-") && a != "-":
			return g, nil, output.Errorf(output.Usage, "unknown flag %s", a)
		default:
			rest = append(rest, a)
		}
	}
	return g, rest, nil
}

// lookup matches the longest command name at the start of args.
func lookup(args []string) (*command, []string) {
	for n := 2; n >= 1; n-- {
		if len(args) < n {
			continue
		}
		name := strings.Join(args[:n], " ")
		for i := range commands {
			if commands[i].name == name {
				return &commands[i], args[n:]
			}
		}
	}
	return nil, nil
}

func printHelp(w io.Writer) {
	fmt.Fprintf(w, "gz %s: edit a Gazetta site through its admin.\n\nCommands:\n", version.String())
	for _, c := range commands {
		fmt.Fprintf(w, "  %-26s %s\n", c.usage, c.summary)
	}
	fmt.Fprint(w, `
Using an AI agent? Run gz skill install <your agent's skills folder>.

Flags:
  --admin <name|url>  Use this admin instead of the default (or set GZ_ADMIN)
  --json              Machine-readable output
  --version           Print the version
  -h, --help          Show help

Exit codes: 0 ok, 1 failure, 2 usage, 3 login or elevation needed, 4 conflict, 5 not found.
`)
}

func (ctx *context) config() (*profile.Config, string, error) {
	path := profile.Path(ctx.env.ConfigDir)
	c, err := profile.Load(path)
	return c, path, err
}

func authList(ctx *context, _ []string) error {
	c, _, err := ctx.config()
	if err != nil {
		return err
	}
	type row struct {
		Name    string `json:"name"`
		URL     string `json:"url"`
		Default bool   `json:"default"`
	}
	rows := make([]row, 0, len(c.Profiles))
	var b strings.Builder
	for _, p := range c.Profiles {
		rows = append(rows, row{p.Name, p.URL, p.Name == c.Default})
		mark := " "
		if p.Name == c.Default {
			mark = "*"
		}
		fmt.Fprintf(&b, "%s %s  %s\n", mark, p.Name, p.URL)
	}
	text := strings.TrimRight(b.String(), "\n")
	if text == "" {
		text = "No profiles yet. Run: gz auth login <admin-url>"
	}
	return ctx.out.Result(text, map[string]any{"default": c.Default, "profiles": rows})
}

func authUse(ctx *context, args []string) error {
	c, path, err := ctx.config()
	if err != nil {
		return err
	}
	if err := c.Use(args[0]); err != nil {
		return err
	}
	if err := c.Save(path); err != nil {
		return err
	}
	return ctx.out.Result("Default admin: "+c.Default, map[string]any{"default": c.Default})
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
	return ctx.out.Result("Using "+label, map[string]any{"name": p.Name, "url": p.URL})
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
	p, err := c.Remove(name)
	if err != nil {
		return err
	}
	if err := ctx.env.Grants().Delete(p.Name); err != nil {
		return err
	}
	if err := c.Save(path); err != nil {
		return err
	}
	return ctx.out.Result("Logged out of "+p.Name, map[string]any{"removed": p.Name, "default": c.Default})
}

func skillPrint(ctx *context, _ []string) error {
	text := skill.Text(version.String())
	return ctx.out.Result(strings.TrimRight(text, "\n"), map[string]any{"version": version.String(), "skill": text})
}

func skillInstall(ctx *context, args []string) error {
	path, err := skill.Install(args[0], version.String())
	if err != nil {
		return err
	}
	return ctx.out.Result("Installed the gz skill at "+path, map[string]any{"path": path, "version": version.String()})
}

func showVersion(ctx *context, _ []string) error {
	return ctx.out.Result("gz "+version.String(), map[string]any{"version": version.String()})
}
