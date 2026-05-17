# Recipe: tdd-first

**Use when** the candidate type is `correctness`, `security`,
`architecture`, `types`, `comments`, or `style` (bug-class candidates
where the fix changes behavior, the cited rule names a defect, or
the change shape is "wrong → right").

**Not for** `tests`-class candidates (use `coverage-shape` instead).
A `tests`-class candidate is one where the SUT is already working
and the gap is "no test exists" — TDD-first can't drive working code.

## TDD-first contract

Per [team-preferences.md rule 31](../../../../.claude/rules/team-preferences.md):

1. **First commit MUST be a failing test.** Subject: `test: ...` or
   `failing test: ...`. The test must exercise the candidate's
   specified improvement; running it BEFORE the fix MUST fail.
2. **Second commit IS the implementation.** Subject prefix per the
   candidate's type (`fix(<area>): ...`, `refactor(<area>): ...`,
   `feat(<area>): ...`, etc.).

If you cannot capture the candidate as a failing test (the candidate
is structural — e.g., "split a file into smaller files" — or the
test would be tautological), emit `RESULT: STUCK` with a constructive
maintainer-action recommendation. Do NOT push an implementation-only
commit; the reviewer (Agent B) will REJECT it.

## Process

### 1. Read CANDIDATE_JSON; read the cited design doc

The candidate's `rule` field cites a design doc (or `file:line`). Read
that doc; it's the contract you're improving against. Don't re-litigate
the candidate — the audit-area skill already ranked it as worth doing.

### 2. Read LESSONS_LEARNED

Cross-candidate patterns from prior review-bot runs. Examples to expect
once data accumulates:
- Common candidate-types that maintainers reject (skip those)
- Areas where prior Agent A produced stuck-comments (scope your change
  tighter to avoid the same trap)
- Hints from prior runs (e.g., "always add the validator at the
  background phase if save-delta would be too eager")

### 3. Write the failing test

The test must:
- Live in the right tier per [`testing-plan.md`](../../../../.claude/rules/testing-plan.md)
  (pyramid for core; honeycomb for providers; trophy for admin SPA; crab
  for CLI)
- Exercise the SPECIFIC improvement the candidate names. Don't write a
  generic "this area should work" test; assert the behavior the
  candidate would unlock
- Have a clear failure message that aligns with the candidate's
  `summary`

Commit: `git add <test-files>; git commit -m "test: <what the test asserts>"`.

### 4. Verify the test FAILS before the fix

Run the test (most-specific invocation; per `team-preferences.md#32`):

```bash
npx vitest run <path-to-new-test-file>
```

Expected: FAIL with a message that matches the candidate's summary.
If the test PASSES already, the candidate may already be implemented
or the test is tautological. `RESULT: STUCK` + bail.

### 5. Implement the fix

Apply the improvement per the candidate's `suggested_action`. Stay
narrow — do NOT add unrelated cleanup, refactor surrounding code, or
expand scope beyond what the candidate names. The reviewer (Agent B)
will REJECT scope creep.

Commit: `git add <impl-files>; git commit -m "<verb>(<area>): <change>"`.

### 6. Re-run the test; verify it PASSES

```bash
npx vitest run <path-to-new-test-file>
```

Expected: PASS. The fix made the test green without changing the test.

If the test still fails, the implementation didn't cover the test's
assertion. Iterate ONCE on the implementation (no new commit; amend
the fix commit before the orchestrator pushes). If still failing
after amendment, `RESULT: STUCK` + bail.

### 7. Push the branch

```bash
git push origin $BRANCH_NAME
```

The orchestrator's next step (Agent B / reviewer) takes over from here.
Don't open a PR yourself — Agent B's verdict gates that.

## TDD-first-specific stuck conditions

In addition to the shared stop conditions in `agent-a.md`:

- **Cannot write a failing test**: candidate is structural (e.g.,
  "split this file") and TDD-first doesn't apply. STUCK; recommend
  the candidate move to a different recipe or to a maintainer.
- **Test passes without the fix**: the candidate's premise is wrong
  OR the test is tautological. STUCK; report your investigation.
- **Test still fails after one amendment to the impl**: the fix
  approach is wrong or out of scope. STUCK; report what you tried.

## RESULT format

On success:

```
RESULT: PUSHED
Branch: improve/<candidate-id>
Test commit: <subject of commit 1>
Fix commit: <subject of commit 2>
```

On stuck:

```
RESULT: STUCK
Reason: <one paragraph: what made TDD-first not fit this candidate;
constructive maintainer action recommended>
```
