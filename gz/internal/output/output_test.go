package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

func TestFailExitCodesAndKinds(t *testing.T) {
	cases := []struct {
		exit int
		kind string
	}{
		{Failure, "failure"},
		{Usage, "usage"},
		{NeedsLogin, "needs_login"},
		{Conflict, "conflict"},
		{NotFound, "not_found"},
	}
	for _, c := range cases {
		var out bytes.Buffer
		p := Printer{Out: &out, Err: &out, JSON: true}
		if got := p.Fail(Errorf(c.exit, "boom").WithHint("try this")); got != c.exit {
			t.Fatalf("exit %d: Fail returned %d", c.exit, got)
		}
		var body struct {
			Error struct{ Kind, Message, Hint string }
		}
		if err := json.Unmarshal(out.Bytes(), &body); err != nil {
			t.Fatalf("exit %d: %v in %q", c.exit, err, out.String())
		}
		if body.Error.Kind != c.kind || body.Error.Message != "boom" || body.Error.Hint != "try this" {
			t.Fatalf("exit %d: body %+v", c.exit, body)
		}
	}
}

func TestPlainErrorIsFailure(t *testing.T) {
	var out, errOut bytes.Buffer
	p := Printer{Out: &out, Err: &errOut}
	if got := p.Fail(errors.New("disk full")); got != Failure {
		t.Fatalf("got %d", got)
	}
	if errOut.String() != "gz: disk full\n" || out.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", errOut.String(), out.String())
	}
}

func TestResultTextOrJSON(t *testing.T) {
	var out bytes.Buffer
	_ = Printer{Out: &out}.Result("hello", map[string]string{"a": "b"})
	if out.String() != "hello\n" {
		t.Fatalf("text: %q", out.String())
	}
	out.Reset()
	_ = Printer{Out: &out, JSON: true}.Result("hello", map[string]string{"a": "b"})
	if out.String() != "{\n  \"a\": \"b\"\n}\n" {
		t.Fatalf("json: %q", out.String())
	}
}
