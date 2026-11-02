// Package skill is the agent skill embedded in gz (design-agent-access.md
// Q40): `gz skill` prints it, `gz skill install <dir>` writes it where an
// agent's client reads skills, with a version line (Q41).
package skill

import (
	_ "embed"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

//go:embed SKILL.md
var source string

// Text is the skill with this gz's version filled in.
func Text(version string) string {
	return strings.ReplaceAll(source, "{{version}}", version)
}

// Install writes the skill to <dir>/gz/SKILL.md and returns the path.
func Install(dir, version string) (string, error) {
	folder := filepath.Join(dir, "gz")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(folder, "SKILL.md")
	return path, os.WriteFile(path, []byte(Text(version)), 0o644)
}

var versionLine = regexp.MustCompile(`(?m)^\s*gz-version:\s*"?([^"\s]+)"?`)

// InstalledVersion reads the gz version an installed copy in dir was
// written by; false when there's no copy or no version line.
func InstalledVersion(dir string) (string, bool) {
	data, err := os.ReadFile(filepath.Join(dir, "gz", "SKILL.md"))
	if err != nil {
		return "", false
	}
	m := versionLine.FindSubmatch(data)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
}

var commandRef = regexp.MustCompile("`gz ([a-z][a-z-]*(?: [a-z][a-z-]*)?)")

// Commands lists the gz commands the skill names in backticks, for the drift
// test against the commands gz has.
func Commands() []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range commandRef.FindAllStringSubmatch(source, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

var neverRunEntry = regexp.MustCompile("(?m)^- `gz ([^`]+)`$")

// NeverRun lists the gz commands in the skill's never-run section (Q32), for
// the drift test against gz's commands.
func NeverRun() []string {
	i := strings.Index(source, "ever run these")
	if i < 0 {
		return nil
	}
	var out []string
	for _, m := range neverRunEntry.FindAllStringSubmatch(source[i:], -1) {
		out = append(out, m[1])
	}
	return out
}
