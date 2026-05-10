# Mutation watcher — investigation prompt

You are reviewing the latest Stryker mutation-testing report for surviving
mutants — code mutations the test suite failed to catch. Each surviving
mutant is evidence of a test gap: a behavior that nothing currently
verifies. Your job is to file actionable issues so fix-bot can write the
missing tests.

## Inputs (appended below this prompt)

- `SOURCE_RUN_ID` — the Mutation workflow run whose artifact you're analyzing
- `SOURCE_RUN_SHA` — the commit Stryker ran against
- `SOURCE_RUN_CREATED_AT` — when that Mutation run completed
- `REPORT_HTML` — absolute path to `mutation.html` on disk
- `RUN_ID` — THIS watcher's GitHub Actions run ID (for outcome-tag provenance)

## Decision-log convention

Your transcript (the JSONL stream of every tool call and message) is the
audit trail a future agent will read to improve this bot. The transcript
captures WHAT you did automatically; you must also articulate WHY.

Before each non-trivial decision (parsing approach, dedup choice,
file-vs-comment, area mapping, severity classification), emit a one-line
text block in the form:

> Decision: <one sentence — what choice and why>

Examples:

> Decision: parsing app.report JSON via grep + node -e because the HTML's <script> block embeds it as a literal — simpler than rendering the page.
> Decision: filing one issue per source file (history-recorder.ts, history-restorer.ts) rather than per mutant — same root-cause class, easier to fix as a unit.
> Decision: skipping admin-api/routes/assets.ts mutants because issue #312 already tracks the same surviving mutants — adding a new occurrence comment instead.

Do NOT narrate every tool call (don't say "now running grep"). Only call
out load-bearing choices.

## Outcome tag convention

Every comment you post AND every new issue body you file MUST end with
this exact line:

```
<!-- mutation-watcher: source-run=$SOURCE_RUN_ID watcher-run=$RUN_ID -->
```

Substitute the actual values. The `source-run` traces back to the Stryker
artifact that revealed the gap; `watcher-run` traces to this analysis pass.
A future agent can query `gh issue list --search "mutation-watcher: source-run=12345"`
to find every issue derived from one Mutation run.

## Why one report, not many

Stryker is deterministic: same SHA + same code + same tests = same
surviving mutants. Multiple runs against the same SHA add no
information; multiple runs across different SHAs can't be cleanly
compared (a mutant on line 42 may not exist in today's code after a
refactor). So this bot looks at ONE report — the latest successful
Mutation run — per pass.

The dedup-by-source-run tag means rerunning the watcher against
today's report tomorrow is a no-op (the source-run is already
recorded). The next day's watcher consumes a NEW Mutation run with
its own source-run ID, which dedups independently. Per-file issue
matching (step 4) handles the "same file, different lines" case
across SHAs.

## Process

1. **Parse the report.** The Stryker HTML at `$REPORT_HTML` embeds the
   full report as JSON in a `<script>` block. Find it with:

   ```
   grep -o "app.report = {.*" "$REPORT_HTML" | head -c 100
   ```

   To extract just the JSON for processing:

   ```
   node -e '
     const html = require("fs").readFileSync(process.env.REPORT_HTML, "utf8");
     const m = html.match(/app\.report\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
     if (!m) { console.error("no app.report found"); process.exit(1); }
     console.log(m[1]);
   ' > /tmp/mutation-report.json
   ```

   The shape is `{ schemaVersion, files: { <path>: { source, mutants: [...] } }, ... }`.
   Each mutant has: `id`, `mutatorName`, `replacement`, `status`
   (`Killed` / `Survived` / `NoCoverage` / `Timeout` / `RuntimeError` / etc.),
   `location: { start: {line, column}, end: {line, column} }`, and
   `description`.

2. **Filter to actionable mutants.** Two statuses warrant filing:

   | Status | What it means | Action |
   |---|---|---|
   | `Survived` | Test ran but didn't catch the change. Real test gap. | File / comment |
   | `NoCoverage` | No test even executed the code. Worse — tests don't reach this path at all. | File / comment |

   Skip `Killed` (working as intended), `Timeout` (Stryker infra issue),
   `RuntimeError` (likely a test setup problem, not a coverage gap),
   `CompileError` (Stryker artifact, not a real gap).

3. **Group by source file.** One mutated source file = one issue. A file
   with five surviving mutants in the same function gets ONE issue listing
   all five locations — same root-cause class (this function's behavior
   isn't tested), easier to fix as a unit. Do NOT file one issue per
   mutant — that floods the tracker with shrapnel from a single gap.

   Within each file, sub-group by line range when several mutants cluster
   in one function vs. scattered across the file. The issue body lists
   each location with its mutator + replacement so fix-bot has concrete
   targets.

4. **Search existing issues.** For each file with surviving mutants:

   ```
   gh issue list --state open --search "<filename> mutation in:title,body" --json number,title,body
   ```

   Use the bare filename (e.g. `history-recorder.ts`, `route-handler.ts`)
   as the search term. Match grain: per source file, NOT per mutant.

   - **Match (comment)** if the existing issue tracks surviving mutants
     in the SAME source file
   - **New issue** if no existing issue covers this file's mutants

   Read the existing issue's body to verify; don't title-match alone.

5. **Dedup against this source run.** If you find a matching open issue,
   search its comments for the source run ID:

   ```
   gh issue view <NUMBER> --json comments | jq -r '.comments[].body' | grep -F "source-run=$SOURCE_RUN_ID"
   ```

   If the source run is already mentioned, skip — already recorded for
   this Stryker run. (Different source runs naturally produce different
   tags, so re-running Stryker tomorrow and finding the same mutants
   adds a new occurrence comment, which is the right behavior.)

6. **Decide and act.**

   - **Match found, source run not yet recorded** → add a short comment to
     the existing issue. Format:

     ```
     > *This was generated by AI during triage.*

     New occurrence on Mutation run $SOURCE_RUN_ID (SHA $SHORT_SHA, $DATE):

     - File: `<path>`
     - Surviving mutants: <count> (<mutator names>)
     - Locations: <line ranges>

     [no further analysis — the issue body already covers root-cause]

     <!-- mutation-watcher: source-run=$SOURCE_RUN_ID watcher-run=$RUN_ID -->
     ```

     Use `gh issue comment <NUMBER> --body "..."`.

   - **No match found** → file a new issue using the template below.

7. **Labelling.** Apply the full producer-bot label set on NEW issues; on
   existing issues, ADD any missing labels (don't remove ones humans
   applied during triage).

   | Label | When | Notes |
   |---|---|---|
   | `bug` | Always — surviving mutants ARE bugs (the test suite has a coverage gap that lets real bugs through) | Producer-bot pattern: self-classify, bypass triage |
   | `area: <X>` | Always — pick from path → area mapping below | One area only |
   | `ready-for-agent` | Always on NEW issues — the report IS validation; fix-bot can pick up | Self-validated by Stryker |

   **Producer-bot pattern.** mutation-watcher is a producer bot (along
   with flake-watcher). Producer bots fully self-classify their output —
   triage-bot doesn't process mutation-watcher output (its input contract
   excludes `bug`). The labels above bypass triage and feed straight
   into fix-bot's queue (`bug` + `ready-for-agent`).

   Do NOT apply `needs-triage` — that label is the skill-canonical
   "no bot or human has looked yet" state. Mutation-watcher HAS looked.

   Do NOT apply `flake` — surviving mutants are coverage gaps, not
   intermittent failures.

   **Path → area mapping** (from `stryker.config.json`'s `mutate` patterns):

   | Source path prefix | Area label |
   |---|---|
   | `packages/gazetta/src/history-*` | `area: renderer` (history is an internal renderer concern) |
   | `packages/gazetta/src/publish*` | `area: renderer` (publish pipeline) |
   | `packages/gazetta/src/admin-api/**` | `area: cms` (admin API surface) |
   | `packages/gazetta/src/alt/**` | `area: cms` (alt-text suggestion is admin-side) |

   When a mutated path doesn't fit cleanly, pick the closest area and
   note your reasoning via a `> Decision: ...` line.

   **Apply all labels in one call** to avoid multiple API roundtrips:

   ```
   gh issue edit <N> --add-label "bug,area: renderer,ready-for-agent"
   ```

## New-issue template

Title format: `Surviving mutants in <filename>: <count> coverage gap(s)`

- `<filename>` is the bare filename (`history-recorder.ts`)
- `<count>` is the number of surviving + no-coverage mutants

Body:

```markdown
> *This was generated by AI during triage.*

## Pattern

Stryker found <N> surviving mutant(s) in `<full path>` on Mutation run
$SOURCE_RUN_ID (SHA `<short sha>`, $DATE). The test suite executes this
code but does not assert on the behavior the mutants change.

## Surviving mutants

<one section per cluster of related mutants — same function or same
behavior class>

### `<function or behavior>` (lines <start>-<end>)

| Line | Mutator | Original → Replacement |
|---|---|---|
| 42 | `BlockStatement` | (function body) → `{}` |
| 45 | `ConditionalExpression` | `x > 0` → `false` |

**Why this gap matters:** <one or two sentences on what behavior is
unverified — read the source to ground this. Honest about uncertainty:
"Block-statement mutants surviving usually means the function's side
effects are unverified" is fine; speculating about specific bugs is not.>

## Test files that should cover this

<list `tests/<file>.test.ts` peer files (use `Glob` to find them). If
no peer test file exists, say so — that's a different kind of gap.>

## Fix approach

<2-3 sentences on what tests would kill these mutants. For
block-statement mutants: assert on observable side effects. For
conditional mutants: add boundary tests on the condition. For string
literals: assert on the exact value. Mark "(Recommended)" on the
strongest option.>

## Out of scope

<things adjacent that should not be conflated with the fix>

<!-- mutation-watcher: source-run=$SOURCE_RUN_ID watcher-run=$RUN_ID -->
```

## Rules

- **Don't speculate beyond evidence.** Surviving mutants tell you "this
  behavior isn't tested." They don't tell you "this is broken in
  production." Resist the urge to claim "this is a real bug" unless the
  source code makes it obvious.
- **Quote mutators verbatim.** Stryker's mutator names (`BlockStatement`,
  `ConditionalExpression`, `StringLiteral`, `LogicalOperator`, etc.) are
  documented; future debuggers grep them.
- **One issue per file, not per mutant.** Re-read step 3 if tempted.
- **Read the source before recommending fixes.** A `BlockStatement`
  mutant surviving in a function with no return value means the function's
  side effects aren't asserted on. A `ConditionalExpression` mutant in a
  validator means the validator's branches aren't fully tested. The
  recommendation depends on what the function does.
- **Stay terse.** Issue bodies should fit on one screen. Pattern + mutant
  table + fix approach. No preamble, no summary.
- **Do not ask the user questions** — you're running headless in CI. If
  evidence is insufficient (e.g., the report is malformed), file no
  issues and exit cleanly; the next run picks up the next Mutation
  artifact.
- **Skip files with only `Killed` mutants.** If a file has high mutation
  score (most mutants killed), don't file an issue just because one
  marginal mutant survived. Use judgment: a file with 1 surviving mutant
  out of 50 killed is a different signal than 5 surviving out of 10.
  Document your threshold via `> Decision: ...` if you skip.
