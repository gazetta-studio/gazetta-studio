// Package cli is gz's command line: global flags, the command table, and
// each command's output and exit code (design-agent-access.md Q37, Q38).
package cli

import (
	stdctx "context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/grant"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/login"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/profile"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
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

	// Talking to an admin. Zero values get working defaults, so tests set
	// only what they drive.
	Ctx        stdctx.Context
	Stdin      io.Reader
	HTTP       *http.Client
	Hostname   func() (string, error)
	Terminal   bool // stdin and stdout are a terminal: gz may open a browser
	Open       func(url string) error
	Now        func() time.Time
	Sleep      func(ctx stdctx.Context, d time.Duration) error
	PollPeriod time.Duration
	// EntraAuthority replaces Microsoft's sign-in host (tests).
	EntraAuthority string
}

func (e Env) withDefaults() Env {
	if e.Ctx == nil {
		e.Ctx = stdctx.Background()
	}
	if e.Stdin == nil {
		e.Stdin = os.Stdin
	}
	if e.HTTP == nil {
		e.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if e.Hostname == nil {
		e.Hostname = os.Hostname
	}
	if e.Now == nil {
		e.Now = time.Now
	}
	if e.Sleep == nil {
		e.Sleep = login.SleepContext
	}
	if e.PollPeriod == 0 {
		e.PollPeriod = login.PollInterval
	}
	return e
}

// openBrowser opens url in the person's browser.
func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
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
			once.Do(func() {
				// GZ_GRANT_STORE=file skips the keychain (tests, shared machines).
				if os.Getenv("GZ_GRANT_STORE") == "file" {
					store = grant.NewFile(filepath.Join(dir, "grants"))
				} else {
					store = grant.Default(filepath.Join(dir, "grants"))
				}
			})
			return store
		},
		Probe:    probe,
		Terminal: output.Interactive(os.Stdin) && output.Interactive(os.Stdout),
		Open:     openBrowser,
	}, nil
}

// probe says whether a Gazetta admin answers at url, without sending
// credentials: its health route answers 200 with {"ok": true}. The path
// comes from the generated client, so it follows the API's routes.
func probe(url string) bool {
	client, err := session.NewClient(url, &http.Client{Timeout: 500 * time.Millisecond})
	if err != nil {
		return false
	}
	res, err := client.GetApiHealthWithResponse(stdctx.Background())
	return err == nil && res.JSON200 != nil && bool(res.JSON200.Ok)
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
	// flags the command takes, each taking a value.
	flags []string
	// switches the command takes, without a value.
	switches []string
}

type context struct {
	env   Env
	out   output.Printer
	g     globals
	flags map[string]string
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
		{"auth login", "gz auth login <admin-url> [--name <name>] [--paste] [--cf-client-id <id> --cf-client-secret <secret>] [--entra-tenant <t> --entra-client-id <id> --entra-scope <s>]", "Sign in to an admin", 1, 1, authLogin,
			[]string{"--name", "--cf-client-id", "--cf-client-secret", "--entra-tenant", "--entra-client-id", "--entra-scope"}, []string{"--paste"}},
		{"auth list", "gz auth list", "List your admin profiles", 0, 0, authList, nil, nil},
		{"auth use", "gz auth use <name>", "Make a profile the default", 1, 1, authUse, nil, nil},
		{"auth status", "gz auth status", "Show which admin gz uses and which logins still work", 0, 0, authStatus, nil, nil},
		{"auth logout", "gz auth logout [name]", "Sign out: revoke the login and remove the profile", 0, 1, authLogout, nil, nil},
		{"skill", "gz skill", "Print the agent skill", 0, 0, skillPrint, nil, nil},
		{"skill install", "gz skill install <dir>", "Write the agent skill into an agent's skills folder", 1, 1, skillInstall, nil, nil},
		{"version", "gz version", "Print the gz version", 0, 0, showVersion, nil, nil},
	}
}

// Run runs gz with args and returns the exit code.
func Run(args []string, env Env) int {
	env = env.withDefaults()
	g, rest, err := parseGlobals(args, env)
	out := output.Printer{Out: env.Stdout, Err: env.Stderr, JSON: g.json}
	if err != nil {
		return out.Fail(err)
	}
	ctx := &context{env: env, out: out, g: g}
	if len(rest) > 0 && isFlag(rest[0]) {
		return out.Fail(output.Errorf(output.Usage, "unknown flag %s", rest[0]))
	}
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
	cmdArgs, ctx.flags, err = commandFlags(cmd, cmdArgs)
	if err != nil {
		return out.Fail(err)
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
		default:
			rest = append(rest, a)
		}
	}
	return g, rest, nil
}

func isFlag(a string) bool { return strings.HasPrefix(a, "-") && a != "-" }

// commandFlags takes the command's own flags out of args.
func commandFlags(cmd *command, args []string) ([]string, map[string]string, error) {
	flags := map[string]string{}
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !isFlag(a) {
			rest = append(rest, a)
			continue
		}
		name, value, inline := strings.Cut(a, "=")
		if slices.Contains(cmd.switches, name) && !inline {
			flags[name] = "true"
			continue
		}
		if !slices.Contains(cmd.flags, name) {
			return nil, nil, output.Errorf(output.Usage, "unknown flag %s", name).WithHint("usage: " + cmd.usage)
		}
		if !inline {
			if i+1 >= len(args) {
				return nil, nil, output.Errorf(output.Usage, "%s needs a value", name)
			}
			i++
			value = args[i]
		}
		flags[name] = value
	}
	return rest, flags, nil
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
