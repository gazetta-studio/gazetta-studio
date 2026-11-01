// Command gz edits a Gazetta site through its admin
// (design-agent-access.md Q8, Q35).
package main

import (
	"fmt"
	"os"

	"github.com/gazetta-studio/gazetta-studio/gz/internal/cli"
	"github.com/gazetta-studio/gazetta-studio/gz/internal/output"
)

func main() {
	env, err := cli.DefaultEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "gz:", err)
		os.Exit(output.Failure)
	}
	os.Exit(cli.Run(os.Args[1:], env))
}
