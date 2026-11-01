// Package profile keeps gz's login profiles: one per admin, with a default
// (design-agent-access.md Q36). --admin and GZ_ADMIN pick another.
package profile

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

// LocalAdmin is the admin `gazetta dev` serves.
const LocalAdmin = "http://localhost:3000"

// Profile is one admin gz can talk to.
type Profile struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// Config is the profiles file.
type Config struct {
	Default  string    `json:"default,omitempty"`
	Profiles []Profile `json:"profiles"`
}

// Path is the profiles file in dir (the gz config folder).
func Path(dir string) string { return filepath.Join(dir, "config.json") }

// Load reads the profiles file; a missing file is an empty config.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &Config{Profiles: []Profile{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if c.Profiles == nil {
		c.Profiles = []Profile{}
	}
	return &c, nil
}

// Save writes the profiles file, readable only by the user.
func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// Find returns the profile with this name, or with this admin URL.
func (c *Config) Find(nameOrURL string) (Profile, bool) {
	for _, p := range c.Profiles {
		if p.Name == nameOrURL {
			return p, true
		}
	}
	want := strings.TrimRight(nameOrURL, "/")
	for _, p := range c.Profiles {
		if strings.TrimRight(p.URL, "/") == want {
			return p, true
		}
	}
	return Profile{}, false
}

// Use makes a profile the default.
func (c *Config) Use(name string) error {
	p, ok := c.Find(name)
	if !ok {
		return notFound(name)
	}
	c.Default = p.Name
	return nil
}

// Remove deletes a profile; if it was the default, the first one left
// becomes the default.
func (c *Config) Remove(name string) (Profile, error) {
	p, ok := c.Find(name)
	if !ok {
		return Profile{}, notFound(name)
	}
	kept := c.Profiles[:0]
	for _, q := range c.Profiles {
		if q.Name != p.Name {
			kept = append(kept, q)
		}
	}
	c.Profiles = kept
	if c.Default == p.Name {
		c.Default = ""
		if len(kept) > 0 {
			c.Default = kept[0].Name
		}
	}
	return p, nil
}

// Choice is what picks the admin: the --admin flag, GZ_ADMIN, and a probe
// that says whether a local admin answers.
type Choice struct {
	Flag  string
	Env   string
	Probe func(url string) bool
}

// Select picks the admin: --admin, then GZ_ADMIN, then the default profile.
// A URL that isn't a saved profile is used as given. With nothing set up it
// connects to nothing and only suggests a login (exit 3).
func Select(c *Config, ch Choice) (Profile, error) {
	for _, v := range []string{ch.Flag, ch.Env} {
		if v == "" {
			continue
		}
		if p, ok := c.Find(v); ok {
			return p, nil
		}
		if isURL(v) {
			return Profile{URL: strings.TrimRight(v, "/")}, nil
		}
		return Profile{}, notFound(v)
	}
	if c.Default != "" {
		if p, ok := c.Find(c.Default); ok {
			return p, nil
		}
	}
	e := output.Errorf(output.NeedsLogin, "not logged in to any Gazetta admin")
	if ch.Probe != nil && ch.Probe(LocalAdmin) {
		return Profile{}, e.WithHint("An admin is running at " + LocalAdmin + ". Run: gz auth login " + LocalAdmin)
	}
	return Profile{}, e.WithHint("Run: gz auth login <admin-url>")
}

func isURL(v string) bool {
	return strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://")
}

func notFound(name string) error {
	return output.Errorf(output.NotFound, "no profile %q", name).WithHint("See your profiles with: gz auth list")
}
