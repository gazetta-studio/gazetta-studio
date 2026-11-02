package cli

import (
	"fmt"
	"strings"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/content"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

// runCommands show and revert an agent run (design-agent-access.md Q48,
// Q50). Reverting isn't on the never-run list: it is a set of edits, and
// itself a run that can be reverted.
func runCommands() []command {
	return []command{
		{"runs show", "gz runs show <run-id>", "List a run's items and what reverting it would do", 1, 1, runsShow, []string{"--run"}, nil},
		{"runs revert", "gz runs revert <run-id> [--force <item>,...]", "Undo a run item by item; items changed since are skipped unless forced", 1, 1, runsRevert, []string{"--force", "--run"}, nil},
	}
}

func runsShow(ctx *context, args []string) error {
	s, err := ctx.service()
	if err != nil {
		return err
	}
	items, err := s.RunItems(ctx.env.Ctx, args[0])
	if err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Run %s: %d items\n", args[0], len(items))
	for _, it := range items {
		fmt.Fprintf(&b, "  %s  %s\n", it.Item, planned(it))
	}
	return ctx.out.Result(strings.TrimRight(b.String(), "\n"), map[string]any{"runId": args[0], "items": items})
}

// planned says what a revert would do with the item.
func planned(it content.RunItem) string {
	switch {
	case it.Kind == "asset":
		return "an asset: not reverted"
	case !it.Restorable:
		return "its version before the run is no longer in history"
	case it.Changed:
		return "changed since the run: skipped unless forced (--force " + it.Item + ")"
	case it.Created:
		return "created by the run: will be archived"
	default:
		return "will go back to its version before the run"
	}
}

func runsRevert(ctx *context, args []string) error {
	var force []string
	for _, f := range strings.Split(ctx.flags["--force"], ",") {
		if f = strings.TrimSpace(f); f != "" {
			force = append(force, f)
		}
	}
	s, err := ctx.service()
	if err != nil {
		return err
	}
	if s.Run == args[0] {
		return output.Errorf(output.Usage, "a revert is a run of its own: use a run id other than %s", args[0])
	}
	items, revertRun, err := s.Revert(ctx.env.Ctx, args[0], force)
	if err != nil {
		return err
	}
	var b strings.Builder
	skipped := 0
	for _, it := range items {
		line := it.Status
		if it.Reason != "" {
			line += ": " + it.Reason
		}
		if strings.HasPrefix(it.Status, "skipped") {
			skipped++
		}
		fmt.Fprintf(&b, "  %s  %s\n", it.Item, line)
	}
	fmt.Fprintf(&b, "Reverted run %s; %d of %d items skipped. This revert is run %s.", args[0], skipped, len(items), revertRun)
	return ctx.out.Result(b.String(), map[string]any{"runId": args[0], "revertRun": revertRun, "items": items})
}
