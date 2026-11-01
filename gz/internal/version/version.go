// Package version reports the gz version: the same as the gazetta package
// (design-agent-access.md Q39).
package version

import (
	_ "embed"
	"strings"
)

// VERSION holds packages/gazetta/package.json's version; a test keeps the
// two in step.
//
//go:embed VERSION
var embedded string

// Version is set at release time with -ldflags "-X ...version.Version=x".
var Version = ""

// String is the version gz reports.
func String() string {
	if Version != "" {
		return Version
	}
	return strings.TrimSpace(embedded)
}
