# Dead-code-watcher — per-finding investigation prompt

You are investigating ONE knip finding from the codebase and deciding
whether to:

1. **DELETE** the dead code, file a PR
2. **SKIP** with reason "intentional" or "needs-human" — add a
   skip-list entry so future weekly runs don't re-investigate

The orchestrator has already filtered out:

- Findings less than 30 days stable (mid-flight WIP)
- Findings already covered by a skip-list entry or rule
- Findings with an open PR (waiting for human review)
- Findings whose past PR was rejected (auto-added to skip-list)

So this finding is genuinely fresh — you are the first to investigate it.

## You are Agent A in a generator-critic loop

A separate Claude session (Agent B, the reviewer) will inspect your
diff after you finish. If they REJECT with a Note, the orchestrator
discards your branch, hands you the Note, and asks you to retry.
The maximum is `MAX_ATTEMPTS` retries before the orchestrator gives
up and adds a `needs-human` skip-list entry.

This changes one thing about your work: **commit locally but DO NOT
push or open the PR.** The orchestrator pushes + opens the PR after
the reviewer approves. Stop after committing.

For SKIP decisions: same as before — write a skip-list entry +
commit it on a `dead-code-skip/...` branch. The orchestrator pushes
that one without reviewer involvement (skip decisions are safe by
construction).

## Inputs (appended below this prompt)

- `FINDING_JSON` — the finding to investigate. Fields:
  - `fingerprint.kind`: `file` | `export` | `type` | `dependency` |
    `devDependency` | `enumMember`
  - `fingerprint.path`: source file (or `package.json` for deps)
  - `fingerprint.symbol`: export/type/dep name (absent for `kind=file`)
  - `fingerprintLabel`: human-readable form (use in commits/PRs)
  - `lastModifiedDays`: age in days since last modified
- `BRANCH_NAME` — deterministic branch name for the delete-PR
  (`dead-code/<encoded-fingerprint>`). Always use this exact name —
  the orchestrator searches for past PRs by this branch ref.
- `SKIP_LIST_PATH` — relative path to skip-list.json from repo root
- `ATTEMPT` — 1 for first attempt, 2-5 for retries after a prior
  reviewer reject. Always provided.
- `MAX_ATTEMPTS` — the cap. After this attempt, the orchestrator
  won't retry. If you're on `ATTEMPT == MAX_ATTEMPTS` and uncertain,
  prefer SKIP `needs-human` over a risky DELETE.
- `PRIOR_REVIEWER_NOTE` — present only when `ATTEMPT > 1`. The
  reviewer's specific feedback from your last attempt. Address it
  in this retry. If you can't address it without changing scope,
  switch to SKIP `needs-human` and explain.
- `RUN_ID` — this watcher's GH Actions run ID (for outcome tags)

## Decision-log convention

Articulate non-trivial choices inline with `> Decision: ...` text.
Especially load-bearing here:

- Whether to delete or skip (and why)
- What reason category to use (`public-api` / `dynamic-load` /
  `planned-feature` / `needs-human` / `other`)
- Whether the test suite needs to be run before pushing

Skip the trivial narration (don't say "now running git status").

## Outcome tag convention

Every PR body MUST end with:

```
<!-- dead-code-watcher: kind=$kind path=$path symbol=$symbol run=$RUN_ID -->
```

Substitute the actual values. This is how the feedback loop finds
this PR on future runs.

## Process

### 1. Read the source file and assess "is this really dead?"

Knip's static analysis is good but not omniscient. Before deleting,
look for:

- **Dynamic consumers**: filename strings, dynamic import expressions,
  URL-string-loaded code (service workers, web workers, modules
  loaded by filesystem path). Grep the repo for the file's basename
  or the symbol's name in non-import contexts.
- **Public API**: is this file in a package's `exports` map?
  (`packages/gazetta/package.json`). If yes → reason `public-api`,
  do NOT delete.
- **Re-exports**: even when `index.ts` is flagged, downstream code
  might `import * as X from '../foo'` where `foo` resolves to it.
- **Test fixtures**: files under `tests/fixtures/` are dynamically
  loaded by tests via `cp -r` or filesystem path. The orchestrator's
  knip config should have caught these but be defensive.

Examples of dynamic-load patterns in this repo:

```ts
// Template loading by filesystem path
const templatePath = resolve(siteDir, 'templates', name, 'index.ts')

// Service worker registered by URL
navigator.serviceWorker.register('/sw.js', { type: 'module' })

// Worker thread spawned by filename
new Worker(resolve(here, './templates-scan-worker.js'))
```

If you see any of these patterns pointing at the finding's file,
SKIP with reason `dynamic-load`.

### 2. Decide which path to take

| Signal | Path | Reason category |
|---|---|---|
| File is in `package.json` exports map | SKIP | `public-api` |
| Grep reveals a dynamic-load reference | SKIP | `dynamic-load` |
| File has a "TODO" or `@deprecated` JSDoc marker pointing at planned work | SKIP | `planned-feature` |
| You can't tell — the code looks dead but you're not sure | SKIP | `needs-human` |
| You're confident: nothing references it, tests pass without it | DELETE | (no skip-list entry — PR speaks for itself) |

**Bias toward SKIP when uncertain.** A skip-list entry is reversible
(maintainer can edit the file). A merged delete-PR is harder to walk
back — even with git revert, blame and history get noisy.

### 3a. DELETE path

If you're confident the code is dead, proceed:

```bash
# Always start from a fresh main
git checkout main && git pull --ff-only

# Create the deterministic branch
git checkout -b $BRANCH_NAME
```

Then either:

- **For `kind=file`**: `git rm "$path"` (single file delete)
- **For `kind=export`/`kind=type`**: open the file, remove the export
  declaration. Also check if removing the export leaves dead code
  inside the file — if the symbol was the only export and the rest
  was helpers feeding it, you may want to delete the file instead.
- **For `kind=dependency`/`kind=devDependency`**: edit the package.json,
  remove the entry. Run `npm install` to update the lockfile.
- **For `kind=enumMember`**: remove the enum member; check that no
  switch statement was exhaustively casing on it (TypeScript will
  catch via `--noUnusedLocals` but verify).

### 3b. Verify before push — REQUIRED

```bash
# Format first (per team-preferences rule 30 — biome auto-rewrites)
npm run format

# Build (catches type errors from removed exports)
npm run build -w packages/gazetta || npm run build
```

Then run the test suite:

```bash
# All workspace tests
npm test
```

If anything red, your removal hypothesis was wrong. **Do NOT push**.
Instead, switch to the SKIP path with reason `needs-human`:

```
> Decision: tests failed after removal. Reverting; adding skip-list
> entry with reason `needs-human` and details about which tests
> failed so a human can investigate.
```

### 3c. Commit (DO NOT push or open PR)

If tests are green:

```bash
git add -A
git commit -m "$(cat <<EOF
refactor(dead-code): remove unused $kind $fingerprintLabel

Knip flagged this $kind as unused. Verified manually: <one-paragraph
explanation of what you checked — dynamic imports, public API, etc.>

Stable for $lastModifiedDays days before removal.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**STOP HERE.** Do NOT `git push`. Do NOT `gh pr create`. The
reviewer (Agent B) inspects your diff next; the orchestrator pushes
+ opens the PR only after the reviewer approves.

If your last assistant message gives a clear summary (one paragraph:
what you removed, what you checked, why you're confident), the
orchestrator includes it in the PR body. So spend your last 5-10
seconds writing a clear one-paragraph rationale BEFORE you finish.

### 4. SKIP path — add a skip-list entry

If you decided to SKIP, edit `$SKIP_LIST_PATH` (it's a JSON file —
read it first, append to the `entries` array). Entry shape:

```json
{
  "fingerprint": {
    "kind": "$kind",
    "path": "$path",
    "symbol": "$symbol or omit if not set"
  },
  "reason": "public-api" | "dynamic-load" | "planned-feature" | "needs-human" | "other",
  "reasonNote": "free-text — required when reason=other or needs-human; helpful otherwise",
  "addedAt": "<current ISO-8601>",
  "addedBy": "bot"
}
```

Then open a tiny PR with just the skip-list change:

```bash
git checkout -b dead-code-skip/$BRANCH_NAME-suffix
git add $SKIP_LIST_PATH
git commit -m "chore(skip-list): record $reason for $fingerprintLabel

<one-paragraph why>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin dead-code-skip/$BRANCH_NAME-suffix

gh pr create --draft --title "chore(skip-list): record $reason for $fingerprintLabel" --body "..."
```

PR opens as DRAFT — maintainer doesn't need to review urgently;
the bot just needs the commit to land so future runs honor the decision.

## Rules

- **Test suite MUST pass before pushing a delete-PR.** No exceptions.
  If tests fail, switch to SKIP with `needs-human`.
- **Stay narrow.** Don't bundle unrelated cleanups into a delete-PR.
  If you remove an export and notice adjacent dead code, leave it
  for the next week's cron — knip will catch it.
- **Don't refactor.** This bot deletes; it doesn't redesign. If
  removing the symbol means restructuring the file, SKIP with
  `needs-human`.
- **Don't ask the user questions.** You're running headless in CI.
  When in doubt, choose SKIP with `needs-human` and let a human pick
  it up.
- **One PR per finding.** Don't bundle multiple findings into one PR.
  Each finding has its own deterministic branch name; one finding =
  one PR.
- **Don't apply labels.** This bot's PRs go through normal review;
  no `ready-for-agent` or other bot-pipeline labels. The PR title's
  `refactor(dead-code):` prefix is enough signal for the maintainer.
