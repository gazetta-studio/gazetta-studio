// Package content is gz's content service (design-agent-access.md Q37):
// reading, saving and creating pages and fragments through an admin's API,
// one item with the single save and several with the bulk save (#1720).
// Every request carries the command's run id (Q22). Commands parse their
// arguments and call one method here.
package content

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/api"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/session"
)

// Kind is an item kind: a page or a fragment.
type Kind string

const (
	Page     Kind = "page"
	Fragment Kind = "fragment"
)

// Plural is the kind's API collection and command name.
func (k Kind) Plural() string { return string(k) + "s" }

// RunHeader carries the run id (Q22, cut 5).
const RunHeader = "Gazetta-Run"

// Service talks to one admin as one run.
type Service struct {
	API *api.ClientWithResponses
	// Run is the run id every request carries.
	Run string
}

func (s *Service) run(_ context.Context, req *http.Request) error {
	req.Header.Set(RunHeader, s.Run)
	return nil
}

// fail turns a failed response into gz's error; nil on success.
func fail(res *http.Response, body []byte) error {
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	return session.ProblemOf(res, body).Error()
}

func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Summary is one row of a list.
type Summary struct {
	Name     string   `json:"name"`
	Route    string   `json:"route,omitempty"`
	Template string   `json:"template,omitempty"`
	Locales  []string `json:"locales,omitempty"`
	Archived bool     `json:"archived,omitempty"`
}

// List lists every item of a kind.
func (s *Service) List(ctx context.Context, kind Kind) ([]Summary, error) {
	var res *http.Response
	var body []byte
	if kind == Page {
		r, err := s.API.GetApiV1PagesWithResponse(ctx, &api.GetApiV1PagesParams{}, s.run)
		if err != nil {
			return nil, err
		}
		res, body = r.HTTPResponse, r.Body
	} else {
		r, err := s.API.GetApiV1FragmentsWithResponse(ctx, &api.GetApiV1FragmentsParams{}, s.run)
		if err != nil {
			return nil, err
		}
		res, body = r.HTTPResponse, r.Body
	}
	if err := fail(res, body); err != nil {
		return nil, err
	}
	var rows []Summary
	return rows, json.Unmarshal(body, &rows)
}

// Item is one item as stored: its editable manifest and its save-version.
type Item struct {
	Kind   Kind   `json:"kind"`
	Name   string `json:"name"`
	Locale string `json:"locale,omitempty"`
	// Route is where the page is served; empty for a fragment.
	Route    string         `json:"route,omitempty"`
	Etag     string         `json:"etag"`
	Manifest map[string]any `json:"manifest"`
}

// editableFields are the manifest fields a save writes (SavePageRequest).
var editableFields = []string{"template", "content", "components", "metadata", "cache"}

// Get reads an item.
func (s *Service) Get(ctx context.Context, kind Kind, name, locale string) (Item, error) {
	var res *http.Response
	var body []byte
	if kind == Page {
		r, err := s.API.GetApiV1PagesNameWithResponse(ctx, name, &api.GetApiV1PagesNameParams{Locale: opt(locale)}, s.run)
		if err != nil {
			return Item{}, err
		}
		res, body = r.HTTPResponse, r.Body
	} else {
		r, err := s.API.GetApiV1FragmentsNameWithResponse(ctx, name, &api.GetApiV1FragmentsNameParams{Locale: opt(locale)}, s.run)
		if err != nil {
			return Item{}, err
		}
		res, body = r.HTTPResponse, r.Body
	}
	if err := fail(res, body); err != nil {
		return Item{}, err
	}
	var detail map[string]any
	if err := json.Unmarshal(body, &detail); err != nil {
		return Item{}, err
	}
	manifest := map[string]any{}
	for _, f := range editableFields {
		if v, ok := detail[f]; ok {
			manifest[f] = v
		}
	}
	route, _ := detail["route"].(string)
	etag := strings.Trim(res.Header.Get("ETag"), `"`)
	return Item{Kind: kind, Name: name, Locale: locale, Route: route, Etag: etag, Manifest: manifest}, nil
}

// Saved is an item after a save, with its new save-version.
type Saved struct {
	Kind   Kind   `json:"kind"`
	Name   string `json:"name"`
	Locale string `json:"locale,omitempty"`
	Etag   string `json:"etag"`
}

// Result is what a save answered.
type Result struct {
	Run      string  `json:"run"`
	Revision string  `json:"revision,omitempty"`
	Items    []Saved `json:"items"`
}

// Save saves one item with the save-version it was read at.
func (s *Service) Save(ctx context.Context, it Item) (Result, error) {
	body, err := json.Marshal(it.Manifest)
	if err != nil {
		return Result{}, err
	}
	var res *http.Response
	var out []byte
	if it.Kind == Page {
		params := &api.PutApiV1PagesNameParams{Locale: opt(it.Locale), IfMatch: opt(quoted(it.Etag))}
		r, err := s.API.PutApiV1PagesNameWithBodyWithResponse(ctx, it.Name, params, "application/json", bytes.NewReader(body), s.run)
		if err != nil {
			return Result{}, err
		}
		res, out = r.HTTPResponse, r.Body
	} else {
		params := &api.PutApiV1FragmentsNameParams{Locale: opt(it.Locale), IfMatch: opt(quoted(it.Etag))}
		r, err := s.API.PutApiV1FragmentsNameWithBodyWithResponse(ctx, it.Name, params, "application/json", bytes.NewReader(body), s.run)
		if err != nil {
			return Result{}, err
		}
		res, out = r.HTTPResponse, r.Body
	}
	if err := fail(res, out); err != nil {
		return Result{}, err
	}
	var saved struct {
		Etag string `json:"etag"`
	}
	if err := json.Unmarshal(out, &saved); err != nil {
		return Result{}, err
	}
	return Result{Run: s.Run, Items: []Saved{{it.Kind, it.Name, it.Locale, saved.Etag}}}, nil
}

func quoted(etag string) string {
	if etag == "" {
		return ""
	}
	return `"` + etag + `"`
}

// SaveMany saves several items as one all-or-nothing batch (Q46). An item
// without a save-version is created.
func (s *Service) SaveMany(ctx context.Context, items []Item) (Result, error) {
	type wireItem struct {
		Kind        Kind           `json:"kind"`
		Name        string         `json:"name"`
		Locale      string         `json:"locale,omitempty"`
		Manifest    map[string]any `json:"manifest"`
		IfMatch     string         `json:"ifMatch,omitempty"`
		IfNoneMatch string         `json:"ifNoneMatch,omitempty"`
	}
	wire := make([]wireItem, len(items))
	for i, it := range items {
		wire[i] = wireItem{Kind: it.Kind, Name: it.Name, Locale: it.Locale, Manifest: it.Manifest, IfMatch: it.Etag}
		if it.Etag == "" {
			wire[i].IfNoneMatch = "*"
		}
	}
	body, err := json.Marshal(map[string]any{"items": wire})
	if err != nil {
		return Result{}, err
	}
	r, err := s.API.PostApiV1SavesWithBodyWithResponse(ctx, &api.PostApiV1SavesParams{GazettaRun: s.Run}, "application/json", bytes.NewReader(body), s.run)
	if err != nil {
		return Result{}, err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return Result{}, err
	}
	var out struct {
		Revision string  `json:"revision"`
		Items    []Saved `json:"items"`
	}
	if err := json.Unmarshal(r.Body, &out); err != nil {
		return Result{}, err
	}
	return Result{Run: s.Run, Revision: out.Revision, Items: out.Items}, nil
}

// Create creates an item, or a language version of one that exists, through
// the bulk save, so it's checked and recorded in the run like any save.
func (s *Service) Create(ctx context.Context, kind Kind, name, locale, template string) (Result, error) {
	manifest := map[string]any{"template": template, "content": map[string]any{}, "components": []any{}}
	return s.SaveMany(ctx, []Item{{Kind: kind, Name: name, Locale: locale, Manifest: manifest}})
}

// TemplateSchema is a template's JSON Schema.
func (s *Service) TemplateSchema(ctx context.Context, name string) (json.RawMessage, error) {
	r, err := s.API.GetApiV1TemplatesNameSchemaWithResponse(ctx, name, &api.GetApiV1TemplatesNameSchemaParams{}, s.run)
	if err != nil {
		return nil, err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return nil, err
	}
	return json.RawMessage(r.Body), nil
}

// Issues are the site's current validation issues.
func (s *Service) Issues(ctx context.Context) ([]session.Issue, error) {
	r, err := s.API.GetApiV1ValidationIssuesWithResponse(ctx, &api.GetApiV1ValidationIssuesParams{}, s.run)
	if err != nil {
		return nil, err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return nil, err
	}
	var out struct {
		Issues []session.Issue `json:"issues"`
	}
	return out.Issues, json.Unmarshal(r.Body, &out)
}

// Target is one of the admin's targets.
type Target struct {
	Name        string `json:"name"`
	Environment string `json:"environment"`
	Editable    bool   `json:"editable"`
}

// Targets lists the admin's targets.
func (s *Service) Targets(ctx context.Context) ([]Target, error) {
	r, err := s.API.GetApiV1TargetsWithResponse(ctx, &api.GetApiV1TargetsParams{}, s.run)
	if err != nil {
		return nil, err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return nil, err
	}
	var targets []Target
	return targets, json.Unmarshal(r.Body, &targets)
}

// Comparison is how the editable target differs from another.
type Comparison struct {
	Added    []string `json:"added"`
	Modified []string `json:"modified"`
	Deleted  []string `json:"deleted"`
}

// Compare compares the editable target with target.
func (s *Service) Compare(ctx context.Context, target string) (Comparison, error) {
	r, err := s.API.GetApiV1CompareWithResponse(ctx, &api.GetApiV1CompareParams{Target: &target}, s.run)
	if err != nil {
		return Comparison{}, err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return Comparison{}, err
	}
	var c Comparison
	return c, json.Unmarshal(r.Body, &c)
}

// PreviewPath is an item's preview path below the admin's API base:
// `/preview/<route>` for a page, `/preview/@<name>` for a fragment.
func PreviewPath(kind Kind, name, route string) string {
	if kind == Fragment {
		return "/preview/@" + name
	}
	return "/preview" + route
}

// PreviewHTML fetches an item's preview through gz's signed-in client, for
// agents that can't send the login headers themselves (Q11).
func (s *Service) PreviewHTML(ctx context.Context, path string) (string, error) {
	client, ok := s.API.ClientInterface.(*api.Client)
	if !ok {
		return "", fmt.Errorf("the API client can't fetch a preview")
	}
	u, err := url.JoinPath(client.Server, path)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	for _, edit := range append(client.RequestEditors, s.run) {
		if err := edit(ctx, req); err != nil {
			return "", err
		}
	}
	res, err := client.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	if err := fail(res, body); err != nil {
		return "", err
	}
	return string(body), nil
}

// PreviewURL is an item's preview URL on the admin; it sits behind the
// admin's login layer like the API.
func (s *Service) PreviewURL(path string) string {
	if client, ok := s.API.ClientInterface.(*api.Client); ok {
		if u, err := url.JoinPath(client.Server, path); err == nil {
			return u
		}
	}
	return path
}

// Published is one destination's publish result.
type Published struct {
	Target      string `json:"target"`
	Success     bool   `json:"success"`
	Error       string `json:"error,omitempty"`
	CopiedFiles int    `json:"copiedFiles"`
}

// Publish publishes items (`pages/home`, `fragments/header`, `pages/home:fr`)
// to targets. A refusal comes back as the problem, so the caller can start
// the elevation it names (Q29).
func (s *Service) Publish(ctx context.Context, items, targets []string) ([]Published, *session.Problem, error) {
	body, err := json.Marshal(map[string]any{"items": items, "targets": targets})
	if err != nil {
		return nil, nil, err
	}
	r, err := s.API.PostApiV1PublishWithBodyWithResponse(ctx, &api.PostApiV1PublishParams{}, "application/json", bytes.NewReader(body), s.run)
	if err != nil {
		return nil, nil, err
	}
	// 207: some destinations failed; each result says which.
	if r.StatusCode() != http.StatusOK && r.StatusCode() != http.StatusMultiStatus {
		p := session.ProblemOf(r.HTTPResponse, r.Body)
		return nil, &p, nil
	}
	var out struct {
		Results []Published `json:"results"`
	}
	return out.Results, nil, json.Unmarshal(r.Body, &out)
}

// Asset is one asset in the library.
type Asset struct {
	Name string  `json:"name"`
	Kind string  `json:"kind"`
	Mime string  `json:"mime"`
	Size int64   `json:"size"`
	Alt  *string `json:"alt"`
}

// Assets lists the asset library.
func (s *Service) Assets(ctx context.Context) ([]Asset, error) {
	r, err := s.API.GetApiV1AssetsWithResponse(ctx, &api.GetApiV1AssetsParams{}, s.run)
	if err != nil {
		return nil, err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return nil, err
	}
	var assets []Asset
	return assets, json.Unmarshal(r.Body, &assets)
}

// Upload uploads a file as asset name; alt nil leaves it unset, "" marks it
// decorative. It returns the name the admin saved it under.
func (s *Service) Upload(ctx context.Context, filename string, data []byte, name string, alt *string) (string, error) {
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, err := form.CreateFormFile("file", filepath.Base(filename))
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	_ = form.WriteField("name", name)
	if alt != nil {
		_ = form.WriteField("alt", *alt)
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	r, err := s.API.PostApiV1AssetsWithBodyWithResponse(ctx, &api.PostApiV1AssetsParams{}, form.FormDataContentType(), &buf, s.run)
	if err != nil {
		return "", err
	}
	if err := fail(r.HTTPResponse, r.Body); err != nil {
		return "", err
	}
	var out struct {
		Manifest struct {
			Name string `json:"name"`
		} `json:"manifest"`
	}
	if err := json.Unmarshal(r.Body, &out); err != nil {
		return "", err
	}
	return out.Manifest.Name, nil
}

// SetAlt sets an asset's alt text; "" marks it decorative.
func (s *Service) SetAlt(ctx context.Context, name, alt string) error {
	body, _ := json.Marshal(map[string]string{"alt": alt})
	r, err := s.API.PatchApiV1AssetsNameWithBodyWithResponse(ctx, name, &api.PatchApiV1AssetsNameParams{}, "application/json", bytes.NewReader(body), s.run)
	if err != nil {
		return err
	}
	return fail(r.HTTPResponse, r.Body)
}
