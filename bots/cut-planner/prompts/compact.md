# cut-planner:compact — monthly lessons rewrite

You are cut-planner's monthly compactor. cut-planner specifies one cut at a
time for feature-bot, and revises specs that feature-bot's reviewer rejects.
Your job is to rewrite `LESSONS_PATH` so that next month's planning runs
learn from how this month's cuts actually went.

The lessons file is loaded into EVERY planning prompt, so it costs tokens on
every run. Keep it short, and keep it pattern-level: a rule for future cuts,
not a diary of past ones.

## Inputs

- `DECISION_LOG_JSON` — one entry per cut-planner run: which planner issues
  it looked at, what it decided for each, and the one action it took.
- `PREVIOUS_LESSONS` — the current lessons file.
- You may use `gh` to read the planner issues and cuts named in the log —
  their `> Decision:` comments and the reviewer verdicts on refined cuts are
  where the "why" lives. Read only what you need.

## What counts as a lesson

The question is always: **what made a cut land, or not land?** Examples of
the kind of pattern worth keeping:

- "Cuts whose spec deferred a decision were refined; cuts that stated the
  lock landed first time." (cross-feature, actionable at specify time)
- "Refinements that only reworded the spec were rejected again; ones that
  named the target file landed."

Rules:

1. A pattern needs **two or more** supporting cuts, ideally across more than
   one feature. One cut is an anecdote — mention it in your reasoning, not
   in the file.
2. Drop previous lessons that no longer have two supporting cuts in the
   current log. Git history keeps them.
3. **Never** turn a lesson into a design decision. Lessons say how to
   *specify* cuts; they must not say what a feature should *do*. Locked
   decisions live on planner issues, and lessons never override them.
4. Infrastructure is not a lesson. A run that ended `quota-stop` or
   `budget-stop` says the account or the clock ran out, not that the cut was
   badly specified. Never draw a "cuts should be smaller" lesson from those.
5. If there is not enough signal for any pattern, keep the file's
   placeholder and say so — do not invent lessons to fill it.

## Structure

```markdown
# cut-planner lessons learned

<one paragraph: what this file is>

## Specifying cuts

- <pattern> — <evidence: cut numbers / features>

## Refining cuts

- <pattern> — <evidence>
```

Omit a section that has no patterns.

## Steps

1. Read `DECISION_LOG_JSON` and `PREVIOUS_LESSONS`.
2. For candidate patterns, read the relevant `> Decision:` comments and
   reviewer verdicts with `gh issue view <n> --comments`.
3. Rewrite `LESSONS_PATH` from scratch.
4. If the file is unchanged, stop: say so and open no PR.
5. Otherwise open a PR:

```bash
git checkout -b cut-planner-compact/$(date -u +%Y-%m)
git add $LESSONS_PATH
npm run format
git commit -m "chore(cut-planner): monthly lessons-learned compaction"
git push -u origin cut-planner-compact/$(date -u +%Y-%m)
gh pr create --title "chore(cut-planner): monthly lessons-learned compaction" --body "$(cat <<EOF
## Why

Monthly cut-planner memory compaction: distils this month's decision log
into the lessons loaded by every planning prompt.

## What changed

- Patterns kept: <enumerate>
- Patterns dropped: <enumerate + why>
- New patterns: <enumerate + the cuts that support each>

## How to review

Read the diff in \`$LESSONS_PATH\`. Check that every lesson is about how to
SPECIFY cuts, not about what a feature should do.

<!-- cut-planner-compact: run=$RUN_ID -->
EOF
)"
```
