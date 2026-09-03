# Fix-bot lessons learned

Cross-issue patterns from reviewer verdicts + maintainer
rejections. Loaded into Agent A's prompt every run. Rewritten
monthly by `fix-bot:compact`; git preserves dropped lessons.

---

## Recurring patterns

### Mutation-coverage cuts: `Mode: structural`, adapt the tautology check

Dominant cut shape (14 cycles this window: #622, #623, #638,
#649, #650, #671, #676, #687, #703, #712, #726, #737, #738, #742):
test-only backfill against surviving Stryker mutants. No source
change, so the standard 4-step revert-check does NOT apply —
reverting a test file just removes the test.

**What Agent A should do:**
- Declare `Mode: structural` explicitly (diff is tests-only).
- Ship one commit; two-commit TDD-first doesn't fit when there's
  no source-side fix to sequence against.
- Fill `Runtime exercise:` with `N/A — <specific reason>` (e.g.
  `missing-test backfill; failing tests pin mutation-coverage
  invariants on already-correct behaviour`).
- Prove anti-tautology by **mutant injection**: apply each
  target mutant to source, run the test, confirm it fails with
  output matching the mutant's predicted effect, restore source.
  Report the concrete failure message — reviewers spot-check.
- Reference prior fix-bot cycles on the same file in the commit
  body (e.g. #676's "#311 → #567 → this run"). Shows reviewers
  where gaps live and prevents rework on covered surface.

### Honestly document equivalent / unkillable mutants

Reviewers positively cite honesty about mutants that CAN'T be
killed through tests — provably equivalent under current
schema/guards (#622 line 119, #687 line 212), invisible through
storage-abstraction observation (#712 lines 64/76/78, #742
lines 59/73/74), or unreachable via HTTP (#737 line 213).

**What Agent A should do:**
- For each surviving mutant, either ship a killing test OR
  document why it's equivalent/unkillable with a specific
  technical reason (which guard runs first, which caller never
  invokes the branch).
- Put equivalence claims in the commit body's `Discovered:`
  section so future cycles don't re-attempt them.
- Never pad the diff with tautological tests to "cover" an
  equivalent mutant.

### Verify the reporter's diagnosis before implementing

Three cycles this window (#659, #706, #745) succeeded because
Agent A traced the root cause and OVERRODE the reporter:

- #659: reporter suggested a skip-list feedback loop; real
  cause was a missing barrel filter at the discovery layer.
- #706: reporter counted `provider.ts` as "genuinely mutable";
  it's actually a pure-interface file.
- #745: reporter said "inter-test value leak"; the race was
  intra-test — `Ctrl+z` fired before the fill's onChange
  reached the undoStack.

**What Agent A should do:**
- Read the source paths named in the issue; verify the causal
  chain matches the reporter's description before coding.
- When the reporter is wrong, name the real cause in the
  summary with file:line evidence, and fix at the correct
  architectural layer even if it differs from their location.

### Flake fixes require rule-35 durability proof

Three flake fixes this window (#661, #744, #745). The default
4-step revert doesn't work — pre-fix state is nondeterministic.

**What Agent A should do:**
- Run `--repeat-each=5` under CI-equivalent conditions
  (`CI=true`, workers=1) and report the concrete pass count
  (#745: `25/25 pass across 5 tests × 5 repeats`).
- If the flake can't be reproduced locally (docker cold-start
  in #744; other CI-only pressure), state the structural reason
  in `Runtime exercise: N/A` and cite rule 35's local-vs-CI
  carve-out — do NOT substitute a warm-runner rerun.
- Diagnose whether the fix is behavioural (a real race — #745
  intra-test `Ctrl+z` timing) or structural (timeout-budget
  widening — #661, #744) and declare `Mode:` to match.

---

## Areas where Agent A succeeds

Zero maintainer rejections this window across 28 tracked cycles;
every PR merged. The four patterns above continue to pay rent
because reviewers actively spot-check them.
