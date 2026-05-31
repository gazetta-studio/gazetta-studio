---
name: review-prs
description: Walk the open-PR queue end-to-end. For each PR, read the diff + linked issue, fact-check load-bearing claims, run/monitor CI, and recommend merge / close / changes. Asks before merging.
disable-model-invocation: true
allowed-tools: Bash Read Grep Glob Edit Write AskUserQuestion
argument-hint: [optional PR number to start with]
---

Walk every open PR. For each, do a real review (not a summary). Always ask before merging.

## Loop

1. **List open PRs** — `gh pr list --json number,title,author,isDraft,createdAt,mergeable,reviewDecision,statusCheckRollup` and present a table sorted oldest-first.

2. **For each PR**, in order:
   - **Read PR metadata** — `gh pr view <N> --json title,body,baseRefName,headRefName,additions,deletions,changedFiles,files,commits`
   - **Read the linked issue** if one exists — `gh issue view <N>` (look for `Closes #X` in body)
   - **Read the diff** — `gh pr diff <N>` (or use Read on changed files for big diffs)
   - **Fact-check load-bearing claims** — see the "Fact-check" section below
   - **Check CI** — if green, note it; if no checks, diagnose (see "CI not firing"); if running, monitor or note pending
   - **Detect stacked PRs** — see "Stacked-PR detection"
   - **Recommend** — merge / close / push back / wait for CI — with reasoning
   - **Ask the user** before merging — `AskUserQuestion` or wait for confirmation

3. **After all PRs reviewed**, summarize what was done + what's outstanding.

## Reading bot-authored PRs

Some PRs are opened by autonomous bots (fix-bot, feature-bot, dead-code-watcher). They carry structured body sections you should read explicitly — these are the bot's proof-of-work, and the maintainer's job is to verify the bot's claims match the diff.

### Detect bot authorship

Bot-authored PRs end with an HTML-comment marker:

| Marker | Bot |
|---|---|
| `<!-- fix-bot: issue=N run=R -->` | fix-bot |
| `<!-- feature-bot: issue=N run=R -->` | feature-bot |
| `<!-- dead-code-watcher: ... -->` | dead-code-watcher |

PRs without a bot marker are maintainer-authored or external — read the PR body as prose.

### What the bot's PR body contains

After the bot identifier, both fix-bot and feature-bot inject Agent A's verbatim SUMMARY block under `## What Agent A did`. The SUMMARY contains:

```
<2-4 sentence prose>

Mode: behavioral | structural | mixed         (fix-bot only — feature-bot cuts are always behavioral by design)

Runtime exercise:
<per-bullet, per-path input + actual output>

Wider suite: <pass>/<total> pass; exit code <N>

Discovered: (optional; omit when empty)
- <one-line description of adjacent pre-existing bug observed during exercise>
```

### What to check in each section

**Mode** (fix-bot): cross-check the declared mode against the diff:
- `behavioral` → diff should change runtime behavior (logic, conditions, return values, status codes). Pure extraction / rename / comment-rot = mode is wrong.
- `structural` → diff should have NO behavior change. Any changed return value, conditional, or status code = mode is wrong.
- `mixed` → diff has both; verify each part.

Agent B already does this check; you're the second pair of eyes. If you see a mismatch, that's grounds to push back even when Agent B approved.

**Runtime exercise**: for `behavioral` / `mixed` modes, verify:
- Repro path output matches what the linked issue says should happen
- Wider suite shows zero failures (`/<N> pass; exit code 0`)
- If the fix touches symmetric surfaces (page+fragment kinds, etc.), both are exercised

For `structural` mode, the line reads `Runtime exercise: N/A — <reason>`. That's expected. The failing test pins the structural invariant; no behavioral surface to exercise.

**Discovered**: each entry is a candidate follow-up issue. The bot intentionally surfaces these instead of widening scope. Treat them as input to the "Follow-up issues" workflow below.

### Anti-patterns to catch

These are reasons to push back on a bot PR even if Agent B approved:

- **Tests-double-as-exercise**: SUMMARY's `Runtime exercise:` cites unit tests instead of a real runtime exercise. The exercise must be throwaway proof (`node -e`, `tmp-` script, CLI invocation). Tests are the TDD contract; the exercise is comprehension-grounding; mixing them defeats the anti-tautology purpose.
- **Mode-vs-diff mismatch**: declared `structural` but the diff changes behavior, OR declared `behavioral` but the diff is pure refactor. Either direction is a real problem; push back.
- **Discovered items that are load-bearing**: a `Discovered:` entry that's actually the incomplete-fix case the bot should have addressed in-scope. Push back with "this isn't a follow-up; finish the fix."
- **Leftover `tmp-*` files**: the runtime exercise's scratch script appears in the diff. Bot was supposed to delete before commit. Push back.

## Fact-check load-bearing claims (rule 20)

Don't trust the PR body's root-cause description without verifying it. For every claim that drives the fix, check it against actual code:

- **Race condition claims** → trace the actual event sequence in the code. "X happens before Y" — is that synchronous or asynchronous? Sync handlers (DOM `addEventListener`, Vue `@click`)? Or scheduled (Promise microtask, Vue scheduler, browser event loop)?
- **"This was the root cause" claims** → can you find code that supports it? Or is the PR description guessing? If guessing, the fix may not address the real cause.
- **API/library behavior claims** → check the source if it's in `node_modules/` or via WebFetch to official docs for external services.
- **"X is sync" / "X is async" claims** → grep the implementation. Vue listeners are sync (`addEventListener`). React's setState is async. `localStorage.setItem` is sync. `EventSource` callbacks are async.

When a claim doesn't survive fact-check, say so explicitly. Don't just accept the PR body. Phrase: *"PR claims X. Checked against `path/to/file.ts:42` — actually Y. The fix [does/doesn't] address the real cause."*

If the PR's fix is right but the explanation is wrong, that's still a smell — file a follow-up explaining the real cause so future readers don't inherit the wrong mental model.

## Stacked-PR detection

A "stacked PR" is one whose branch was cut from another open PR's branch, not from main. Symptoms:
- `gh pr diff <N>` shows commits/files that belong to another open PR
- `git log origin/main..origin/<branch> --oneline` shows more commits than the PR's "commits" list claims

To verify:
```bash
git fetch origin <branch> && git log origin/main..origin/<branch> --oneline
```

Recovery sequence (do NOT merge the stacked PR first):
1. **Land the parent PR first** (rebase-merge to main)
2. **Rebase the stacked PR onto fresh main**:
   ```bash
   git fetch origin && git checkout <stacked-branch> && git rebase origin/main
   ```
   Git auto-drops the parent's commits (cherry-pick equivalence detection).
3. **Force-push**: `git push --force-with-lease`
4. **Flip to ready / monitor CI**

Never merge a stacked PR via `--squash` thinking it'll subsume the parent — you'll lose the parent's PR discussion and history.

## CI not firing

If `gh pr checks <N>` returns "no checks reported," diagnose:

| Symptom | Cause | Fix |
|---|---|---|
| PR opened by `GITHUB_TOKEN` (Actions bot author) | GitHub anti-recursion: events triggered by `GITHUB_TOKEN` do NOT create new workflow runs ([docs](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow)) | **User account** close+reopen via `gh pr close <N> && gh pr reopen <N>` — actor identity becomes the user, not the bot, so `reopened` fires. (Close+reopen done by the bot itself stays suppressed.) Permanent fix: switch the bot to a GitHub App installation token or PAT. |
| Draft flipped to ready, no checks | Workflow's `pull_request:` trigger doesn't list `ready_for_review` (default types are only `[opened, synchronize, reopened]`) | Fix the workflow: `types: [opened, synchronize, reopened, ready_for_review]`. Short-term unblock: close+reopen, or push an empty commit. |
| All PRs cold | Workflow disabled / file syntax error | `gh api repos/:owner/:repo/actions/workflows/ci.yml --jq .state` should return `active` |

### Reading mixed-run CI status

After a force-push, `gh pr checks <N>` lists ALL recent workflow runs' jobs together — including jobs from the previous run that the concurrency rule cancelled mid-flight. A `smoke fail` row from an older `runs/XXXXX` URL is usually a cancelled job whose `needs:` dependency was cancelled, not a real test failure.

To filter to the current run only:

```bash
gh pr view <N> --json statusCheckRollup --jq '.statusCheckRollup
  | group_by(.detailsUrl | capture("runs/(?<id>[0-9]+)").id)
  | map({runId: (.[0].detailsUrl | capture("runs/(?<id>[0-9]+)").id),
         checks: [.[] | {name, status, conclusion}]})'
```

The newest run's `runId` will be the highest number. If all of its jobs show `SUCCESS`, the PR is genuinely green even if older-run rows show `CANCELLED` / `fail`.

**Monitor scripts that aggregate "all pass" can produce false-failure signals from cancelled-run artifacts.** When this happens, manually verify with the `runId` grouping above before assuming the PR is broken.

## Recommend merge / close / changes

Before recommending, consider:

- **Is the fix structurally right?** Per rule 18 — patches vs. structural corrections. If the PR's fix is a patch around a deeper bug, push back or file a follow-up.
- **Does it match the project's conventions?** Per the project's CLAUDE.md and `.claude/rules/team-preferences.md`.
- **Does CI catch what matters?** Green CI is necessary but not sufficient — flake-fix PRs especially can pass CI by luck. Per rule 35, flake-fix PRs need `--repeat-each=5` durability proof.
- **Is there a stacked PR?** Don't recommend merging if there's a parent that should land first.

For bot-authored PRs (see "Reading bot-authored PRs" above), also:

- **Does the declared `Mode:` match the diff?** Pure refactors must be `structural`; behavior-changing fixes must be `behavioral` or `mixed`. Agent B already checked this; you're the second pair of eyes.
- **Does the runtime exercise actually prove the fix works?** For `behavioral` / `mixed` modes, the repro path's actual output must match the linked issue's expected behavior.
- **Are `Discovered:` items genuinely adjacent (not incomplete-fix dodges)?** If a discovered item is what the bot should have fixed in-scope, push back instead of accepting + filing follow-up.
- **Are there leftover `tmp-*` files in the diff?** The runtime exercise's scratch should never appear in commits.

## Merge protocol

Default: **always ask before merging**. Even with admin bypass available.

When merging:
- **Rebase-merge only** per rule 16 (`gh pr merge <N> --rebase --delete-branch`)
- Solo maintainer with branch protection requiring 1 review: add `--admin` after explicit user confirmation
- After merge, `git checkout main && git pull --rebase origin main`

Bot-authored PRs (fix-bot, feature-bot) open as **draft** by design. Before merging:
- Verify the bot-PR checks above pass (Mode-vs-diff, runtime-exercise output, no `tmp-*` leakage)
- Mark ready with `gh pr ready <N>` — this triggers any workflows gated on `ready_for_review`
- Wait for CI on the now-ready PR before merging

If two PRs are both green and unrelated:
- Merge sequentially, not batched — keeps blame attribution clean if main breaks
- After first merge, second PR may need rebase; check `gh pr view <N> --json mergeable`

Doc-only PRs (per memory: `*.md`-only diffs by the maintainer) may admin-rebase-merge immediately without CI wait. Bot doc-only PRs still go through CI — the bot's PR-body claims need verification.

## Follow-up issues

Two sources feed this workflow:

1. **PR-driven** — a PR mitigates but doesn't fix the underlying cause; file a follow-up so the real fix doesn't get lost.
2. **Bot-discovered** — a bot-authored PR's `Discovered:` block names adjacent pre-existing bugs the bot observed while exercising its fix. The bot deliberately surfaced these instead of widening scope. Harvest each entry as a candidate follow-up.

For each candidate (either source), decide whether it warrants an issue. Skip if the discovered item is too vague to act on or already covered by an open issue (`gh issue list --search "<term>"` first).

### Routing the new issue (rule 40)

Pick labels by **task shape**, not by the source bot's domain:

- **One-shot** (refactor, hygiene, SOLID/DRY fix, missing-test backfill, small enhancement without a design doc) → `bug + ready-for-agent` → fix-bot picks it up
- **Cut of designed feature** (references a `design-{feature}.md`, depends on other cuts, under a tracking issue) → `enhancement + ready-for-agent` → feature-bot picks it up

Don't default to `flake` — that label is for tests intermittently failing, not for every test-adjacent issue. Apply `flake` only when the discovered behavior actually IS a CI flake.

### Issue body template

```bash
gh issue create --title "..." --label bug,ready-for-agent --body "$(cat <<'EOF'
## Context
<PR # exercised; the real cause / adjacent finding is below>

## Why this needs a separate fix
<the fact-checked race / behavior / structural gap>

## Recommended fix
<the structurally right approach; cite team-preferences rule if applicable>

## Acceptance criteria
<what the fix must demonstrate>

## Bot disclosure
> *This was generated by AI during PR review.*
EOF
)"
```

**Label hygiene reminder** (gazetta-specific): fix-bot picks up `bug + ready-for-agent`; feature-bot picks up `enhancement + ready-for-agent`. If neither, triage-bot looks first (input is "no classification labels yet"). Don't apply `bug` without `ready-for-agent` — lands the issue in limbo (triage-bot ignores it; fix-bot won't either). Per rule 40, the load-bearing axis is task shape, not the source bot.

## Output discipline

- One PR at a time. Don't batch multiple recommendations into one long message.
- State results, not your thought process. "Verdict: merge with caveat X" beats "Let me think about whether to merge..."
- Use the file_path:line_number format for code references so the user can click through.
- When CI is running, use Monitor to track it in background — don't block the conversation.
