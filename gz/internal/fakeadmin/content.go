package fakeadmin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// Item is a stored page or fragment in the fake.
type Item struct {
	Manifest map[string]any
	Version  int
}

// Saves records each save the fake accepted: its kind, name, locale and run.
type Save struct {
	Kind, Name, Locale, Run string
	Bulk                    bool
}

// SeedContent stores a page and a fragment: `home` with a `hero` component,
// `about`, and `header`.
func (a *Admin) SeedContent() {
	a.Set(func(a *Admin) {
		a.Items = map[string]*Item{}
		hero := func(title string) []any {
			return []any{map[string]any{"name": "hero", "template": "hero", "content": map[string]any{"title": title}}}
		}
		a.Items[key("page", "home", "")] = &Item{Manifest: map[string]any{"template": "page-default", "content": map[string]any{}, "components": hero("Home")}, Version: 1}
		a.Items[key("page", "about", "")] = &Item{Manifest: map[string]any{"template": "page-default", "content": map[string]any{}, "components": hero("About")}, Version: 1}
		a.Items[key("fragment", "header", "")] = &Item{Manifest: map[string]any{"template": "header-layout", "content": map[string]any{}, "components": []any{}}, Version: 1}
	})
}

func key(kind, name, locale string) string { return kind + ":" + name + ":" + locale }

func etag(it *Item) string { return fmt.Sprintf("v%d", it.Version) }

func route(name, locale string) string {
	r := "/" + name
	if name == "home" {
		r = "/"
	}
	if locale != "" {
		r = strings.TrimSuffix("/"+locale+r, "/")
	}
	return r
}

// heroIssues is the fake's schema check: a hero component needs a title.
func heroIssues(name string, m map[string]any) []map[string]any {
	var issues []map[string]any
	comps, _ := m["components"].([]any)
	for _, c := range comps {
		comp, ok := c.(map[string]any)
		if !ok || comp["template"] != "hero" {
			continue
		}
		content, _ := comp["content"].(map[string]any)
		if t, _ := content["title"].(string); t == "" {
			issues = append(issues, map[string]any{
				"validator": "schema-conformance", "severity": "error", "message": "title: Required",
				"itemPath": "pages/" + name + "/page.json", "contentPath": comp["name"],
			})
		}
	}
	return issues
}

func problemWith(w http.ResponseWriter, status int, code string, extra map[string]any) {
	body := map[string]any{"type": "about:blank", "title": http.StatusText(status), "status": status, "code": code, "detail": "fake " + code}
	for k, v := range extra {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// serveContent answers the content routes; false when path isn't one.
func (a *Admin) serveContent(w http.ResponseWriter, r *http.Request, path string) bool {
	if a.Items == nil {
		return false
	}
	run := r.Header.Get("Gazetta-Run")
	q := r.URL.Query()
	locale := q.Get("locale")
	switch {
	case r.Method == "GET" && (path == "/api/v1/pages" || path == "/api/v1/fragments"):
		kind := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/"), "s")
		var rows []map[string]any
		for k, it := range a.Items {
			parts := strings.SplitN(k, ":", 3)
			if parts[0] != kind || parts[2] != "" {
				continue
			}
			row := map[string]any{"name": parts[1], "template": it.Manifest["template"]}
			if kind == "page" {
				row["route"] = route(parts[1], "")
			}
			rows = append(rows, row)
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i]["name"].(string) < rows[j]["name"].(string) })
		reply(w, 200, rows)
	case strings.HasPrefix(path, "/api/v1/pages/") || strings.HasPrefix(path, "/api/v1/fragments/"):
		kind, name := "page", strings.TrimPrefix(path, "/api/v1/pages/")
		if strings.HasPrefix(path, "/api/v1/fragments/") {
			kind, name = "fragment", strings.TrimPrefix(path, "/api/v1/fragments/")
		}
		name, _ = url.PathUnescape(name)
		it, ok := a.Items[key(kind, name, locale)]
		if !ok && locale != "" {
			it, ok = a.Items[key(kind, name, "")] // a missing language version reads as the default
		}
		if !ok {
			problem(w, 404, "NOT_FOUND")
			return true
		}
		switch r.Method {
		case "GET":
			body := map[string]any{"name": name}
			for k, v := range it.Manifest {
				body[k] = v
			}
			if kind == "page" {
				body["route"] = route(name, locale)
			}
			w.Header().Set("ETag", `"`+etag(it)+`"`)
			reply(w, 200, body)
		case "PUT":
			if strings.Trim(r.Header.Get("If-Match"), `"`) != etag(it) {
				problem(w, 409, "STALE")
				return true
			}
			var m map[string]any
			_ = json.NewDecoder(r.Body).Decode(&m)
			if issues := heroIssues(name, m); issues != nil {
				problemWith(w, 409, "VALIDATION_FAILED", map[string]any{"issues": issues})
				return true
			}
			saved := &Item{Manifest: m, Version: it.Version + 1}
			a.Items[key(kind, name, locale)] = saved
			a.Saves = append(a.Saves, Save{Kind: kind, Name: name, Locale: locale, Run: run})
			reply(w, 200, map[string]any{"ok": true, "etag": etag(saved)})
		default:
			problem(w, 405, "BAD_REQUEST")
		}
	case r.Method == "POST" && path == "/api/v1/saves":
		var body struct {
			Items []struct {
				Kind, Name, Locale, IfMatch, IfNoneMatch string
				Manifest                                 map[string]any
			}
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var failures []map[string]any
		for i, in := range body.Items {
			ref := map[string]any{"index": i, "kind": in.Kind, "name": in.Name}
			existing, exists := a.Items[key(in.Kind, in.Name, in.Locale)]
			base, baseOK := a.Items[key(in.Kind, in.Name, "")]
			switch {
			case in.IfNoneMatch == "*" && exists:
				ref["code"] = "LIVE_CONFLICT"
			case in.IfNoneMatch == "*" && in.Locale != "" && !baseOK:
				ref["code"] = "NOT_FOUND"
			case in.IfNoneMatch == "" && !exists && !(in.Locale != "" && baseOK):
				ref["code"] = "NOT_FOUND"
			case in.IfNoneMatch == "" && exists && in.IfMatch != etag(existing):
				ref["code"] = "STALE"
			case in.IfNoneMatch == "" && !exists && in.IfMatch != etag(base):
				ref["code"] = "STALE"
			default:
				if issues := heroIssues(in.Name, in.Manifest); issues != nil {
					ref["code"], ref["issues"] = "VALIDATION_FAILED", issues
				}
			}
			if ref["code"] != nil {
				failures = append(failures, ref)
			}
		}
		if failures != nil {
			problemWith(w, 409, "BATCH_REFUSED", map[string]any{"items": failures})
			return true
		}
		var items []map[string]any
		for i, in := range body.Items {
			version := 1
			if prev, ok := a.Items[key(in.Kind, in.Name, in.Locale)]; ok {
				version = prev.Version + 1
			}
			saved := &Item{Manifest: in.Manifest, Version: version}
			a.Items[key(in.Kind, in.Name, in.Locale)] = saved
			a.Saves = append(a.Saves, Save{Kind: in.Kind, Name: in.Name, Locale: in.Locale, Run: run, Bulk: true})
			items = append(items, map[string]any{"index": i, "kind": in.Kind, "name": in.Name, "locale": in.Locale, "etag": etag(saved)})
		}
		reply(w, 200, map[string]any{"ok": true, "revision": "rev-1", "items": items})
	case r.Method == "GET" && path == "/api/v1/templates/hero/schema":
		reply(w, 200, map[string]any{"type": "object", "properties": map[string]any{"title": map[string]any{"type": "string"}}, "required": []string{"title"}})
	case r.Method == "GET" && path == "/api/v1/validation/issues":
		reply(w, 200, map[string]any{"issues": a.Issues, "total": len(a.Issues)})
	case r.Method == "GET" && path == "/api/v1/targets":
		reply(w, 200, []map[string]any{
			{"name": "local", "environment": "local", "editable": true},
			{"name": "staging", "environment": "staging", "editable": false},
		})
	case r.Method == "GET" && path == "/api/v1/compare":
		reply(w, 200, map[string]any{"added": []string{}, "modified": []string{"pages/home"}, "deleted": []string{}, "unchanged": []string{}, "firstPublish": false, "invalidTemplates": []any{}, "target": q.Get("target")})
	case r.Method == "GET" && strings.HasPrefix(path, "/preview/"):
		if r.Header.Get("Gazetta-Token") == "" {
			problem(w, 401, "UNAUTHENTICATED")
			return true
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, "<html><body>preview of %s</body></html>", strings.TrimPrefix(path, "/preview"))
	default:
		return false
	}
	return true
}
