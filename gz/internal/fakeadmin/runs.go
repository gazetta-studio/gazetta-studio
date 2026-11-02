package fakeadmin

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Runs is the fake's run state: the items GET /api/v1/runs/:id lists, by
// run id, and each revert asked for.
type Runs struct {
	Items map[string][]map[string]any
	// Reverts lists each revert: the run id, its own run id, and the forced items.
	Reverts []Revert
}

// Revert is one revert the fake answered.
type Revert struct {
	RunID, RevertRun string
	Force            []string
}

// SeedRuns stores run r1: home edited, about changed since, promo created.
func (a *Admin) SeedRuns() {
	a.Set(func(a *Admin) {
		a.Runs = &Runs{Items: map[string][]map[string]any{
			"r1": {
				{"item": "pages.home", "kind": "page", "name": "home", "created": false, "changed": false, "restorable": true},
				{"item": "pages.about", "kind": "page", "name": "about", "created": false, "changed": true, "restorable": true},
				{"item": "pages.promo", "kind": "page", "name": "promo", "created": true, "changed": false, "restorable": true},
			},
		}}
	})
}

func (a *Admin) serveRuns(w http.ResponseWriter, r *http.Request, path string) bool {
	if a.Runs == nil || !strings.HasPrefix(path, "/api/v1/runs/") {
		return false
	}
	rest := strings.TrimPrefix(path, "/api/v1/runs/")
	id, action, _ := strings.Cut(rest, "/")
	items, ok := a.Runs.Items[id]
	if !ok {
		problem(w, 404, "NOT_FOUND")
		return true
	}
	switch {
	case r.Method == "GET" && action == "":
		reply(w, 200, map[string]any{"runId": id, "items": items})
	case r.Method == "POST" && action == "revert":
		var body struct{ Force []string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		revertRun := r.Header.Get("Gazetta-Run")
		a.Runs.Reverts = append(a.Runs.Reverts, Revert{id, revertRun, body.Force})
		var out []map[string]any
		for _, it := range items {
			status := "reverted"
			switch {
			case it["changed"] == true && !contains(body.Force, it["item"].(string)):
				status = "skipped-changed"
			case it["created"] == true:
				status = "archived"
			}
			out = append(out, map[string]any{"item": it["item"], "kind": it["kind"], "name": it["name"], "status": status})
		}
		reply(w, 200, map[string]any{"runId": id, "revertRun": revertRun, "items": out})
	default:
		return false
	}
	return true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
