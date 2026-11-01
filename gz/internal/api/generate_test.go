package api

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The committed client must be what oapi-codegen generates from the
// committed document; the gazetta test suite checks the document against
// the admin's routes.
func TestClientIsGeneratedFromTheDocument(t *testing.T) {
	out := filepath.Join(t.TempDir(), "client.gen.go")
	cmd := exec.Command("go", "tool", "oapi-codegen", "-config", "oapi-codegen.yaml", "-o", out, "openapi.json")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("oapi-codegen: %v", err)
	}
	want, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile("client.gen.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("internal/api/client.gen.go is stale. Run: npm run gz:api")
	}
}
