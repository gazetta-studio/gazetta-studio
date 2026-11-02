package fakeadmin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ElevationCode is the code a started elevation shows.
const ElevationCode = "ELEV-0001"

// Elevations is the fake's elevation, publish and asset state, after
// SeedPublish.
type Elevations struct {
	// Decision is what redeem answers once the elevation has been polled
	// PendingPolls times: "" elevates, "denied" or "expired".
	Decision     string
	PendingPolls int
	Polls        int
	// Started lists each elevation asked for, by scope.
	Started []string
	// Active maps elevation ids to their scope; Ended lists ended ids.
	Active map[string]string
	Ended  []string
	// Targets maps target names to the scope an elevation needs there.
	Targets map[string]string
	// Published lists each publish that went through: items, then targets.
	Published [][]string
	// FailTarget makes publishing to that target fail (207).
	// Refuse makes publish answer ELEVATION_REQUIRED for this scope even
	// when it's covered, as a revoked role would.
	FailTarget string
	Refuse     string
	// Assets is what GET /api/v1/assets answers; uploads and alt edits change it.
	Assets []map[string]any
}

// SeedPublish sets up two targets and one asset.
func (a *Admin) SeedPublish() {
	a.Set(func(a *Admin) {
		a.Elevation = &Elevations{
			Active:  map[string]string{},
			Targets: map[string]string{"staging": "non-production", "production": "production"},
			Assets: []map[string]any{
				{"name": "hero", "kind": "embedded", "mime": "image/jpeg", "size": 1024, "alt": nil},
			},
		}
	})
}

// servePublish answers the elevation, publish and asset routes; false when
// the path isn't one of them.
func (a *Admin) servePublish(w http.ResponseWriter, r *http.Request, path string) bool {
	e := a.Elevation
	if e == nil {
		return false
	}
	switch {
	case r.Method == "POST" && path == "/api/v1/auth/elevations":
		var body struct{ Scope string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		e.Started = append(e.Started, body.Scope)
		reply(w, 201, map[string]any{
			"code": ElevationCode, "approveUrl": a.URL + "/admin/cli-login/" + ElevationCode, "pollSecret": "poll",
			"expiresAt": a.Now().Add(a.CodeTTL).UTC().Format(time.RFC3339),
		})
	case r.Method == "POST" && path == "/api/v1/auth/logins/"+ElevationCode+"/redeem":
		e.Polls++
		if e.Polls <= e.PendingPolls {
			reply(w, 200, map[string]any{"status": "pending"})
			return true
		}
		switch e.Decision {
		case "denied":
			problem(w, 403, "LOGIN_DENIED")
		case "expired":
			problem(w, 410, "LOGIN_EXPIRED")
		default:
			id := fmt.Sprintf("el-%d", len(e.Started))
			e.Active[id] = e.Started[len(e.Started)-1]
			reply(w, 200, map[string]any{
				"status": "elevated", "elevationId": id,
				"endsAt": a.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339),
			})
		}
	case r.Method == "DELETE" && strings.HasPrefix(path, "/api/v1/auth/elevations/"):
		id := strings.TrimPrefix(path, "/api/v1/auth/elevations/")
		if _, ok := e.Active[id]; !ok {
			problem(w, 404, "NOT_FOUND")
			return true
		}
		delete(e.Active, id)
		e.Ended = append(e.Ended, id)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == "POST" && path == "/api/v1/publish":
		var body struct{ Items, Targets []string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		// As the real route does: non-production rights for every publish
		// (the route's middleware), then production for production targets.
		scopes := []string{"non-production"}
		for _, t := range body.Targets {
			if e.Targets[t] == "production" {
				scopes = append(scopes, "production")
			}
		}
		for _, scope := range scopes {
			if !e.covers(scope) {
				w.Header().Set("Content-Type", "application/problem+json")
				w.WriteHeader(403)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"type": "about:blank", "title": "Forbidden", "status": 403, "code": "ELEVATION_REQUIRED",
					"detail": fmt.Sprintf(`"publish" needs an elevation for %s targets`, scope), "scope": scope,
				})
				return true
			}
		}
		e.Published = append(e.Published, append(append([]string{}, body.Items...), body.Targets...))
		status, results := 200, []map[string]any{}
		for _, t := range body.Targets {
			if t == e.FailTarget {
				status = 207
				results = append(results, map[string]any{"target": t, "success": false, "error": "fake failure", "copiedFiles": 0})
				continue
			}
			results = append(results, map[string]any{"target": t, "success": true, "copiedFiles": 2 * len(body.Items)})
		}
		reply(w, status, map[string]any{"results": results})
	case r.Method == "GET" && path == "/api/v1/assets":
		reply(w, 200, e.Assets)
	case r.Method == "POST" && path == "/api/v1/assets":
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			problem(w, 400, "INVALID")
			return true
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			problem(w, 400, "INVALID")
			return true
		}
		defer file.Close()
		name := r.FormValue("name")
		for _, as := range e.Assets {
			if as["name"] == name {
				name += "-2" // an upload never replaces (design-media.md M2)
			}
		}
		var alt any
		if vs, ok := r.MultipartForm.Value["alt"]; ok {
			alt = vs[0]
		}
		e.Assets = append(e.Assets, map[string]any{"name": name, "kind": "embedded", "mime": header.Header.Get("Content-Type"), "size": header.Size, "alt": alt})
		reply(w, 201, map[string]any{"manifest": map[string]any{"name": name}})
	case r.Method == "PATCH" && strings.HasPrefix(path, "/api/v1/assets/"):
		name := strings.TrimPrefix(path, "/api/v1/assets/")
		var body struct{ Alt string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, as := range e.Assets {
			if as["name"] == name {
				as["alt"] = body.Alt
				reply(w, 200, as)
				return true
			}
		}
		problem(w, 404, "ASSET_NOT_FOUND")
	default:
		return false
	}
	return true
}

func (e *Elevations) covers(scope string) bool {
	if scope == e.Refuse {
		return false
	}
	for _, s := range e.Active {
		if s == scope {
			return true
		}
	}
	return false
}
