# Test quality with AI agents

Per [`testing-plan.md`](../../.claude/rules/testing-plan.md) "Test-quality-with-AI research" scope. Measurement-first audit of how the existing admin-API test suite holds up under mutation testing — the load-bearing concern is rule 31's failure mode (AI agents weaken assertions to make red turn green) and whether the suite catches it.

**Status**: cycle 1 complete (suggest-alt + assets.ts surface, 2026-05-10).

**Methodology** (per `testing-plan.md` Q3 lock): StrykerJS mutation testing as the discovery tool. Survived mutants triaged into named patterns; patterns inform rules + tooling changes. Cycle 1 surface: `assets.ts` (which contains the suggest-alt route handler — `suggest-alt.ts` doesn't exist as a separate file).

## Cycle 1 — `assets.ts` results

Source: nightly mutation run [#25621614362](https://github.com/gazetta-studio/gazetta-studio/actions/runs/25621614362) (2026-05-10 06:16 UTC).

Whole admin-api scope: **988 killed / 720 survived / 788 no-coverage / 39.63% mutation score**. Aggregate masks per-file shape; the file-level numbers are the diagnostic input.

| File | Score | Killed | Survived | NoCov | Total |
|---|---:|---:|---:|---:|---:|
| `routes/assets.ts` (607 LOC) | **54.89%** | 129 | 77 | 168 | 374 |

77 covered-but-survived mutants is the "tests run, asserts pass, mutation undetected" failure mode rule 31 names. Three named patterns emerged from triage.

### Pattern 1 — Error-shape tautology

**The pattern.** Tests assert HTTP status code only; never assert on the response body's `code` / `message` shape. StrykerJS mutates `code: 'BAD_REQUEST'` → `code: ''` and `message: 'Invalid JSON body'` → `message: ''`; tests stay green.

**Concrete survived mutants:**

```ts
// assets.ts:61 — locale-bytes BAD_REQUEST response
- return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: `Invalid locale code: ${locale}` }), {
+ return new Response(JSON.stringify({ code: '', message: `Invalid locale code: ${locale}` }), {  // SURVIVED

// assets.ts:152 — invalid-JSON BAD_REQUEST response
- return c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400)
+ return c.json({}, 400)  // SURVIVED
```

**Why this is rule 31's failure mode.** The test was written by reading the route, observing it returns 400 with a `code` field, and asserting `expect(res.status).toBe(400)`. The assertion is true for any 400 response — *including the implementation that ships an empty body*. A future agent rewriting the route to return `{ }` with status 400 would not be caught. The error contract is unprotected.

**The fix** is structural: assert against the schema, not the observed shape. Existing schemas live in [`packages/gazetta/src/admin-api/schemas/assets.ts`](../../packages/gazetta/src/admin-api/schemas/assets.ts); error responses follow the shape `{ code: ErrorCode, message: string }` — but no schema currently captures the error shape itself, so tests have nothing to validate against.

### Pattern 2 — Branch-existence-only coverage

**The pattern.** Tests exercise *one* branch of a parallel construct, miss the others. StrykerJS mutates the missing branch's condition; survives because no test exercises that path.

**Concrete survived mutant:**

```ts
// assets.ts:66 — theme validation
- if (theme !== undefined && !isValidTheme(theme)) {
+ if (false) {  // SURVIVED — [NoCoverage]
    return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: `Invalid theme code: ${theme}` }), {...})
  }
```

The locale-equivalent (line 60: `isValidLocale`) IS tested by [`admin-api-suggest-alt.test.ts`](../../packages/gazetta/tests/admin-api-suggest-alt.test.ts) `'400s on invalid locale code'`. The theme-equivalent isn't. Both validators run on the same locale-bytes route; selector validation is parallel; the theme branch was never written into a test.

**Why this is the failure mode.** AI agents (and humans) test the path they observed. When the implementation has parallel branches (locale OR theme; valid OR invalid; present OR absent), only the path the test author traced through manually gets covered. The other branch lives in a coverage shadow.

**The fix** is structural: when a route exposes multiple validated query parameters, generate one test per parameter × valid/invalid combination. Property-based testing (per `testing-plan.md` "Property-test scope expansion") is the natural shape for this — `fast-check` can generate (locale, theme) tuples and assert correct 400-or-200 dispatch.

### Pattern 3 — Resource-key string mutation

**The pattern.** Tests don't catch when the implementation reads the wrong resource key. StrykerJS mutates `c.req.query('target')` → `c.req.query("")`; tests pass because the test fixture happens to make both calls succeed.

**Concrete survived mutants:**

```ts
// assets.ts:86, 102, 146 — three identical instances
- const source = await resolve(c.req.query('target'))
+ const source = await resolve(c.req.query(""))  // SURVIVED
```

`c.req.query("")` returns `undefined` rather than the target name; `resolve(undefined)` falls back to the default target. Test fixtures use a single-target setup, so the default target is the right answer — tests pass either way. Real production deployments with multiple targets would silently route to the wrong one.

**Why this is dangerous.** Three sites in this file and presumably more across the admin-API consume `c.req.query('target')` via the same idiom; a refactor that drops the literal would be silently incorrect on every multi-target deployment. The test surface is structurally too narrow to catch it.

**The fix** is fixture diversity: tests that exercise multi-target routing must have at least two configured targets and assert the request reached the *named* target, not just any target. The existing single-target test pattern in `admin-api-suggest-alt.test.ts` is structurally insufficient for routes that resolve targets.

## Patterns recap + generalization

| Pattern | Failure mode | Detection cost | Fix shape |
|---|---|---|---|
| 1 — Error-shape tautology | Status-only assertions; body shape unprotected | Mutation testing on error-response sites | Assert against shared error-response schema |
| 2 — Branch-existence-only coverage | Tests exercise observed path; parallel branches untested | NoCoverage mutants on parallel constructs | Property-based test per parameter × valid/invalid |
| 3 — Resource-key string mutation | Single-target fixtures mask multi-target bugs | Mutation testing on `c.req.query/param/header` sites | Multi-target test fixtures + named-target assertions |

All three are AI-agent-prone. Rule 31 names the diagnosis (TDD ordering); these are the *symptoms* of suites that didn't follow it.

## Recommendations

1. **Ship a shared error-response Zod schema** (`packages/gazetta/src/admin-api/schemas/error.ts`) and assert against it from every admin-API test that hits an error path. Cuts pattern 1 across all admin-api routes, not just `assets.ts`. This is the highest-leverage finding.

2. **Add property-based tests for multi-parameter validation routes.** Per `testing-plan.md`'s deferred property-test scope expansion: locale × theme tuples is the natural target. Cuts pattern 2; aligns with Anthropic's PBT-with-AI guidance.

3. **Multi-target test fixture as the default for admin-api tests.** Today's `buildApp(siteManifest?)` helper in `admin-api-suggest-alt.test.ts` defaults to one target; switch to two so target-resolution mutations stop silently passing. Cuts pattern 3.

4. **Mutation score gating on `assets.ts` after fixes.** Stryker's `thresholds.break` is currently `0` (observational); with patterns 1-3 fixed, set `break: 50` for `assets.ts` to lock in the gain. Don't gate the whole admin-api yet — the cycle 1 work is one file's worth of evidence.

## A→C synthesis (with rule updates)

Rule candidates from this cycle, in order of leverage:

- **Rule 34 (proposed)**: "When asserting against an HTTP route's error response, assert on the schema-defined body shape, not just the status code. Status-only assertions are tautological — they pass for any implementation returning that status, including degraded ones." Composes with rule 31 (TDD ordering) and rule 32 (read-all-failures). Lands when the shared error-response schema (recommendation 1) ships.

- **Rule extension to rule 26 (test-isolation paranoia)**: extend with "fixture diversity for routes that resolve resources by name." Single-resource fixtures hide whole classes of mutation. Lands inline at rule 26 when a sibling lesson surfaces.

Property-based testing patterns from this cycle (generate locale × theme tuples) become a `testing-plan.md` "Property-test scope expansion" entry rather than a rule — they're tactical guidance, not principle.

## What this cycle does NOT cover

- **`alt/route-handler.ts`**: the suggest-alt orchestration logic lives here, NOT in `assets.ts`. It's currently OUTSIDE the Stryker `mutate` glob (`src/admin-api/**/*.ts` only). Adding it is the natural next cycle's work — and it's where the gap-#4 tautology actually lived (audit recording added in `assets.ts`'s route, but the `provider` field comes from `route-handler.ts`).
- **Tautology-vs-equivalent-mutant triage**: a small fraction of survived mutants in `assets.ts` are likely equivalent (e.g., `c.req.query('target') → c.req.query("")` IS detectable but only via multi-target fixtures, not equivalent — confirmed). A full triage pass would document each. Cycle 1 captured patterns; equivalent-mutant accounting is overkill at this stage.
- **Other admin-api routes**: 720 total survived mutants across the admin-api scope; this cycle inspected ~10 concrete examples in one file. The patterns generalize, but per-route triage waits for cycles 2+ (`archive.ts`, `publish.ts`, etc. per `testing-plan.md`'s admin-API track).

## Next cycles

Per `testing-plan.md`'s admin-API track:

- **Cycle 2** — `archive.ts`. Recent feature, AI-paired cuts; expect concentrated patterns 1-3.
- **Cycle 3** — `publish.ts`. Highest blast radius; longest file (~1000 LOC); expect noise at scale.
- **Cycle 4+** — remaining routes on demand.
- **Adjacent surface** — extend Stryker glob to `src/alt/route-handler.ts` (and similar peer files outside `admin-api/routes/`) to close the gap this cycle identified.

Each cycle produces an addendum to this audit doc in the same shape: file, score, named patterns, recommendations.

## External-source framing (post-measurement)

References that frame the patterns above:

- [Anthropic — Property-Based Testing with Claude (2026)](https://red.anthropic.com/2026/property-based-testing/) — argues PBT is the highest-leverage mitigation for AI-generated test tautology. Pattern 2's branch-existence gap is the canonical example.
- [ThoughtWorks Technology Radar Vol 34 — AI-aided test-first development](https://www.thoughtworks.com/en-us/radar/techniques/ai-aided-test-first-development) — establishes TDD ordering as the discipline; rule 31 is the in-tree codification.
- [Simon Willison — Code proven to work (2025)](https://simonwillison.net/2025/Dec/18/code-proven-to-work/) — argues mutation-test-validated test suites are the credibility standard for AI-generated code.

The patterns above were discovered via measurement; the external sources frame *why* the patterns are AI-prone, not what they are. Measurement-first per `testing-plan.md` Q6 lock — the audit doc led with findings; framing follows.
