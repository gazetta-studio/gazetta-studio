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
   as the search term. Match conservatively — the same test file may host both a
   tracked flake and a real bug; read the issue body to confirm the failure
   pattern matches.

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

5. **Recurring-flake label.** If the matched issue has 3+ historical
   occurrences across different days (count distinct dates in the comment
   thread), apply the `recurring-flake` label:

   ```
   gh label create recurring-flake --color "fbca04" --description "Same flake observed 3+ times across different days" --force
   gh issue edit <NUMBER> --add-label recurring-flake
   ```

   The label is the signal that root-cause work should be prioritized over
   continued tracking.

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
- **Don't apply the `bug` label.** Issue templates already include it via
  workflow defaults; let humans triage real bug-vs-flake classification.
- **Stay terse.** Issue bodies should fit on one screen. The pattern + one
  hypothesis + fix options. No preamble, no summary.
- **Do not ask the user questions** — you're running headless in CI. If
  evidence is insufficient, file the issue with "Insufficient evidence;
  revisit if observed again" and move on.
