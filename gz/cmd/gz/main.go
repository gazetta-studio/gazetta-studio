// Command gz edits a Gazetta site through its admin
// (design-agent-access.md Q8, Q35).
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/cli"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

func main() {
	env, err := cli.DefaultEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "gz:", err)
		os.Exit(output.Failure)
	}
	// Ctrl+C cancels a waiting login (exit 3) instead of killing gz mid-write.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	env.Ctx = ctx
	code := cli.Run(os.Args[1:], env)
	stop()
	os.Exit(code)
}
