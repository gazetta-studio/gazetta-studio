package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/fakeadmin"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

// signedIn is a harness logged in to a fake admin holding home, about and @header.
func signedIn(t *testing.T) (*harness, *fakeadmin.Admin) {
	t.Helper()
	h, a := withAdmin(t)
	if code := h.run("auth", "login", a.URL, "--name", "dev"); code != output.OK {
		t.Fatalf("login: %d %q", code, h.stderr.String())
	}
	a.SeedContent()
	return h, a
}

func (h *harness) must(t *testing.T, args ...string) {
	t.Helper()
	if code := h.run(args...); code != output.OK {
		t.Fatalf("gz %s: exit %d\nstdout %q\nstderr %q", strings.Join(args, " "), code, h.stdout.String(), h.stderr.String())
	}
}

func heroTitle(a *fakeadmin.Admin, name string) any {
	comps := a.Items["page:"+name+":"].Manifest["components"].([]any)
	return comps[0].(map[string]any)["content"].(map[string]any)["title"]
}

func TestListAndGet(t *testing.T) {
	h, _ := signedIn(t)
	h.must(t, "pages", "list")
	if !strings.Contains(h.stdout.String(), "home  /  page-default") {
		t.Fatalf("list %q", h.stdout.String())
	}
	h.must(t, "fragments", "list", "--json")
	if rows := h.json(t)["fragments"].([]any); len(rows) != 1 || rows[0].(map[string]any)["name"] != "header" {
		t.Fatalf("fragments %v", rows)
	}
	h.must(t, "pages", "get", "home")
	if !strings.Contains(h.stderr.String(), "save-version: v1") || !strings.Contains(h.stdout.String(), `"template": "page-default"`) {
		t.Fatalf("get: %q %q", h.stdout.String(), h.stderr.String())
	}
	h.must(t, "pages", "get", "home", "--json")
	got := h.json(t)
	if got["etag"] != "v1" || got["route"] != "/" || got["manifest"].(map[string]any)["template"] != "page-default" {
		t.Fatalf("get --json %v", got)
	}
}

func TestSetOneItemUsesTheSingleSaveWithTheRunID(t *testing.T) {
	h, a := signedIn(t)
	h.must(t, "pages", "set", "home", "components.hero.content.title=Spring", "--json")
	if heroTitle(a, "home") != "Spring" {
		t.Fatalf("not saved: %v", a.Items["page:home:"].Manifest)
	}
	res := h.json(t)
	run, _ := res["run"].(string)
	if !strings.HasPrefix(run, "gz-") || len(a.Saves) != 1 || a.Saves[0].Bulk || a.Saves[0].Run != run {
		t.Fatalf("run %q saves %+v", run, a.Saves)
	}
}

func TestSetSeveralItemsUsesTheBulkSaveAndWritesNoneOnFailure(t *testing.T) {
	h, a := signedIn(t)
	h.env.Getenv = func(k string) string {
		if k == "GZ_RUN" {
			return "t1"
		}
		return ""
	}
	h.must(t, "pages", "set", "home", "components.hero.content.title=A", "about", "components.hero.content.title=B")
	if len(a.Saves) != 2 || !a.Saves[0].Bulk || a.Saves[0].Run != "t1" || a.Saves[1].Run != "t1" {
		t.Fatalf("saves %+v", a.Saves)
	}

	code := h.run("pages", "set", "home", "components.hero.content.title=C", "about", "components.hero.content.title=")
	if code != output.Failure {
		t.Fatalf("exit %d", code)
	}
	if heroTitle(a, "home") != "A" {
		t.Fatalf("home was written although about failed")
	}
	if !strings.Contains(h.stderr.String(), "page about: VALIDATION_FAILED") || !strings.Contains(h.stderr.String(), "at hero: title: Required") {
		t.Fatalf("stderr %q", h.stderr.String())
	}
}

func TestSetErrorsMapToExitCodes(t *testing.T) {
	h, _ := signedIn(t)
	if code := h.run("pages", "set", "missing", "content.x=1"); code != output.NotFound {
		t.Fatalf("missing page: %d", code)
	}
	if code := h.run("pages", "set", "home", "components.hero.content.title="); code != output.Failure {
		t.Fatalf("schema failure: %d", code)
	}
	if !strings.Contains(h.stderr.String(), "at hero: title: Required") {
		t.Fatalf("the field isn't named: %q", h.stderr.String())
	}
	if code := h.run("pages", "set", "home", "components.nope.content=x"); code != output.Usage {
		t.Fatalf("an unknown component: %d", code)
	}
	for _, args := range [][]string{{"pages", "set"}, {"pages", "set", "content.x=1"}, {"pages", "set", "home"}} {
		if code := h.run(args...); code != output.Usage {
			t.Fatalf("%v: %d", args, code)
		}
	}
}

func TestAStaleSaveVersionExits4(t *testing.T) {
	h, a := signedIn(t)
	// The fake bumps home's version after gz reads it, as another writer would.
	h.env.HTTP = &http.Client{Transport: bumpAfterRead{a: a}}
	if code := h.run("pages", "set", "home", "components.hero.content.title=Late"); code != output.Conflict {
		t.Fatalf("exit %d, stderr %q", code, h.stderr.String())
	}
	if !strings.Contains(h.stderr.String(), "STALE") {
		t.Fatalf("stderr %q", h.stderr.String())
	}
}

func TestSetFromAFolderUsesWholeManifests(t *testing.T) {
	h, a := signedIn(t)
	dir := t.TempDir()
	write := func(name, title string) {
		m := map[string]any{"template": "page-default", "components": []any{map[string]any{"name": "hero", "template": "hero", "content": map[string]any{"title": title}}}}
		b, _ := json.Marshal(m)
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("home.json", "Folder home")
	write("about.fr.json", "À propos")
	if err := os.Mkdir(filepath.Join(dir, "v1.2"), 0o700); err != nil {
		t.Fatal(err)
	}
	write("v1.2/notes.json", "Notes")
	a.Items["page:v1.2/notes:"] = &fakeadmin.Item{Manifest: map[string]any{"template": "page-default"}, Version: 1}
	h.must(t, "pages", "set", "--from", dir)
	if a.Items["page:v1.2/notes:"] == nil {
		t.Fatalf("a folder's dot split the name: %v", a.Saves)
	}
	if heroTitle(a, "home") != "Folder home" {
		t.Fatalf("home %v", a.Items["page:home:"].Manifest)
	}
	fr := a.Items["page:about:fr"]
	if fr == nil || len(a.Saves) != 3 || !a.Saves[0].Bulk {
		t.Fatalf("fr %v saves %+v", fr, a.Saves)
	}
}

func TestEditFromStdin(t *testing.T) {
	h, a := signedIn(t)
	h.env.Stdin = strings.NewReader(`{"template":"page-default","content":{},"components":[{"name":"hero","template":"hero","content":{"title":"Piped"}}]}`)
	h.must(t, "pages", "edit", "home")
	if heroTitle(a, "home") != "Piped" {
		t.Fatalf("not saved")
	}
	h.env.Stdin = strings.NewReader(`not json`)
	if code := h.run("pages", "edit", "home"); code != output.Usage {
		t.Fatalf("bad JSON: %d", code)
	}
}

func TestCreate(t *testing.T) {
	h, a := signedIn(t)
	h.must(t, "pages", "create", "contact", "--template", "page-default")
	if a.Items["page:contact:"] == nil || !a.Saves[0].Bulk {
		t.Fatalf("not created: %+v", a.Saves)
	}
	h.must(t, "pages", "create", "home", "--template", "page-default", "--locale", "fr")
	if a.Items["page:home:fr"] == nil {
		t.Fatal("the language version wasn't created")
	}
	if code := h.run("pages", "create", "home", "--template", "page-default"); code != output.Conflict {
		t.Fatalf("existing name: %d", code)
	}
	if code := h.run("pages", "create", "x"); code != output.Usage {
		t.Fatalf("no template: %d", code)
	}
}

func TestTemplatesSchemaValidateStatusPreview(t *testing.T) {
	h, a := signedIn(t)
	h.must(t, "templates", "schema", "hero", "--json")
	if h.json(t)["type"] != "object" {
		t.Fatalf("schema %q", h.stdout.String())
	}

	h.must(t, "validate")
	if !strings.Contains(h.stdout.String(), "No issues.") {
		t.Fatalf("validate %q", h.stdout.String())
	}
	a.Set(func(a *fakeadmin.Admin) {
		a.Issues = []map[string]any{{"validator": "schema-conformance", "severity": "error", "message": "title: Required", "itemPath": "pages/home/page.json", "contentPath": "hero"}}
	})
	if code := h.run("validate", "--json"); code != output.Failure {
		t.Fatalf("validate with an error: %d", code)
	}
	if got := h.json(t); got["errors"] != float64(1) {
		t.Fatalf("validate --json %v", got)
	}

	h.must(t, "status")
	if !strings.Contains(h.stdout.String(), "1 unpublished change on staging") || !strings.Contains(h.stdout.String(), "modified: pages/home") {
		t.Fatalf("status %q", h.stdout.String())
	}

	h.must(t, "preview", "home", "--locale", "fr")
	if strings.TrimSpace(h.stdout.String()) != a.URL+"/admin/preview/fr" {
		t.Fatalf("preview url %q", h.stdout.String())
	}
	h.must(t, "preview", "@header", "--html")
	if !strings.Contains(h.stdout.String(), "preview of /@header") {
		t.Fatalf("preview html %q", h.stdout.String())
	}
}

// bumpAfterRead changes home's version on the fake after each read of it,
// as another writer saving in between would.
type bumpAfterRead struct{ a *fakeadmin.Admin }

func (b bumpAfterRead) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := http.DefaultTransport.RoundTrip(req)
	if err == nil && req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/api/v1/pages/home") {
		b.a.Set(func(a *fakeadmin.Admin) { a.Items["page:home:"].Version++ })
	}
	return res, err
}
