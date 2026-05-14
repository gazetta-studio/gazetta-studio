# Fix-bot — monthly lessons-learned compaction

You are rewriting `bots/fix-bot/lessons-learned.md` based on the
bot's accumulated skip-list. The skip-list contains per-issue
records of maintainer rejections (and bot-detected failure modes);
your job is to identify **cross-issue patterns** and surface them
as prose Agent A will load in its prompt on future runs.

This is the OPPOSITE of compacting a database. The skip-list keeps
its concrete per-issue entries (they're durable memory, never
re-compacted into rules in fix-bot's case — most rejections are
per-issue-unique). What you're compacting is the **understanding**
of failure modes accumulated across rejections.

## Inputs (appended below)

- `SKIP_LIST_PATH` — relative path to the skip-list file
- `LESSONS_PATH` — relative path to the lessons-learned.md file
- `SKIP_LIST_JSON` — full current skip-list state (per-issue rejections)
- `REVIEWER_LOG_JSON` — recent Agent B verdicts (window-bounded).
  Each entry: `{ts, runId, fingerprint, fingerprintLabel, attempt,
  verdict, reasoning, agentASummary}`. APPROVE, REJECT, and
  NEEDS_HUMAN verdicts all land here; the value filter is yours.
- `PREVIOUS_LESSONS` — current content of lessons-learned.md
- `RUN_ID` — diagnostic only

## Value filter — what to actually surface

The reviewer-log captures EVERY verdict. Most are noise (trivial
first-attempt approves with "looks good"). Only these patterns
deserve a lesson:

1. **Reject → retry → approve** sequences — Agent A's first attempt
   was rejected, the next succeeded. What changed? That's a
   transferable fix pattern.
2. **Approves with substantive caveats** — Agent B said "approving
   but noticed X." Cluster across ≥2 entries: when reviewers raise
   the same caveat across different issues, surface it.
3. **Substantive REJECT reasoning** — recurring reject themes (same
   rationale across 2+ findings) → "don't do this" lesson.
4. **Loop-exhausted needs-human** — genuine failure modes where
   Agent A and reviewer couldn't converge. Future Agent A should
   recognize the pattern and SKIP early.

**Reject these as lessons:**

- ❌ Clean first-attempt approves with "looks good" reasoning
- ❌ Single-instance observations (no pattern yet — wait for it to recur)
- ❌ Per-issue specifics already captured in skip-list.json
- ❌ Static guidance already in `prompts/per-issue.md`

## Holistic rewrite, NOT append

Critical distinction. Each month you read the FULL skip-list +
previous lessons, then rewrite lessons-learned.md **from scratch**.
What stays vs goes:

| Decision | Action |
|---|---|
| Pattern still observed across recent rejections | Keep |
| Pattern was real but only one rejection cites it (was overweighted) | Drop |
| Pattern observed but the codebase has since fixed the underlying issue | Drop |
| Pattern emerging from this month's rejections (new) | Add |
| Pattern in previous lessons that no longer applies (Agent A successfully avoids) | Drop |

Git history preserves dropped lessons. They're not lost; they're
no longer in active prompt context.

## Decision-log convention

Articulate the major edits with `> Decision: ...` text:

> Decision: dropping "always read failure-diagnostic.ts before fixing fix-bot" — only one rejection cited this and it's likely a single-case slip, not a pattern.
> Decision: keeping "verify the fix is in the call chain, not just the entry point" — 3 rejections this month, plus 2 from prior months, all citing root-cause-vs-symptom.
> Decision: new lesson — "before fixing a flake, verify reproduction in CI conditions (`--repeat-each=5` per rule 35)" — emerged from 2 rejections this month.

## How to identify a pattern

A pattern is a recurring **failure mode** across ≥2 rejections.
Look for clusters in the skip-list:

- **Same reason category** repeated (`maintainer-rejected` × 4)
- **Similar rejection reasonNote phrasing** (multiple "wrong root cause" / "fix the symptom not the cause" / "this is in the entry point but the bug is in helper X")
- **Same area** repeated (3 fix-bot rejections all in `admin-api/routes/`)
- **Same kind of bug** repeated (3 rejections on flake fixes that didn't address the actual race)

**Lower bar for "pattern" than skip-list rule compaction.** Two
observations of the same failure mode = a pattern worth surfacing
to Agent A as guidance. The cost of a false positive is "Agent A
reads a paragraph that doesn't apply" — minor. The cost of a false
negative is "Agent A repeats the failure mode on a future issue" —
the whole point of this system.

## Output format

The rewritten `lessons-learned.md` follows this structure:

```markdown
# Fix-bot lessons learned

<one-paragraph header explaining the file — keep similar to the
existing version, just refreshed for accuracy>

---

## Recurring failure modes

### <Pattern name 1>

<one-paragraph description of the pattern. Concrete: what does
Agent A do wrong? What should Agent A check / consider before
forming its hypothesis?>

**Cited rejections:** #N, #M, #K (with one-sentence summary each
or "see audit log").

**What Agent A should do:** <2-4 bullet points of specific
guidance. Concrete and actionable, not "be careful".>

### <Pattern name 2>

...

---

## Areas where Agent A succeeds (negative evidence)

<Optional section if some areas of the codebase have repeated
successful fixes — Agent A can lean on those patterns.>
```

Keep the whole file **under 4KB** — Agent A loads this into its
prompt context every run. Brevity matters. If you find more than
~5 patterns, the file is too long; merge or drop the weakest.

## Process

1. Read `SKIP_LIST_JSON`. Sort entries by `addedAt` descending
   (most recent first).
2. Read `PREVIOUS_LESSONS`. Note which patterns are mentioned.
3. For each potential pattern, count supporting rejections:
   - 1 rejection → not yet a pattern (mention in a decision-log
     line but don't add to lessons)
   - 2+ rejections → real pattern, add to lessons
4. Drop previous lessons that no longer have ≥2 supporting
   rejections in the current skip-list.
5. Rewrite `LESSONS_PATH` from scratch using the structure above.
6. Open a PR with the rewrite:

```bash
git checkout -b fix-bot-compact/$(date -u +%Y-%m)
git add $LESSONS_PATH

npm run format

git commit -m "$(cat <<EOF
chore(fix-bot): monthly lessons-learned compaction — $entriesBeforeCount entries reviewed

Rewrites lessons-learned.md based on this month's accumulated
skip-list. Patterns kept: <count + brief enumeration>. Patterns
dropped: <count + brief enumeration>. New patterns: <count + brief
enumeration>.

See git history for previous lessons that have been pruned.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin fix-bot-compact/$(date -u +%Y-%m)

gh pr create --title "chore(fix-bot): monthly lessons-learned compaction" --body "$(cat <<EOF
## Why

Monthly fix-bot memory compaction. Reads the skip-list, surfaces
recurring failure-mode patterns into Agent A's prompt context.

## What changed

- Patterns kept: <enumerate>
- Patterns dropped: <enumerate + one-sentence why each>
- New patterns: <enumerate + cited rejection issues>

## How to review

Read the diff in \`$LESSONS_PATH\`. The before/after format is the
same; the patterns themselves are the change.

If you want a pattern Agent A is being taught to follow to be
narrower / broader / removed: edit the file in this PR (or a
follow-up).

<!-- fix-bot-compact: run=$RUN_ID -->
EOF
)"
```

## Rules

- **Rewrite, don't append.** The skip-list is the durable record;
  lessons-learned is the synthesis. Last month's lessons aren't
  load-bearing for this month's rewrite unless the patterns still
  appear in the current skip-list.
- **Be concrete.** "Agent A should think about root causes" is
  useless. "Before fixing a bug in `routes/X.ts`, check if the
  caller in `helpers/Y.ts` is mutating state Agent A doesn't see"
  is useful.
- **Don't ask the user questions.** Headless in CI. If you can't
  identify ≥2-rejection patterns, exit without a PR.
- **Keep the file small** (<4KB). Agent A reads this every run;
  size adds up.
- **One compaction PR per run.** No partial commits, no incremental
  edits — one PR rewrites the whole file.
