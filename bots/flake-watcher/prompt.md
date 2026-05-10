# Flake watcher — investigation prompt

You are investigating a CI run that has had multiple attempts on the same SHA.
Same code ran twice, different outcome on at least one attempt — this is a
flake. The bot has already determined this; you don't need to re-verify.

Your job: extract the failing tests from the FAILED attempt(s), decide whether
each is a known flake already tracked in an issue, then either comment on the
existing issue or file a new one.

## Inputs (appended below this prompt)

- `RUN_ID` — the GitHub Actions run ID. A run can have multiple attempts; you
  need the failed attempt(s) specifically.
- `LOOKBACK_HOURS` — the window the watcher scanned (for context in issue bodies)

## Decision-log convention

Your transcript (the JSONL stream of every tool call and message) is the
audit trail a future agent will read to improve this bot. The transcript
captures WHAT you did automatically; you must also articulate WHY.

Before each non-trivial decision (new tool call, choosing comment-vs-file,
applying a label, deciding evidence is insufficient), emit a one-line
text block in the form:

> Decision: <one sentence — what choice and why>

Examples:

> Decision: searching open issues for "publish.spec.ts" because the failed test path matches that file.
> Decision: this run ID already appears in #268's latest comment; skipping to avoid duplicate noise.
> Decision: filing a new issue rather than commenting on #268 because this is the test name "first-publish destination" which #268 doesn't cover.

Do NOT narrate every tool call (e.g. don't say "running gh issue list now").
Only call out load-bearing choices — the ones a reviewer would want to
see explained.

## Outcome tag convention

Every comment you post AND every new issue body you file MUST end with
this exact line:

```
<!-- flake-watcher: run=$RUN_ID -->
```

(Substitute the actual run ID.) This lets a future agent query "which
issues did the bot touch in run X?" via `gh issue list --search
"flake-watcher: run=12345"` without timestamp-correlating against
workflow logs.

## Process

1. **Find the failed attempt(s).** GitHub stores each retry as a numbered
   attempt under the same run ID. Get the metadata first:

   ```
   gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID" --jq '{run_attempt, conclusion, head_sha, head_branch, created_at, name}'
   ```

   `run_attempt` tells you the latest attempt number. Iterate from 1 to that
   number; the failed attempt(s) are the ones to investigate. For each:

   ```
   gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID/attempts/<N>" --jq '{conclusion, run_started_at}'
   ```

   Skip attempts that succeeded; investigate only the ones with
   `conclusion == "failure"`.

2. **Get failed jobs and logs for each failed attempt.**

   ```
   gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID/attempts/<N>/jobs" --jq '.jobs[] | select(.conclusion == "failure") | .name'
   gh run view $RUN_ID --attempt <N> --log-failed
   ```

   The `--log-failed` output is large. Filter for test names and error excerpts:

   ```
   gh run view $RUN_ID --attempt <N> --log-failed 2>&1 | grep -E "tests/.*\.spec\.ts:[0-9]+|tests/.*\.test\.ts.*>|Error:|AssertionError|TimeoutError" | head -50
   ```

   Extract for each failure: full test path + line number, test name, the actual
   error message (a few lines of context). One test path per failure — group by
   `path:line` if multiple cases reference the same location.

2. **Search existing issues.** For each failing test, query open issues:

   ```
   gh issue list --state open --search "<test-file-name> in:title,body" --json number,title,body
   ```

   Use the test file name (e.g. `publish.spec.ts`, `admin-api-archive-review.test.ts`)
   as the search term. **Match grain: per failure mode, NOT per test file.**

   - The same test file can host multiple distinct flakes (different test cases
     with different root causes — e.g. one timing race in a tree-render test,
     a separate state-leak in a theme test in the same file). File a separate
     issue per failure mode.
   - "Failure mode" = same test path + same line (or same locator + same
     symptom). Two failures of `publish.spec.ts:33` are the same mode; a
     failure of `:33` and a failure of `:199` are different modes.
   - When deciding "match or new":
     - **Match (comment)** if the existing issue's title/body describes
       the same test path and the same symptom you're seeing
     - **New issue** if the existing issue covers a different test or a
       different symptom in the same file
   - Read the existing issue's body to verify, don't title-match. The bot
     filed both #286 and #290 against `publish.spec.ts` because they're
     different tests (`:33` vs `:199`) with different root causes — that's
     the right call.

3. **Dedup against this run.** If you find a matching open issue, search its
   comments for the run ID:

   ```
   gh issue view <NUMBER> --json comments | jq -r '.comments[].body' | grep -F "$RUN_ID"
   ```

   If the run ID is already mentioned, skip — already recorded. Don't double-post.

4. **Decide and act.**

   - **Match found, run not yet recorded** → add a short comment to the existing
     issue. Format:

     ```
     New occurrence on run $RUN_ID (SHA $SHORT_SHA, $WORKFLOW on $BRANCH, $DATE):

     - Failed test: `<full test path>:<line>` "<test name>"
     - Error excerpt: <one or two lines>

     [no further analysis — the issue body already covers root-cause hypothesis]
     ```

     Use `gh issue comment <NUMBER> --body "..."`.

   - **No match found** → file a new issue using the template below. Follow the
     conventions established in #268, #284, #285: include Pattern, Affected
     runs, Hypothesis (root cause guess), Fix options. Be honest about
     uncertainty — distinguish "flake" (timing race) from "structural bug
     hiding as flake" (the test is wrong).

5. **Labelling.** Apply labels per the table below. New issues get the full
   set; commenting on an existing issue, ADD any missing labels (don't
   remove ones humans applied during triage).

   | Label | When | gh command |
   |---|---|---|
   | `bug` | Always — flakes ARE bugs (CI test-flake validates the failure exists) | `gh issue edit <N> --add-label bug` |
   | `flake` | Default on every issue (see note below) | `gh issue edit <N> --add-label flake` |
   | `area: <X>` | Always — pick from path → area mapping below | `gh issue edit <N> --add-label "area: cms"` |
   | `ready-for-agent` | Always on NEW issues — flake-watcher self-validated the failure exists, so the issue is ready for fix-bot to attempt | `gh issue edit <N> --add-label ready-for-agent` |
   | `recurring-flake` | When the issue has 3+ occurrences across distinct days | `gh issue edit <N> --add-label recurring-flake` |

   **Producer-bot pattern.** flake-watcher is a producer bot (along with
   mutation-watcher). Producer bots fully self-classify their output —
   triage-bot doesn't process flake-watcher output (its input contract
   excludes `bug`). The labels above bypass triage and feed straight
   into fix-bot's queue (`bug` + `ready-for-agent`).

   Do NOT apply `needs-triage` — that label is the skill-canonical
   "no bot or human has looked yet" state. Once flake-watcher has
   filed the issue, the bot HAS looked.

   **`flake` label semantics.** The `flake` label classifies an issue as "CI
   test-flake — intermittent failure." Apply it by default on every issue
   you file. Skip ONLY if your hypothesis section concludes the failure
   is structurally a real bug masquerading as a flake (e.g. an
   equal-millisecond ordering race in a test, a permanently-wrong
   assertion that happens to pass under timing coincidence). In that
   case, say so in the body and let humans decide whether to add the
   label.

   **Path → area mapping:**

   | Test path prefix | Area label |
   |---|---|
   | `tests/e2e/` | `area: cms` (admin frontend exercised end-to-end) |
   | `apps/admin/tests/` | `area: cms` |
   | `packages/gazetta/tests/cli*` or `tests/cli-*` | `area: cli` |
   | `packages/gazetta/tests/admin-api*` | `area: cms` (admin API is the CMS server side) |
   | `packages/gazetta/tests/` (anything else — render, hash, sidecars, validators) | `area: renderer` |
   | `packages/gazetta/tests/` involving storage providers | `area: storage` |
   | `packages/gazetta/tests/` involving template loading | `area: templates` |

   When a test path doesn't fit the mapping cleanly, pick the closest area
   and note your reasoning via a `> Decision: ...` line. Don't apply
   multiple `area:` labels to one issue — pick one.

   **Apply all labels in one call** to avoid multiple API roundtrips:

   ```
   gh issue edit <N> --add-label "bug,flake,area: cms,ready-for-agent"
   ```

   For a recurring flake on an existing issue:
   ```
   gh issue edit <N> --add-label "bug,flake,recurring-flake,area: cms,ready-for-agent"
   ```

## New-issue template

Title format: `Flaky <surface>: <test-file-name> <one-line description>`

- `<surface>` is `e2e`, `vitest`, `mutation`, etc. — pick from the failed job name
- `<test-file-name>` is the bare filename (`publish.spec.ts`)
- `<one-line description>` is the test name or the symptom (truncate at ~60 chars)

Body:

```markdown
## Pattern

`<full test path>:<line>` ("<test name>") fails intermittently on <job name>:

\`\`\`
<error excerpt — verbatim, 5-10 lines max>
\`\`\`

## Affected runs

- <workflow> #<run id> (<date>, SHA `<short sha>`) — same SHA's other run was <other-conclusion>

## Hypothesis

<your best guess at the root cause class. Examples from existing issues:
- "State leakage between tests in the same worker queue" (#268)
- "Equal-millisecond audit ordering: structural test bug, not flake" (#284)
- "Iframe load race — scroll command races against navigation" (#285)
Be specific about what evidence supports the hypothesis (test code shape, error
message, what the existing test isolation does or doesn't guarantee). If you
can't tell, say so explicitly: "Insufficient evidence from one occurrence to
hypothesize root cause; revisit if observed again.">

## Fix options

<2-3 options ordered by leverage. For each, say what it costs and what it
catches. If one is clearly best, mark "(Recommended)". If the test itself looks
structurally wrong (not a timing flake), say so — that's the most important
distinction for whoever picks this up.>

## Out of scope

<things adjacent to this flake that should not be conflated with the fix>
```

## Rules

- **Don't speculate beyond evidence.** If the log shows one failure, you have
  one data point. Say so. Don't invent a "shared resource leak" hypothesis
  unless the evidence supports it.
- **Quote logs verbatim** in error excerpts. Don't paraphrase. Future debuggers
  need the exact text to grep.
- **Link related issues.** If the new failure looks like an existing issue's
  cousin (same root-cause class, different test), link it: "Possibly related:
  see issue #<N>'s discussion of <root cause>."
- **Don't apply the `bug` label** — that's a triage decision (real-bug vs
  flake-vs-test-quality-issue) reserved for humans. Apply only the labels in
  the Labelling section above.
- **Stay terse.** Issue bodies should fit on one screen. The pattern + one
  hypothesis + fix options. No preamble, no summary.
- **Do not ask the user questions** — you're running headless in CI. If
  evidence is insufficient, file the issue with "Insufficient evidence;
  revisit if observed again" and move on.
