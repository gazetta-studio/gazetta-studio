// Package output writes gz results for people and agents, and owns the exit
// codes (design-agent-access.md Q38): readable text by default, JSON with
// --json, and never a prompt when stdin isn't a terminal.
package output

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// Exit codes.
const (
	OK         = 0
	Failure    = 1
	Usage      = 2
	NeedsLogin = 3 // login or elevation needed
	Conflict   = 4 // edited by someone else
	NotFound   = 5
)

var kinds = map[int]string{
	Failure:    "failure",
	Usage:      "usage",
	NeedsLogin: "needs_login",
	Conflict:   "conflict",
	NotFound:   "not_found",
}

// Error is a failure gz reports with its exit code. Hint tells the person
// what to run next.
type Error struct {
	Exit    int
	Message string
	Hint    string
}

func (e *Error) Error() string { return e.Message }

// Errorf builds an Error with the given exit code.
func Errorf(exit int, format string, args ...any) *Error {
	return &Error{Exit: exit, Message: fmt.Sprintf(format, args...)}
}

// WithHint returns the error with a hint.
func (e *Error) WithHint(hint string) *Error {
	e.Hint = hint
	return e
}

// Printer writes results and errors.
type Printer struct {
	Out  io.Writer
	Err  io.Writer
	JSON bool
}

// Result prints a command's result: text for people, data as JSON with --json.
func (p Printer) Result(text string, data any) error {
	if p.JSON {
		enc := json.NewEncoder(p.Out)
		enc.SetIndent("", "  ")
		return enc.Encode(data)
	}
	if text == "" {
		return nil
	}
	_, err := fmt.Fprintln(p.Out, text)
	return err
}

// Fail reports err and returns its exit code. With --json the error goes to
// stdout as {"error":{"kind","message","hint"}}, so an agent reads one stream.
func (p Printer) Fail(err error) int {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Exit: Failure, Message: err.Error()}
	}
	if p.JSON {
		body := map[string]any{"kind": kinds[e.Exit], "message": e.Message}
		if e.Hint != "" {
			body["hint"] = e.Hint
		}
		enc := json.NewEncoder(p.Out)
		enc.SetIndent("", "  ")
		_ = enc.Encode(map[string]any{"error": body})
		return e.Exit
	}
	fmt.Fprintf(p.Err, "gz: %s\n", e.Message)
	if e.Hint != "" {
		fmt.Fprintln(p.Err, e.Hint)
	}
	return e.Exit
}

// Interactive reports whether f is a terminal; gz never prompts otherwise.
func Interactive(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
