package skill

import (
	"os"
	"strings"
	"testing"
)

func TestTextHasTheVersion(t *testing.T) {
	text := Text("1.2.3")
	if !strings.Contains(text, `gz-version: "1.2.3"`) || strings.Contains(text, "{{version}}") {
		t.Fatal("version line not filled in")
	}
}

func TestInstallWritesTheSkill(t *testing.T) {
	path, err := Install(t.TempDir(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != Text("1.2.3") {
		t.Fatalf("%s: %v", path, err)
	}
	if !strings.HasSuffix(path, "gz/SKILL.md") && !strings.HasSuffix(path, `gz\SKILL.md`) {
		t.Fatalf("path %s", path)
	}
}

func TestCommandsReadsBacktickedCommands(t *testing.T) {
	got := Commands()
	want := map[string]bool{"auth list": true, "auth use": true, "auth status": true, "auth logout": true}
	for w := range want {
		found := false
		for _, g := range got {
			if g == w {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q in %v", w, got)
		}
	}
}
