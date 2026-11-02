// Package state is what gz remembers besides its profiles, in state.json
// next to them: the folders it installed the skill into and when it last
// warned about an outdated copy (design-agent-access.md Q41), and the
// elevations it started, so `gz elevate --end` can end them (Q17). gz writes
// nothing in projects or client folders unless asked (Q41).
package state

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// State is the file's contents.
type State struct {
	// Skills are the folders `gz skill install` wrote the skill into.
	Skills []string `json:"skills,omitempty"`
	// SkillWarned is the day (YYYY-MM-DD) gz last warned about an outdated copy.
	SkillWarned string `json:"skillWarned,omitempty"`
	// Elevations are the elevations gz started, by profile.
	Elevations map[string][]Elevation `json:"elevations,omitempty"`
}

// Elevation is one elevation gz started.
type Elevation struct {
	ID     string    `json:"id"`
	Scope  string    `json:"scope"`
	EndsAt time.Time `json:"endsAt"`
}

// Path is the state file in the gz config folder.
func Path(dir string) string { return filepath.Join(dir, "state.json") }

// Load reads the state; a missing file is an empty state.
func Load(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &State{}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	return &s, json.Unmarshal(data, &s)
}

// Save writes the state, readable only by the user.
func (s *State) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// AddSkill records a folder the skill was installed into.
func (s *State) AddSkill(dir string) {
	if !slices.Contains(s.Skills, dir) {
		s.Skills = append(s.Skills, dir)
	}
}

// AddElevation records an elevation for a profile, dropping ended ones.
func (s *State) AddElevation(profile string, e Elevation, now time.Time) {
	if s.Elevations == nil {
		s.Elevations = map[string][]Elevation{}
	}
	s.Elevations[profile] = append(s.Active(profile, now), e)
}

// Active are the profile's elevations that haven't ended.
func (s *State) Active(profile string, now time.Time) []Elevation {
	var out []Elevation
	for _, e := range s.Elevations[profile] {
		if e.EndsAt.After(now) {
			out = append(out, e)
		}
	}
	return out
}
