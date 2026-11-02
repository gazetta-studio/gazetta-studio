package manifestpath

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func manifest(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	err := json.Unmarshal([]byte(`{
		"template": "page-default",
		"content": {},
		"components": [
			"@header",
			{"name": "hero", "template": "hero", "content": {"title": "Old"}},
			{"name": "cols", "template": "two-column", "content": {}, "components": [
				{"name": "left", "template": "text-block", "content": {"heading": "L"}}
			]}
		]
	}`), &m)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func files(name string) ([]byte, error) {
	switch name {
	case "title.txt":
		return []byte("From a file"), nil
	case "tags.json":
		return []byte(`["a", "b"]`), nil
	}
	return nil, errors.New("no such file")
}

func set(t *testing.T, m map[string]any, arg string) {
	t.Helper()
	a, err := Parse(arg, files)
	if err != nil {
		t.Fatalf("Parse(%q): %v", arg, err)
	}
	if err := Apply(m, a); err != nil {
		t.Fatalf("Apply(%q): %v", arg, err)
	}
}

func at(m map[string]any, path ...any) any {
	var node any = m
	for _, p := range path {
		switch k := p.(type) {
		case string:
			node = node.(map[string]any)[k]
		case int:
			node = node.([]any)[k]
		}
	}
	return node
}

func TestSetsValues(t *testing.T) {
	for _, tc := range []struct {
		arg  string
		path []any
		want any
	}{
		{"components.hero.content.title=Spring", []any{"components", 1, "content", "title"}, "Spring"},
		{"components.1.content.title=By index", []any{"components", 1, "content", "title"}, "By index"},
		{"components.cols.components.left.content.heading=Nested", []any{"components", 2, "components", 0, "content", "heading"}, "Nested"},
		{"content.count:=3", []any{"content", "count"}, float64(3)},
		{"content.flag:=true", []any{"content", "flag"}, true},
		{"content.title:=null", []any{"content", "title"}, nil},
		{"content.list:=[1,2]", []any{"content", "list"}, []any{float64(1), float64(2)}},
		{"content.title=@title.txt", []any{"content", "title"}, "From a file"},
		{"content.tags:=@tags.json", []any{"content", "tags"}, []any{"a", "b"}},
		{"content.number=3", []any{"content", "number"}, "3"},
		{"content.eq=a=b", []any{"content", "eq"}, "a=b"},
		{"metadata.og.title=Created", []any{"metadata", "og", "title"}, "Created"},
		{"template=other", []any{"template"}, "other"},
	} {
		t.Run(tc.arg, func(t *testing.T) {
			m := manifest(t)
			set(t, m, tc.arg)
			if got := at(m, tc.path...); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestRefusesBadAssignments(t *testing.T) {
	for _, tc := range []struct{ arg, want string }{
		{"no-equals", "isn't path=value"},
		{"=x", "no path"},
		{"a..b=x", "empty path segment"},
		{"content.x:=not json", "not JSON"},
		{"content.x=@missing.txt", "no such file"},
	} {
		t.Run(tc.arg, func(t *testing.T) {
			if _, err := Parse(tc.arg, files); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Parse(%q) = %v, want an error containing %q", tc.arg, err, tc.want)
			}
		})
	}
}

func TestRefusesPathsThatDontFit(t *testing.T) {
	for _, tc := range []struct{ arg, want string }{
		{"components.missing.content.title=x", `no element named "missing"`},
		{"components.9.content=x", "outside the array"},
		{"template.sub=x", "isn't an object or array"},
		{"components.header.content=x", `no element named "header"`},
	} {
		t.Run(tc.arg, func(t *testing.T) {
			a, err := Parse(tc.arg, files)
			if err != nil {
				t.Fatal(err)
			}
			if err := Apply(manifest(t), a); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Apply(%q) = %v, want an error containing %q", tc.arg, err, tc.want)
			}
		})
	}
}

func TestIsAssignment(t *testing.T) {
	if IsAssignment("home") || !IsAssignment("content.x=1") || !IsAssignment("content.x:=1") {
		t.Error("IsAssignment misclassified")
	}
}
