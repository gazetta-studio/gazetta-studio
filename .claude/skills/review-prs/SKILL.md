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

## Recommend merge / close / changes

Before recommending, consider:

- **Is the fix structurally right?** Per rule 18 — patches vs. structural corrections. If the PR's fix is a patch around a deeper bug, push back or file a follow-up.
- **Does it match the project's conventions?** Per the project's CLAUDE.md and `.claude/rules/team-preferences.md`.
- **Does CI catch what matters?** Green CI is necessary but not sufficient — flake-fix PRs especially can pass CI by luck.
- **Is there a stacked PR?** Don't recommend merging if there's a parent that should land first.

## Merge protocol

Default: **always ask before merging**. Even with admin bypass available.

When merging:
- **Rebase-merge only** per rule 16 (`gh pr merge <N> --rebase --delete-branch`)
- Solo maintainer with branch protection requiring 1 review: add `--admin` after explicit user confirmation
- After merge, `git checkout main && git pull --rebase origin main`

If two PRs are both green and unrelated:
- Merge sequentially, not batched — keeps blame attribution clean if main breaks
- After first merge, second PR may need rebase; check `gh pr view <N> --json mergeable`

## Follow-up issues

When a PR mitigates but doesn't fix the underlying cause, file a follow-up so the real fix doesn't get lost:

```bash
gh issue create --title "..." --label flake,bug,ready-for-agent --body "$(cat <<'EOF'
## Context
<PR # mitigated symptom; root cause analysis below>

## Why <PR> didn't close the root cause
<the actual fact-checked race / behavior>

## Recommended fix
<the structurally right approach>

## Acceptance criteria
<what the fix must demonstrate>

## Bot disclosure
> *This was generated by AI during PR review.*
EOF
)"
```

**Label hygiene** (gazetta-specific): fix-bot picks up `bug` + `ready-for-agent`. If you want fix-bot to handle it, apply both labels at creation. If you want triage-bot to look first, apply neither (triage-bot's input is "no classification labels yet"). Don't apply `bug` without `ready-for-agent` — that lands the issue in limbo (triage-bot ignores it; fix-bot won't either).

## Output discipline

- One PR at a time. Don't batch multiple recommendations into one long message.
- State results, not your thought process. "Verdict: merge with caveat X" beats "Let me think about whether to merge..."
- Use the file_path:line_number format for code references so the user can click through.
- When CI is running, use Monitor to track it in background — don't block the conversation.
