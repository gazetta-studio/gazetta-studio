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
	switch p.Code {
	case "UNAUTHENTICATED", "TOKEN_REQUIRED", "GRANT_INVALID", "GRANT_EXPIRED",
		"ELEVATION_REQUIRED", "TOKEN_EDIT_ONLY":
		return output.NeedsLogin
	case "STALE", "CONFLICT":
		return output.Conflict
	case "NOT_FOUND":
		return output.NotFound
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
	return output.Errorf(exitFor(p), "%s", msg)
}
