package session

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

// Problem is an admin API error (RFC 9457, design-agent-access.md Q45).
// Unknown codes are kept as they are (Q43).
type Problem struct {
	Status int    `json:"status"`
	Code   string `json:"code"`
	Detail string `json:"detail"`
	Title  string `json:"title"`
	// Issues are a save's validation failures (VALIDATION_FAILED).
	Issues []Issue `json:"issues,omitempty"`
	// Items are a bulk save's failing items (BATCH_REFUSED).
	Items []ItemProblem `json:"items,omitempty"`
}

// Issue is one validation failure: a field path and its message.
type Issue struct {
	Validator   string `json:"validator"`
	Severity    string `json:"severity"`
	Message     string `json:"message"`
	ItemPath    string `json:"itemPath"`
	ContentPath string `json:"contentPath,omitempty"`
}

// ItemProblem is one item a bulk save refused, with its own code.
type ItemProblem struct {
	Index  int     `json:"index"`
	Kind   string  `json:"kind"`
	Name   string  `json:"name"`
	Locale string  `json:"locale,omitempty"`
	Code   string  `json:"code"`
	Detail string  `json:"detail,omitempty"`
	Issues []Issue `json:"issues,omitempty"`
}

// ProblemOf reads the problem in a failed response's body. A body that
// isn't a problem (a proxy's HTML page, say) keeps only the status.
func ProblemOf(res *http.Response, body []byte) Problem {
	p := Problem{Status: res.StatusCode}
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/problem+json") {
		_ = json.Unmarshal(body, &p)
	}
	if p.Title == "" {
		p.Title = http.StatusText(res.StatusCode)
	}
	return p
}

// exitFor maps a problem to gz's exit codes (Q38).
func exitFor(p Problem) int {
	if p.Code == "BATCH_REFUSED" {
		// The batch's exit is its items': a conflict wins, then not found.
		exit := output.Failure
		for _, it := range p.Items {
			switch e := exitFor(Problem{Code: it.Code}); {
			case e == output.Conflict:
				return e
			case e == output.NotFound:
				exit = e
			}
		}
		return exit
	}
	switch p.Code {
	case "UNAUTHENTICATED", "TOKEN_REQUIRED", "GRANT_INVALID", "GRANT_EXPIRED",
		"ELEVATION_REQUIRED", "TOKEN_EDIT_ONLY":
		return output.NeedsLogin
	case "STALE", "CONFLICT", "LIVE_CONFLICT":
		return output.Conflict
	case "NOT_FOUND":
		return output.NotFound
	case "VALIDATION_FAILED", "HOOK_CANCELLED", "EDIT_LOCKED", "ARCHIVED", "BATCH_TOO_LARGE":
		// The content or the item refused the save, not a concurrent edit.
		return output.Failure
	}
	switch p.Status {
	case http.StatusUnauthorized:
		return output.NeedsLogin
	case http.StatusNotFound:
		return output.NotFound
	case http.StatusConflict, http.StatusPreconditionFailed:
		return output.Conflict
	}
	return output.Failure
}

// Error turns a problem into gz's error, with its exit code.
func (p Problem) Error() *output.Error {
	msg := p.Detail
	if msg == "" {
		msg = p.Title
	}
	if p.Code != "" {
		msg = fmt.Sprintf("%s (%s)", msg, p.Code)
	}
	var b strings.Builder
	b.WriteString(msg)
	writeIssues(&b, "  ", p.Issues)
	for _, it := range p.Items {
		name := it.Kind + " " + it.Name
		if it.Locale != "" {
			name += " (" + it.Locale + ")"
		}
		fmt.Fprintf(&b, "\n  %s: %s", name, it.Code)
		if it.Detail != "" {
			fmt.Fprintf(&b, ": %s", it.Detail)
		}
		writeIssues(&b, "    ", it.Issues)
	}
	return output.Errorf(exitFor(p), "%s", b.String())
}

// writeIssues lists issues as "at <component>: <field>: <message>".
func writeIssues(b *strings.Builder, indent string, issues []Issue) {
	for _, is := range issues {
		where := ""
		if is.ContentPath != "" {
			where = "at " + is.ContentPath + ": "
		}
		fmt.Fprintf(b, "\n%s%s%s", indent, where, is.Message)
	}
}
