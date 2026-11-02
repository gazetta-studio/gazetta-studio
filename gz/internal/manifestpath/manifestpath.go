// Package manifestpath applies `gz pages set` assignments to a manifest
// (design-agent-access.md Q37). The syntax follows httpie:
//
//	path=value     a string
//	path:=json     any JSON value (number, boolean, null, array, object)
//	path=@file     the file's contents, as a string
//	path:=@file    the file's contents, parsed as JSON
//
// A path is dot-separated keys. Inside an array a segment is either an
// index (`components.0`) or the `name` of an element, so components are
// addressed by name: `components.hero.content.title=Spring`. Missing
// object keys along the path are created; array elements are not.
package manifestpath

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Assignment sets Value at Path.
type Assignment struct {
	Path  []string
	Value any
}

// IsAssignment reports whether arg is an assignment rather than an item name.
func IsAssignment(arg string) bool { return strings.Contains(arg, "=") }

// Parse reads one assignment. readFile returns a file's contents for `@file`.
func Parse(arg string, readFile func(string) ([]byte, error)) (Assignment, error) {
	path, raw, ok := strings.Cut(arg, "=")
	if !ok {
		return Assignment{}, fmt.Errorf("%q isn't path=value", arg)
	}
	isJSON := strings.HasSuffix(path, ":")
	path = strings.TrimSuffix(path, ":")
	if path == "" {
		return Assignment{}, fmt.Errorf("%q has no path before =", arg)
	}
	segments := strings.Split(path, ".")
	for _, s := range segments {
		if s == "" {
			return Assignment{}, fmt.Errorf("%q has an empty path segment", arg)
		}
	}
	text := raw
	if strings.HasPrefix(raw, "@") {
		b, err := readFile(raw[1:])
		if err != nil {
			return Assignment{}, fmt.Errorf("%s: %w", path, err)
		}
		text = string(b)
	}
	if !isJSON {
		return Assignment{Path: segments, Value: text}, nil
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return Assignment{}, fmt.Errorf("%s: not JSON (use = for a string): %v", path, err)
	}
	return Assignment{Path: segments, Value: v}, nil
}

// Apply sets a.Value inside doc.
func Apply(doc map[string]any, a Assignment) error {
	var node any = doc
	for i, seg := range a.Path {
		last := i == len(a.Path)-1
		where := strings.Join(a.Path[:i+1], ".")
		switch n := node.(type) {
		case map[string]any:
			if last {
				n[seg] = a.Value
				return nil
			}
			next, ok := n[seg]
			if !ok || next == nil {
				next = map[string]any{}
				n[seg] = next
			}
			node = next
		case []any:
			idx, err := elementIndex(n, seg)
			if err != nil {
				return fmt.Errorf("%s: %v", where, err)
			}
			if last {
				n[idx] = a.Value
				return nil
			}
			node = n[idx]
		default:
			return fmt.Errorf("%s: %s isn't an object or array", where, strings.Join(a.Path[:i], "."))
		}
	}
	return nil
}

// elementIndex finds seg in an array: an index, or the element named seg.
func elementIndex(arr []any, seg string) (int, error) {
	if i, err := strconv.Atoi(seg); err == nil {
		if i < 0 || i >= len(arr) {
			return 0, fmt.Errorf("index %d is outside the array (length %d)", i, len(arr))
		}
		return i, nil
	}
	for i, el := range arr {
		if m, ok := el.(map[string]any); ok && m["name"] == seg {
			return i, nil
		}
	}
	return 0, fmt.Errorf("no element named %q", seg)
}
