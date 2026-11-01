package version

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestVersionMatchesGazettaPackage(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "gazetta", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct{ Version string }
	if err := json.Unmarshal(data, &pkg); err != nil {
		t.Fatal(err)
	}
	if got := String(); got != pkg.Version {
		t.Fatalf("gz reports %q but packages/gazetta is %q; run: node -p \"require('./packages/gazetta/package.json').version\" > gz/internal/version/VERSION", got, pkg.Version)
	}
}

func TestLdflagsVersionWins(t *testing.T) {
	old := Version
	t.Cleanup(func() { Version = old })
	Version = "9.9.9"
	if String() != "9.9.9" {
		t.Fatalf("String() = %q, want the -ldflags value", String())
	}
}
