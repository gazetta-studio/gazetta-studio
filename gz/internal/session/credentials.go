package session

import (
	"encoding/json"
	"strings"
)

// Credentials is what gz keeps in the keychain for a profile: the grant,
// and the login layer's secrets on platforms that need them (Q15, Q24).
// A plain string is a grant alone, as cut 12 stored it.
type Credentials struct {
	Grant string `json:"grant"`
	// Cloudflare Access service token (Q23).
	CFClientID     string `json:"cfClientId,omitempty"`
	CFClientSecret string `json:"cfClientSecret,omitempty"`
	// Entra refresh token, behind Azure Easy Auth.
	EntraRefreshToken string `json:"entraRefreshToken,omitempty"`
}

// ParseCredentials reads a stored entry.
func ParseCredentials(stored string) Credentials {
	if strings.HasPrefix(stored, "{") {
		var c Credentials
		if json.Unmarshal([]byte(stored), &c) == nil {
			return c
		}
	}
	return Credentials{Grant: stored}
}

// String is the entry to store.
func (c Credentials) String() string {
	if c.CFClientID == "" && c.CFClientSecret == "" && c.EntraRefreshToken == "" {
		return c.Grant
	}
	b, _ := json.Marshal(c)
	return string(b)
}
