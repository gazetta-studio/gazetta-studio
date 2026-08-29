# Fix-bot lessons learned

Cross-issue patterns observed across reviewer verdicts + maintainer
rejections. Loaded by Agent A's prompt on every run. Rewritten
monthly by `fix-bot:compact` from `skip-list.json` +
`reviewer-log.jsonl`. Git history preserves dropped lessons.

---

## Recurring failure modes

### Mutation-coverage cuts: `Mode: structural`, adapt the tautology check

The dominant cut shape (14+ issues in the last month: #622, #623,
#638, #649, #650, #671, #676, #687, #703, #712, #726, #737, #738,
#742) is a test-only backfill against surviving Stryker mutants.
No production source change, so the standard 4-step revert-check
does NOT apply — reverting a test file just removes the test.

**What Agent A should do:**
- Declare `Mode: structural` explicitly (diff is tests-only).
- Ship a single commit; the two-commit TDD-first shape doesn't
  fit when there's no source-side fix to sequence against.
- Fill `Runtime exercise:` with `N/A — <specific reason>` (e.g.
  `missing-test backfill; failing tests pin mutation-coverage
  invariants on already-correct behaviour`).
- Prove anti-tautology by **mutant injection**: for each new
  test, manually apply the target mutant to source, run the test,
  confirm it fails with output matching the mutant's predicted
  effect, then restore source. Report the concrete failure
  message in the summary — reviewers spot-check 2-3 claims.

### Honestly document equivalent / unkillable mutants

Reviewers positively cite honesty about mutants that CAN'T be
killed through test additions — either provably equivalent under
the current schema/guard structure (#622 line 119, #687 line 212),
or observationally invisible through the storage abstraction
(#712 lines 64/76/78, #742 lines 59/73/74).

**What Agent A should do:**
- For each surviving mutant the issue names, either ship a
  killing test OR document why it's equivalent/unkillable with a
  specific technical reason (which guard runs first, which
  operator's output is indistinguishable from the mutated form).
- Put equivalence claims in the commit body's `Discovered:`
  section so future cycles don't re-attempt the same mutant.
- Never pad the diff with tautological tests to "cover" an
  equivalent mutant.

### Verify the reporter's diagnosis before implementing

Three cycles this month (#659, #706, #745) succeeded because
Agent A independently traced the root cause and OVERRODE the
reporter's stated diagnosis:

- #659: reporter suggested a skip-list feedback loop; real cause
  was a missing barrel filter at the discovery layer.
- #706: reporter counted `provider.ts` as "genuinely mutable";
  Agent A verified it's actually a pure-interface file.
- #745: reporter said "inter-test value leak"; the actual race
  was intra-test — `Ctrl+z` fired before the fill's onChange
  reached the undoStack.

**What Agent A should do:**
- Read the source paths named in the issue and verify the causal
  chain matches the reporter's description before writing code.
- When the reporter's diagnosis is wrong, name the real root
  cause in the summary with file:line evidence.
- Fix at the correct architectural layer even if it differs from
  the reporter's recommended location.

### Flake fixes require rule-35 durability proof

Three flake fixes shipped this month (#661, #744, #745). The
prompt's default 4-step revert doesn't work — pre-fix state is
nondeterministic, so a single green run doesn't prove load-bearing.

**What Agent A should do:**
- Run `--repeat-each=5` on the affected test under CI-equivalent
  conditions (`CI=true`, workers=1) and report the pass count in
  the runtime-exercise section (e.g. `25/25 pass across 5 tests`).
- If the flake condition cannot be reproduced locally (docker
  cold-start, CI-only resource pressure), state the specific
  structural reason in `Runtime exercise: N/A` — do NOT
  substitute a warm-runner rerun as evidence.
- Diagnose whether the fix is behavioural (a real race — #745)
  or structural (timeout budget widening — #661, #744) and
  declare `Mode:` to match.
