# Recipe: coverage-shape

**Use when** the candidate type is `tests` AND the candidate's
`summary` describes a coverage gap (e.g., "no test file exists for
X", "no test covers boundary condition Y", "no test exercises error
path Z").

**Not for** test-quality candidates that already have tests but the
tests are tautological / wrong-tier / isolation-broken — those fit
`tdd-first` because the fix is "rewrite the bad test" and a failing
test against the new shape can drive it.

## Why coverage-shape is NOT TDD-first

TDD-first ordering says: `failing test → fix`. For a coverage gap
against working code, this is impossible — there is no defect to
test-drive, no failing state to make green. Forcing TDD-first onto
this shape produces one of two failure modes:

- **Synthetic-failure trap**: write a test, observe it fails, write
  "the fix" that's actually just confirming what the code already
  did. The test is tautological by construction.
- **Stuck**: Agent A correctly refuses to write tautological tests
  and emits STUCK — leaving the genuinely valuable coverage gap
  unfilled.

The coverage-shape contract gives Agent A a path to add tests
against working code WITHOUT producing tautological tests, by
enforcing an explicit anti-tautology discipline.

## Coverage-shape contract

1. **Single commit.** No "failing test → fix" pair; the test should
   pass against the existing code on first run. Subject:
   `test(<area>): cover <what's covered>` or similar.

2. **Test against the interface, not the implementation.** Read the
   SUT's public surface (exported functions, route handlers, public
   class methods). Assert input/output behavior. Do NOT read the
   SUT's implementation while authoring assertions — that's how
   tautological tests are born (assertions match observed output).

3. **Anti-tautology counterfactual.** For EACH test you write, name
   the counterfactual: "what mutation of the SUT would make this
   test fail?" If you can't name a non-trivial mutation, the test
   is tautological — drop it or rewrite to a behavioral assertion
   that has a real counterfactual.

   Emit the counterfactual inline as a `> Decision: ...` note for
   each non-trivial test, so the reviewer can validate it.

4. **Cover real behavior, not coverage metrics.** Don't write tests
   to hit lines you haven't covered. Write tests for the contract
   the SUT exposes: input boundary conditions, error paths, side
   effects (when intentional), invariants (when documented). The
   review-tests skill's static-tautology check (Agent B) will
   catch tests that just exercise lines without asserting behavior.

5. **Right tier per testing-plan.md.** Pyramid for core; honeycomb
   for providers; trophy for admin SPA; crab for CLI. A test in the
   wrong tier is a finding (review-tests will flag it).

## Process

### 1. Read CANDIDATE_JSON; read the cited rule + testing-plan.md

The candidate's `rule` may cite `testing-plan.md` (e.g., a
"single-route coverage gaps" entry). Read it; the rule names the
tier shape + the kind of test expected.

### 2. Read the SUT's interface ONLY

Open the file the candidate names. **Read the exports + public
function signatures + any documented invariants in comments. Do
NOT read the function bodies before you've drafted assertions.**

(Why: reading the body before drafting assertions = the assertions
become a description of "what does this code do?" That's the
tautology pattern. Reading the interface first lets you assert
"what should this code do?" from outside.)

### 3. Read LESSONS_LEARNED

Cross-candidate patterns. Especially: areas where prior coverage
attempts produced tautological tests → avoid that pattern.

### 4. Draft assertions for behavior the interface promises

For each public surface, list:
- The input shape (parameters, request body, etc.)
- The expected output shape per input class
- Documented errors / boundary conditions
- Side effects (if any) — observable through the interface

Each assertion targets a behavior; each behavior must have a
**non-trivial counterfactual**.

### 5. Now read the implementation to verify your assertions are correct

Only AFTER drafting assertions, open the impl to confirm your
expected outputs are right. If they're wrong, update the assertion
+ document a `> Decision:` explaining the surprise (often: the
candidate's premise was that the code SHOULD do X but it actually
does Y — that's worth surfacing).

If the impl differs from what the interface promises (genuine bug
discovered during coverage work), STOP coverage and emit `RESULT:
STUCK` with the bug description — the maintainer should triage as
a `correctness` candidate via a fresh audit-area run, not roll a
bug fix into coverage work.

### 6. Write the tests

Per `testing-plan.md`'s tier shape:
- Pyramid sub-systems: unit-style with `vitest`
- Honeycomb sub-systems: integration with `testcontainers` if storage
- Trophy sub-systems: API-first via `app.request()` against
  `createAdminApp()` (the reference pattern is
  `admin-api-suggest-alt.test.ts`)
- Crab sub-systems: CLI scenario tests

Use `memoryStorage()` by default for admin-API tests (per
`testing-plan.md` "Storage tier"); fs-tier only when justified.

### 7. Run the tests; verify they PASS

```bash
npx vitest run <path-to-new-test-file>
```

Expected: PASS on first run. The tests describe what the working code
already does correctly. If a test FAILS, you either:
- Discovered a genuine bug → STOP coverage; STUCK with the bug
- Got the interface contract wrong → fix the assertion (not the impl)

### 8. Verify counterfactuals (anti-tautology gate)

For each non-trivial test, mentally run the counterfactual you
emitted as `> Decision: ...`. Concretely:
- If you said "the test would fail if the route returned 200 instead
  of 404 for missing items," would the test actually fail under that
  mutation? Trace your assertion.

If any counterfactual doesn't survive, that test is tautological.
Either rewrite it to a real counterfactual OR drop it.

### 9. Commit + push

```bash
git add <test-files>
git commit -m "test(<area>): cover <what's covered>"
git push origin $BRANCH_NAME
```

Single commit. The orchestrator's next step (Agent B / reviewer)
takes over.

## Coverage-shape-specific stuck conditions

In addition to the shared stop conditions in `agent-a.md`:

- **Genuine bug found during coverage**: the impl doesn't honor the
  interface's documented promise. STUCK; describe the bug. Maintainer
  triages as `correctness` via a fresh audit-area run.
- **Interface is undocumented + uninspectable**: no doc, no comments,
  no clear contract — you can't write tests against an interface that
  doesn't tell you what it promises. STUCK; recommend the maintainer
  document the contract first.
- **All possible tests would be tautological**: the SUT is a
  pass-through / identity / one-liner. STUCK; the coverage gap isn't
  worth filling.

## RESULT format

On success:

```
RESULT: PUSHED
Branch: improve/<candidate-id>
Commit: <subject>
Counterfactuals: <N counterfactuals emitted in commit / decision log>
```

On stuck:

```
RESULT: STUCK
Reason: <one paragraph: what made coverage-shape not fit; what the
maintainer should do instead (file as correctness candidate / document
the interface / accept the coverage gap)>
```

## Reviewer expectations (Agent B's view)

The `review-tests` skill checks coverage-shape work with these
specific lenses (in addition to standard test-quality checks):

- **Counterfactual presence**: did Agent A emit a counterfactual
  per non-trivial test? Missing counterfactuals → IMPORTANT finding.
- **Counterfactual quality**: does each counterfactual name a
  non-trivial mutation? "The test would fail if I deleted it" is
  not a counterfactual. → IMPORTANT finding.
- **Tier-shape match**: is the test in the right tier per
  `testing-plan.md`? Wrong tier → IMPORTANT finding.
- **Behavioral vs implementation-coupled**: do assertions reference
  what the code's interface promises (good) or what its
  implementation does (bad)? → CRITICAL when assertions read
  obviously implementation-derived.

If Agent B's review-tests skill finds tautology smells, the verdict
is REJECT with the specific test names — Agent A iterates by
rewriting them, not adding new ones.
