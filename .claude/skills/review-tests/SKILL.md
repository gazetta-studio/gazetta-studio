---
name: review-tests
description: Review test quality on the diff — TDD ordering (failing test commit precedes fix), static tautology detection, tier shape per testing-plan.md (pyramid/honeycomb/trophy/crab), isolation per rule 26, light mutation viability. Static-only — does NOT run tests; the runtime tautology check stays in fix-bot's reviewer. Fires when *.test.ts / *.spec.ts files change.
allowed-tools: Bash Read Grep Glob
argument-hint: [--base <ref>] [--pr <N>]
---

# Review-tests — Phase 2 angle

Tests have specific failure modes that generic review misses: tautological assertions that pass without proving anything, wrong tier shape for the SUT, module-level state shared between tests, missing TDD ordering in fix-style commits. This angle catches them statically — by reading the test code and the commit log, never by running anything.

The complement is fix-bot's reviewer step 1 (the 4-step runtime tautology check: revert fix → test must fail → re-apply → test must pass). That stays where it is. This angle is static + judgment only.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design + the rationale for the static/runtime split (Q4 in the grilling).

## What this angle owns (static + judgment)

- TDD ordering: when the diff is a fix-style commit pair (`failing test:` + `fix:`), verify the test was added before the fix and that it's structured to fail without the fix
- Static tautology detection: assertions that wouldn't fail under reasonable mutations to the implementation
- Tier shape: pyramid (core: renderer/hash/sidecars/parsers — heavy unit); honeycomb (storage providers — testcontainers integration); trophy (admin SPA — component + scenario); crab (CLI — heavy scenario). Mismatch warrants a finding.
- Isolation per [`team-preferences.md#26`](../../rules/team-preferences.md): per-test fresh storage / fresh tempdir; no module-level mutable state shared between tests; no implicit ordering dependency
- Coverage of error paths: when the SUT has multiple error branches, at least one negative-case test exists
- Light mutation viability: heuristic spot-check — do the assertions look behavior-y enough to survive mutations? Full check stays with mutation-watcher.

## What this angle does NOT own

- Runtime tautology check (fix-bot reviewer's runtime step 1)
- Mutation testing (mutation-watcher bot's job)
- Test framework choice / test runner config
- Whether `npm test` passes (CI's job)
- Type-level correctness of mocks (`review-types`)
- General code quality inside test bodies (`review-diff` if the diff is interesting beyond test-specific concerns)

## Reads (always)

- [`.claude/rules/team-preferences.md`](../../rules/team-preferences.md) rule 26 (test isolation) + rule 31 (TDD-first + tautology) + rule 4 (tests alongside features)
- [`.claude/rules/testing-plan.md`](../../rules/testing-plan.md) — tier shape per sub-system, storage tier guidance

## Process

### 1. Identify test changes in the diff

Files matching `tests/`, `*.test.ts`, `*.spec.ts` per `bots/_lib/review-dispatch.ts:matchesTests`.

### 2. Check TDD ordering when applicable

Read the commit log from metadata. If two commits exist matching the fix-pattern (`failing test:` / `test:` / `failing` followed by `fix:` / `feat:` / `refactor:`), verify:

- The test-commit precedes the implementation-commit (TDD-first per rule 31)
- The test-commit's diff includes ONLY test files (no implementation changes leaking in)
- The implementation-commit's diff modifies the SUT in a way that the test references

If the order is reversed or test+impl are conflated in one commit: that's an IMPORTANT finding for fix-style work, NIT for non-fix work.

### 3. Static tautology check

For each new or modified test, ask: "what does this test actually prove?"

Tautology smells:
- **Assertion mirrors implementation literal**: test asserts `result.kind === 'foo'` when the impl literally returns `'foo'` without computation — the test will pass for any value
- **Mock returns expected value**: test mocks the dep to return X, then asserts the result is X — tests the mock, not the code
- **Trivial input round-trips**: `expect(identity(5)).toBe(5)` with no transformation worth verifying
- **`expect().toBeDefined()`** when no realistic scenario produces `undefined` — proves nothing
- **`expect.any(Object)`** on an assertion that could be anything

For each suspected tautology, ask the counterfactual: "would this test fail if I deleted the fix?" If the answer is "no" — the test is tautological.

### 4. Tier shape check

Read `testing-plan.md` for the SUT's expected tier. Common mappings:

| SUT | Expected tier |
|---|---|
| `packages/gazetta/src/{hash,sidecars,renderer,parsers}.ts` (core pure logic) | Pyramid (unit-heavy) |
| `packages/gazetta/src/providers/` (storage providers) | Honeycomb (testcontainers integration) |
| `packages/gazetta/src/admin-api/routes/` | Trophy (API tests via `app.request()`) |
| `apps/admin/src/client/` | Trophy (Vue Test Utils + Playwright) |
| `packages/gazetta/src/cli/` | Crab (CLI integration scenarios) |

A unit test for an admin-api route IS a finding (should be API-tier). An integration test for `hash.ts` IS a finding (should be unit). The exception is genuinely cross-tier behavior (per rule 31's "deviate when the SUT spans tiers").

### 5. Isolation check

Per rule 26, for each new test file or modified test:

- Does the file have module-level `tempDir(name)` without `Date.now()` or per-test suffix?
- Does the file have module-level mutable arrays/maps/objects that beforeEach doesn't reset?
- Does any test depend on another test running first (e.g., assumes data created in an earlier `it()` is present)?

Module-level constants are fine (e.g. `const TEST_BASE = 'main'`). Module-level mutable state shared across tests is NOT.

### 6. Coverage-of-error-paths check (light)

If the SUT has multiple error branches (per the impl in the diff), check whether at least one test exercises a non-happy path. Not exhaustive coverage — just "did the test author consider failure?"

### 7. Form findings + cite the rule

| Severity | When |
|---|---|
| **CRITICAL** | Tautological test that would let a regression ship (the asserted behavior exists regardless of the impl); test mutates a module-level singleton that other test files depend on; TDD ordering inverted on a fix-PR (test came AFTER fix) |
| **IMPORTANT** | Wrong tier shape (unit test where integration belongs or vice versa); isolation issue (per-test resources not fresh); missing negative-path test for a multi-branch SUT |
| **NIT** | Minor isolation smell that won't bite under current vitest config; assertion that's borderline tautological but probably fine |

Confidence ≥ 80 to emit. Citations:
- `team-preferences.md#26` — isolation
- `team-preferences.md#31` — TDD-first / tautology
- `testing-plan.md#<section>` — tier shape
- `<file-name>:<line>` — when the issue is pure test-code analysis

### 8. Emit prose + findings fence

Same structure as every Phase 2 angle. Above the fence:
- `> Decision: ...` notes for TDD-ordering, tier-shape, isolation checks performed
- Note explicitly that the RUNTIME tautology check is fix-bot reviewer's job; this angle is static-only

Findings fence below (possibly empty):

````
```findings
{"severity":"IMPORTANT","file":"packages/gazetta/tests/foo.test.ts","line":12,"confidence":85,"category":"tests","rule":"team-preferences.md#26","message":"module-level tempDir('foo-test') is shared across all tests in this file; under future parallel-within-file mode this races","suggestion":"replace with per-test `tempDir(\\`foo-test-${Date.now()}-${i}\\`)` in beforeEach"}
```
````

## Anti-patterns (illustrative)

**Tautological test:**
```ts
// impl: function isAdmin(role: string) { return role === 'admin' }
test('returns true for admin', () => {
  expect(isAdmin('admin')).toBe(true)  // tautology — proves nothing
})
```
→ The test should exercise the BRANCH (admin path) AND its complement (non-admin path) so reverting either branch's logic fails.

**TDD-ordering reversed:**
```
commit log:
  abc123 fix(auth): handle missing capability gracefully
  def456 test(auth): add test for missing capability
```
→ Test commit should precede fix commit (rule 31).

**Module-level shared state (rule 26 violation):**
```ts
const sites = new Map<string, Site>()

beforeEach(() => {
  // doesn't reset sites — earlier test's data leaks in
})
```

**Wrong tier shape:**
```ts
// SUT is packages/gazetta/src/admin-api/routes/pages.ts
// Pure unit test of an internal helper instead of API-level test via createAdminApp()
import { _internalRouteHelper } from '../routes/pages.js'
test('helper returns expected result', () => {...})
```

**Mocked dep mirrors expected value:**
```ts
mockGetUser.mockReturnValue({ id: 'X' })
const result = await fetchUser('X')
expect(result.id).toBe('X')  // proves mock works, not the code
```

## What NOT to flag

- Use of `vi.mock` per se (mocks are fine when used for boundary isolation, not for tautology)
- Test file length (`testing-plan.md` may say "split when > 200 lines" but that's a NIT at best)
- Test names that could be more descriptive (style nit; not a finding)
- Tests using snapshot assertions on stable output (snapshots are fine when the assertion is genuinely about exact bytes)
- Coverage percentages (not the goal per rule 31)

## When to invoke

Fires from the orchestrator when the dispatch detects test file changes (`bots/_lib/review-dispatch.ts:matchesTests`). Direct invocation (`/review-tests`) is supported for focused review.

## Stop conditions

- Stop if the diff has no test changes
- Stop after checking TDD ordering + tautology + tier + isolation + error paths for each test
- Emit findings (possibly empty)

## Decision-log convention

Emit `> Decision: ...` notes for: TDD-ordering verdict (and the commit log evidence), tier-shape match per testing-plan.md, isolation review summary, any tautology hits. Be explicit when a static check is a complement to fix-bot's runtime check (e.g., "static tautology smell at line 42 — fix-bot reviewer's runtime check is the authoritative verdict").
