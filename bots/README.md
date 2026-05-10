# Bots

Repo-scoped bots that run on GitHub Actions cron schedules. Each bot:

- Lives in its own subdirectory (`<bot-name>/`)
- Has an `index.ts` entry point + a `prompt.md` for the headless Claude call
- Shares helpers from `_lib/` (GitHub API wrapping via Octokit, Claude CLI invocation)
- Has a corresponding workflow at `.github/workflows/<bot-name>.yml`

## Layout

```
bots/
├── package.json              # one workspace, one entry per bot
├── tsconfig.json
├── _lib/                     # shared modules — github, claude, replay
│   ├── github.ts
│   ├── claude.ts             # claude -p wrapper; writes JSONL transcript
│   └── replay.ts             # rerun past investigations against current prompt
├── transcripts/              # JSONL transcripts (gitignored; CI uploads as artifact)
└── <bot-name>/
    ├── index.ts              # entry point
    └── prompt.md             # Claude prompt template
```

`bots/` is a top-level peer of `apps/`, `packages/`, `tools/`. They live at the
root because they're autonomous infrastructure — different audience and lifecycle
from `tools/` (developer/operator utilities run on demand).

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

| Bot | Trigger | Input (label-driven) | Output |
|---|---|---|---|
| `flake-watcher` | Daily 12:00 UTC + workflow_dispatch | (CI events, not labels) | New issue with `bug`, `flake`, `area: X`, `recurring-flake?` |
| `triage-bot` | Daily 11:00 UTC + workflow_dispatch | Open issue lacking all of `ready-for-agent`, `ready-for-human`, `wontfix`, `needs-info` | One of `bug` / `enhancement` / `triage-uncertain` + `area: X`. Reproducible bug also gets `ready-for-agent`. |
| `discovery-prep-bot` | Daily 10:00 UTC + workflow_dispatch | `enhancement` AND lacks all of `ready-for-human`, `ready-for-agent`, `wontfix`, `needs-info` | Research comment + `ready-for-human` label |
| `fix-bot` | Daily 13:00 UTC + workflow_dispatch | `bug` + `ready-for-agent` AND lacks all of `ready-for-human`, `wontfix`, `needs-info` AND no prior fix-bot comment | EITHER draft PR (two commits: failing test + fix), OR stuck-comment + `ready-for-human` label |

### Pipeline shape (label-driven)

```
flake-watcher (cron 12:00 UTC)
    ↓ files issue (auto-classified `bug`)
triage-bot (cron 11:00 UTC next day) — input: open + no terminal-state label
    ├─→ confident bug + reproducible → applies `ready-for-agent`
    │       ↓
    │   fix-bot (cron 13:00 UTC) — input: bug + ready-for-agent + no
    │   terminal-state label + no prior fix-bot comment
    │       ↓ EITHER opens draft PR (failing test + fix), OR posts
    │         stuck-comment + applies `ready-for-human`
    │   maintainer reviews PR, merges
    │
    ├─→ confident enhancement → no extra label
    │       ↓
    │   discovery-prep-bot (cron 10:00 UTC) — input: enhancement + no
    │   ready-for-human / ready-for-agent / wontfix / needs-info
    │       ↓ posts research comment + applies `ready-for-human`
    │   maintainer reads comment, starts grilling at their pace
    │
    └─→ triage-uncertain → maintainer's morning queue
            gh issue list --label triage-uncertain
```

**Pipeline state lives in labels, not in code or workflow runs.** Each bot's input is a label query; each bot's output is a label mutation. To re-run any bot on an issue, remove its output label — the next cron picks it up. To opt-out an issue, apply a terminal-state label (`wontfix` / `ready-for-human`).

**Maintainer queries:**

```bash
# What did the bot flag for me?
gh issue list --label triage-uncertain

# What's in design-grilling territory? (read the latest comment to know
# whether it's discovery-prep-bot's research or fix-bot's stuck case)
gh issue list --label ready-for-human

# What's queued for fix-bot?
gh issue list --label ready-for-agent

# What needs reporter clarification?
gh issue list --label needs-info
```

`ready-for-human` is shared between discovery-prep-bot ("research done, grilling can start") and fix-bot ("stuck — needs human"). Disambiguate by reading the most recent bot comment's outcome tag.

Each bot is independent. Failures are isolated (per-bot try/catch + workflow `continue-on-error`). No chained workflow_dispatch — each bot's cron is the trigger, the issue's label state is the input.

## Improving a bot

Bots are designed for an agent (you, in a future session) to improve over time.
Three signals make the loop work:

1. **JSONL transcripts** — every Claude invocation writes one line per event
   (tool call, tool result, assistant text) to `bots/transcripts/`. CI uploads
   them as the `<bot-name>-transcripts` artifact (90-day retention). To read a
   past run's transcripts: `gh run download <run-id> -n flake-watcher-transcripts`.
2. **Decision-log convention** — bot prompts ask Claude to articulate
   load-bearing decisions inline (`> Decision: ...`). The transcript captures
   the WHY, not just the WHAT.
3. **Outcome tags** — every comment / new issue ends with
   `<!-- flake-watcher: run=$RUN_ID -->`. Lets you query
   `gh issue list --search "flake-watcher: run=12345"` to find what the bot
   touched in any past run, joining intent (transcript) with outcome (issue
   activity).

### Replay loop (the actual improvement workflow)

```bash
# 1. Pick a recent workflow run
gh run list --workflow=flake-watcher.yml --limit 5

# 2. Read transcripts to find quality issues — over-eager dedup, missed
#    root-cause class, etc. Outcome tags let you cross-check what each
#    investigation actually produced on the issue tracker.
gh run download <run-id> -n flake-watcher-transcripts -D /tmp/transcripts

# 3. Edit the prompt (bots/<bot-name>/prompt.md)

# 4. Replay the same flakes against the new prompt — writes side-by-side
#    transcripts to bots/transcripts/<bot>/replay-from-<source-run>/.
npm run replay -w @gazetta/bots <bot-name> <source-run-id>

# 5. Diff <run-id>-original.jsonl vs <run-id>-replay.jsonl per investigation;
#    decide if the change is an improvement.

# 6. Open a PR with the prompt change; cite which past runs replay improved.
```

**Replay safety**: replays invoke real Claude with real tools. The current
prompt may instruct Claude to file/comment on issues — replays will too.
Always inspect transcripts before shipping a prompt change. Future work:
add a `REPLAY=1` env that the prompt can read to suppress side effects.
