# gz

`gz` edits a Gazetta site through its admin, for content creators and their AI agents (`.claude/rules/design-agent-access.md`, Q8–Q41). It's a Go module, outside the npm workspaces.

```bash
cd gz
go test ./...                  # unit tests
go build -o gz ./cmd/gz         # build
GZ_TEST_KEYCHAIN=1 go test -run TestRealKeychain ./internal/grant/   # this machine's real keychain
goreleaser check                # release config
goreleaser release --snapshot --clean --skip=publish   # build every platform into dist/
```

- `cmd/gz`: the binary.
- `internal/cli`: commands, global flags (`--admin`, `--json`, `--version`), help.
- `internal/output`: text or JSON output and the exit codes (Q38).
- `internal/profile`: login profiles and which admin a command uses (Q36).
- `internal/grant`: where a profile's login is stored: the OS keychain via `github.com/zalando/go-keyring`, or a 0600 file where there's none (Q24).
- `internal/skill`: the agent skill embedded in the binary (Q40, Q41).
- `internal/version`: `VERSION` holds the gazetta package's version, and a test keeps them equal. After `npm version -w packages/gazetta`, run `node -p "require('./packages/gazetta/package.json').version" > gz/internal/version/VERSION`.
- `.goreleaser.yaml`, `install/`, `npm/`: release config, install scripts and the npm packages (Q39). Nothing is published from here yet.

`GZ_CONFIG_DIR` overrides where gz keeps its profiles (default: the OS config folder, `gz/`).
