# review-bot — monthly lessons-learned compaction

You are rewriting `bots/review-bot/lessons-learned.md` based on the
bot's accumulated skip-list + recent reviewer-log. Your job is to
identify **cross-candidate patterns** across improvement attempts
and surface them as prose Agent A will load in its prompt on future
runs.

This is the OPPOSITE of compacting a database. The skip-list keeps
its concrete per-candidate entries (durable memory, never re-
compacted into rules in review-bot's case — most rejections are
per-candidate-unique). What you're compacting is the
**understanding** of failure modes accumulated across attempts.

## Inputs (appended below)

- `SKIP_LIST_PATH` — relative path to the skip-list file
- `LESSONS_PATH` — relative path to the lessons-learned.md file
- `SKIP_LIST_JSON` — full current skip-list state (per-candidate
  rejections, stuck cases, needs-human cases)
- `REVIEWER_LOG_JSON` — recent Agent B verdicts (window-bounded).
  Each entry: `{ts, runId, fingerprint, fingerprintLabel, attempt,
  verdict, reasoning, agentASummary}`. APPROVE, REJECT, and
  NEEDS_HUMAN verdicts all land here.
- `PREVIOUS_LESSONS` — current content of lessons-learned.md
- `RUN_ID` — diagnostic only

## Value filter — what to actually surface

The reviewer-log captures EVERY verdict; most are noise (clean
first-attempt approves with "looks good"). Only these patterns
deserve a lesson:

1. **Reject → retry → approve** sequences — Agent A's first attempt
   was rejected, the next succeeded. What changed? Transferable
   pattern.
2. **Approves with substantive caveats** — Agent B said "approving
   but noticed X." Across ≥2 candidates with the same caveat: surface
   it.
3. **Substantive REJECT reasoning** — recurring reject themes (same
   rationale across 2+ candidates) → "don't do this" lesson.
4. **Loop-exhausted needs-human** — genuine failure modes where
   Agent A and reviewer couldn't converge. Future Agent A should
   recognize the pattern + skip early.
5. **Phase 0/1 patterns** — areas where audit-area consistently
   produces low-quality candidates, or candidate-types that
   maintainers reject consistently. Useful for Phase 0 scoring
   tuning (manual tuning by maintainer, not bot-side; surface the
   signal).

**Reject these as lessons:**

- ❌ Clean first-attempt approves with "looks good" reasoning
- ❌ Single-instance observations (no pattern yet — wait for recurrence)
- ❌ Per-candidate specifics already captured in skip-list.json
- ❌ Static guidance already in `prompts/agent-a.md`
- ❌ Notes about Phase 0 scoring weights (those are tuned manually
  by maintainer in `area-scorer.ts`, not via lessons)

## Holistic rewrite, NOT append

Critical. Each month you read the FULL skip-list + previous lessons,
then rewrite lessons-learned.md from scratch. What stays vs goes:

| Decision | Action |
|---|---|
| Pattern still observed across recent rejections | Keep |
| Pattern was real but only one rejection cites it (was overweighted) | Drop |
| Pattern observed but the codebase has since fixed the underlying issue | Drop |
| Pattern emerging from this month's rejections (new) | Add |
| Pattern in previous lessons that no longer applies | Drop |

Git history preserves dropped lessons. They're not lost; they're
no longer in active prompt context.

## Decision-log convention

Articulate major edits with `> Decision: ...` text:

> Decision: dropping "always cite the design doc in the test commit message" — only 1 rejection cited this; likely single-case, not a pattern.
> Decision: keeping "structural-improvement candidates often need redesign (NEEDS_HUMAN), not retry" — 3 needs-human results this month, plus 2 from prior months, all citing structural-vs-implementation confusion.
> Decision: new lesson — "security candidates in admin-api/ that need new capability literals require maintainer review (design-auth-rbac.md change implied)" — emerged from 2 NEEDS_HUMAN results this month.

## How to identify a pattern

A pattern is a recurring **failure mode** across ≥2 attempts. Look
for clusters in the skip-list + reviewer-log:

- **Same reason category** repeated (`maintainer-rejected` × 4)
- **Similar rejection reasonNote phrasing** (multiple "scope crept;
  Agent A added unrelated changes" / "the test was tautological"
  / "fix didn't address the root cause")
- **Same area** repeated (3 candidates in `admin-api/routes/`
  needing similar architectural treatment)
- **Same candidate type** repeated (3 security-typed candidates
  resulting in NEEDS_HUMAN because they implied capability changes)

**Lower bar than skip-list rule compaction.** Two observations of
the same failure mode = a pattern worth surfacing. The cost of a
false positive is "Agent A reads a paragraph that doesn't apply" —
minor. The cost of a false negative is "Agent A repeats the failure
mode on the next candidate" — the whole point of this system.

## Output format

The rewritten `lessons-learned.md` follows this structure:

```markdown
# review-bot lessons learned

[Optional one-line intro reminding readers this file is rewritten
monthly + how to use it.]

## Pattern 1: [short descriptive headline]

[1-2 paragraphs of prose. Cite the underlying signal — "across 3
rejections this quarter:" — so the reader can verify the pattern.
End with concrete guidance Agent A can apply on the next candidate
of this type.]

## Pattern 2: [...]

[...]

(Empty patterns OK — if no patterns recur, the file may legitimately
be empty + just the intro line. Don't pad with weak observations.)
```

## Stop conditions

- Stop after one rewrite. The file is committed via PR by the
  bots-compact workflow; you don't push.
- If you discover the skip-list + reviewer-log don't have enough
  signal for ANY pattern (rare but possible), emit an empty
  lessons-learned with the intro line + exit.
- Do NOT modify `skip-list.json`, `prompts/agent-a.md`, or any other
  file. Only `lessons-learned.md`.

## Decision discipline

Per `bots/README.md` decision-log convention, emit `> Decision: ...`
notes inline. Be specific: cite the entries that drove your
decision ("dropped X because the only entry citing it is from
2026-04 and the area has been refactored since"). Don't narrate
every step — only the load-bearing choices.
