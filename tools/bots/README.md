# Bots

Repo-scoped bots that run on GitHub Actions cron schedules. Each bot:

- Lives in its own subdirectory (`<bot-name>/`)
- Has an `index.ts` entry point + a `prompt.md` for the headless Claude call
- Shares helpers from `_lib/` (GitHub API wrapping via Octokit, Claude CLI invocation)
- Has a corresponding workflow at `.github/workflows/<bot-name>.yml`

## Layout

```
tools/bots/
├── package.json              # one workspace, one entry per bot
├── tsconfig.json
├── _lib/                     # shared modules — github, claude, etc.
│   ├── github.ts
│   └── claude.ts
└── <bot-name>/
    ├── index.ts              # entry point
    └── prompt.md             # Claude prompt template
```

## Conventions

- **Auth**: `CLAUDE_CODE_OAUTH_TOKEN` (Claude account subscription) + `GH_TOKEN` (GitHub Actions default token). Both flow through env; never hardcoded. The OAuth token is an org-level secret; new bots inherit it automatically.
- **Permissions**: workflow declares `actions: read` + `issues: write` (most bots) + nothing else. Add `contents: write` only when the bot commits to the repo.
- **Failure isolation**: workflow uses `continue-on-error: true`. Bot's `index.ts` wraps each per-target investigation in a try/catch so one bad investigation doesn't kill the run.
- **Dry-run**: every bot supports `DRY_RUN=1` env to list candidates without invoking Claude. Used for local testing and prompt iteration.
- **Cron**: pick a UTC time off-peak for contributors. 12:00 UTC is the current convention (after overnight CI, before workday).

## Adding a new bot

1. `cp -r flake-watcher <new-bot>`
2. Rewrite `<new-bot>/index.ts` for the new task; reuse `_lib/` helpers
3. Rewrite `<new-bot>/prompt.md` with the new task's investigation steps
4. Add the npm script: `"<new-bot>": "tsx <new-bot>/index.ts"` in `package.json`
5. Copy `.github/workflows/flake-watcher.yml` to `.github/workflows/<new-bot>.yml`; update the cron, the run command, and the description

If three+ bots end up needing the same helper (e.g., posting structured comments, parsing test output), extract to `_lib/`. Until then, inline.

## Running locally

```bash
# Dry-run (no Claude invocation)
DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio GH_TOKEN=$(gh auth token) \
  npm run flake-watcher -w @gazetta/bots

# Real run (invokes Claude — uses local CLI auth)
GITHUB_REPOSITORY=gazetta-studio/gazetta-studio GH_TOKEN=$(gh auth token) \
  npm run flake-watcher -w @gazetta/bots
```

## Active bots

| Bot | Trigger | Purpose | Workflow |
|---|---|---|---|
| `flake-watcher` | Daily 12:00 UTC | Detects CI flakes (run_attempt >= 2), files / comments on issues | `.github/workflows/flake-watcher.yml` |
