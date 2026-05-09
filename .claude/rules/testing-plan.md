---
paths:
  - "**/*.test.ts"
  - "tests/e2e/**"
  - "packages/gazetta/tests/**"
  - "apps/admin/tests/**"
---

# Testing Plan

Active testing rules + forward-looking gap list. The 2026-04 plan that built the
infrastructure (Vue component tests, sidecars units, fast-check PBT, fault
injection, axe-core e2e, mutation testing nightly, contract tests, e2e POMs +
matrix + scenarios) shipped — burndown detail recoverable from
[git log on `.claude/rules/testing-plan.md`](https://github.com/gazetta-studio/gazetta-studio/commits/main/.claude/rules/testing-plan.md).

## Shape per sub-system

Gazetta is four sub-systems with different test-distribution shapes. Each is
already in the codebase; this section names what's there.

| Sub-system | Shape | Layout |
|---|---|---|
| Core (`packages/gazetta/src/`) | Classic pyramid (heavy unit) | `packages/gazetta/tests/*.test.ts` — pure-compute logic with real invariants |
| Storage providers | Honeycomb (heavy integration) | `apps/admin/tests/docker.test.ts` via testcontainers (MinIO + Azurite) |
| Admin SPA | Trophy (component + scenario) | `apps/admin/tests/*.test.ts` (jsdom + Vue Test Utils + `createTestingPinia`) + `tests/e2e/` |
| CLI | Crab (heavy scenario) | exercised through e2e + integration via `gazetta validate`, `gazetta archive`, `gazetta assets` |

The shape is not the right axis to optimise. AI-era discipline is.

## Storage tier

API tests use [`memoryStorage()`](../../packages/gazetta/tests/_helpers/memory-storage.ts)
by default — a fresh in-memory `StorageProvider` per test, seeded via
`seed({...})`. Memory eliminates a class of structural flake (shared
`tempDir` state, cleanup races, watcher pickup of stale data) and keeps
test setup ~10ms vs ~100ms for `cp -r examples/starter`.

Memory does NOT fix all flakes — async-ordering bugs and millisecond-collision
races (e.g. audit event timestamps) are storage-tier-agnostic; sort by
deterministic key.

**Use fs (`createFilesystemProvider` + `tempDir`) when:**

- The test exercises a **transform-adapter pipeline or on-disk variant
  generation** — uploads that re-encode bytes, sharp variant ladders writing
  derived `_400w.jpg` files, content-hash filename generation from real
  bytes (today: [`admin-api-assets.test.ts`](../../packages/gazetta/tests/admin-api-assets.test.ts))
- The test **asserts on hash-in-path filename construction**
- The SUT is the **file watcher / SSE-reload path**
- The test is a **starter smoke** — exactly one per surface, loads
  `examples/starter` and walks it through routes (today:
  [`admin-api.test.ts`](../../packages/gazetta/tests/admin-api.test.ts))

Anything else — memory, including **routes that just read pre-seeded bytes**
(memory's `writeBytes()` / `seedBytes()` cover this; no fs needed). Reference
example: [`admin-api-suggest-alt.test.ts`](../../packages/gazetta/tests/admin-api-suggest-alt.test.ts)
seeds a JPEG and exercises the asset route end-to-end without disk I/O. Storage providers' wire-level correctness (case
sensitivity, atomic writes, range requests) is covered separately by
[`docker.test.ts`](../../apps/admin/tests/docker.test.ts) testcontainers
conformance — don't reproduce there.

## AI-era disciplines

Three layers ride on top of whatever shape the sub-system uses. Each catches a
class of failure that AI-assisted development is structurally prone to.

| Discipline | Catches | Where it lives |
|---|---|---|
| **TDD ordering** (test commit before impl commit) | Tautological tests written after observing output | [`team-preferences.md` rule 31](team-preferences.md) + the [`tdd` skill](~/.claude/skills/tdd/) |
| **Mutation testing** (StrykerJS, nightly) | Tests that pass without asserting anything meaningful | [`packages/gazetta/stryker.config.json`](../../packages/gazetta/stryker.config.json) + [`.github/workflows/mutation.yml`](../../.github/workflows/mutation.yml) |
| **Property-based testing** (fast-check) | Boundary / Unicode / encoding edge cases AI's "safe middle" inputs miss | `packages/gazetta/tests/hash-sidecar-names.test.ts` is the reference example |

**Mutation scope expansion (next):** StrykerJS today only mutates `hash.ts`
(70% baseline, found one real survived mutant). Expand to AI-heavy modules
where tautological tests are most likely. **Smallest-first** so the workflow
calibrates (mutants-per-module, triage time, artifact retention) on a
focused surface before tackling the largest:

1. `packages/gazetta/src/hooks/registry.ts` — priority dispatch, error taxonomy. Smallest module; pure logic.
2. `packages/gazetta/src/archive/` — helpers, aliases. Recent feature, all cuts AI-paired; focused surface.
3. `packages/gazetta/src/audit/` — recorder dispatcher. Cross-cutting; medium surface.
4. `packages/gazetta/src/validation/` — validators, scanner, save-delta. Largest surface; tackle once triage workflow is proven.

Each lands as a separate `stryker.config.json` `mutate` glob extension, not a
batch — survived mutants from one module need triage before adding the next.

Don't gate on score yet — observational metric until each module's baseline
stabilises. Treat survived mutants as test-quality bugs.

**Property-test scope expansion (next):** `fast-check` is installed and used
in 1 file. Targets where round-trip / fallback chain semantics matter:
- `archive/` filename codec round-trip (alias-targets sidecar names)
- Locale fallback chain (any locale + theme tuple → resolved chain order)
- Redirect chain construction (cycles, depth limits, archived-source semantics)
- Sidecar reference-name encoding (kind disambiguation across hash/uses/tpl/asset-refs/fragment-deps/alias-targets)

Each is a 30-line addition. Land one per relevant feature cut, not as a batch.

## Cross-foundation integration test punch list

Foundational dimensions shipped in cuts (hooks, audit, validation, soft-delete,
media v1, ai-alt). Each has feature-internal tests; what's missing is **integration
across foundations**. Concrete gaps, ranked by blast radius:

| # | Interaction | Why it's load-bearing | Status |
|---|---|---|---|
| 1 | `beforeSave` hook **throws** → save returns 4xx AND audit records `save-cancelled-by-hook` event with the failure reason | Hook cancellation is the documented failure path per `design-hooks.md`; if audit drops the cancelled save, forensic trail has a hole | ☐ |
| 2 | History restore of an archived page → preserves archive marker, alias, and `archivedAt` fields | Restore writes manifest back to content tree; if archive fields are dropped by the restorer's whitelist, restored "live" pages still serve archived markers (or vice versa) | ✓ — [`history-restorer.test.ts`](../../packages/gazetta/tests/history-restorer.test.ts) covers alias variant + pure soft-delete (no `aliasOf`) round-trips. Contract: restorer copies blob bytes verbatim; no whitelist. Tests serve as regression guards against a future refactor that would introduce one. |
| 3 | Capability-gap UX surfaces at all four points (boot warning / author modal / scanner / publish-gate) for one feature end-to-end | Per `feature-design-process.md` non-foundational disciplines, four-point surfacing is the contract; today each point is tested feature-by-feature, never as a single chain | ☐ |
| 4 | AI alt-text refusal → audit log records the refusal with provider name + reason | Refusals are structured per `design-ai.md`; if they don't audit-record, "why didn't this image get alt?" is unanswerable forensically | ☐ |
| 5 | Hook factory contribution from a plugin → hook fires with correct site config + `auditEmit` wired | Cut 9 of hooks shipped factory contributions; integration with audit at the plugin boundary isn't directly tested | ☐ |
| 6 | Archived page → validation scanner re-runs and clears prior `referenced-archived-without-alias` issues from the page itself (not from items referencing it) | Scanner cache invalidation on archive transitions is implicit; no test pins the contract | ☐ |
| 7 | Publish to a target with `editable: false` from a hook-modified manifest → publish observes the hook-modified payload, not the pre-hook version | Hook-as-payload-transformer per `design-hooks.md`'s return-new-payload contract; publish path needs explicit coverage | ☐ |

Write each as one route-level integration test in `packages/gazetta/tests/`,
named `cross-{foundation-a}-{foundation-b}.test.ts`. Land alongside the next
feature cut that touches the foundation in question — not as a backlog batch.

## Single-route coverage gaps

Routes whose **logic** is tested via direct function calls but whose
**HTTP handler** (status code mapping, content-type, schema validation,
middleware ordering) has no `app.request()` test. Inventory as of 2026-05:

| Route | Logic tested via | Gap |
|---|---|---|
| `GET /api/compare` | `compareTargets()` direct call ([compare.test.ts](../../packages/gazetta/tests/compare.test.ts)) | Route handler — target-name lookup + serialization |
| `POST /api/fetch` | Schema only ([api-contract.test.ts](../../apps/admin/tests/api-contract.test.ts)) | Behavior test |
| `POST /api/publish/stream` | Schema only | SSE stream contract; main publish flow |
| `GET /api/templates/:name/impact` | `validation-template-impact.test.ts` | Route handler |
| `GET /api/validation/issues` | Mentioned in `admin-api.test.ts` but no `app.request()` | Route handler |

Same policy as the cross-foundation punch list: write the test alongside
the next feature cut that touches the route. Don't backfill as a batch
([team-preferences rule 17](team-preferences.md)).

The pattern this avoids: testing the underlying helper while leaving the
route handler — itself an SUT with its own concerns (404 vs 400 vs 500
status mapping, JSON serialization, principal middleware, audit emission)
— uncovered. Per [rule 31's tier-default](team-preferences.md), trophy /
honeycomb sub-systems default to API-first; new admin-API behavior gets
the route-level test, not the helper-level test.

## E2e + matrix + scenarios — current state

Layout is flat under `tests/e2e/` (12 feature spec files), with subdirectories
for `pages/` (POMs), `scenarios/` (cross-surface integration), and `matrix/`
(env × editable × type parameterized). Worker-scoped temp-site fixture per
[team-preferences rule 10](team-preferences.md).

POMs landed: `PublishPanel`, `SiteTree`, `ComponentTree`. Add a POM with its
first consumer (avoid dead-code POMs), not in advance.

Scenarios landed: `edit-publish-sync`, `fan-out-publish`, `rollback-sync`,
`publish-with-assets`, `archive-rename`. New scenarios target cross-surface
integration gaps; the catalogue lives implicitly in the file names.

Deferred — **hotfix source=prod → local** scenario. Requires `editable: true`
on production; dev-server target-registry doesn't reload on `site.config.ts`
change. Two paths: (a) separate Playwright project with pre-patched config,
(b) fix dev-server to reload registry. Either is infrastructure work.

## Explicit non-goals

| Skip | Why |
|---|---|
| Visual regression (Percy / Chromatic / `toHaveScreenshot`) | Per [`css-theming.md`](css-theming.md): per-platform baseline friction, semantic regressions missed. Reintroduction criteria not met. |
| Vitest Browser Mode | Vue Test Utils + jsdom is sufficient; real-browser fidelity comes from Playwright e2e |
| BDD / Cucumber / playwright-bdd | Split between feature files + step defs hurts maintenance; plain Playwright reads fine for solo dev |
| Pact contract testing | Single consumer, single producer — Zod schemas already cover via [`api-contract.test.ts`](../../apps/admin/tests/api-contract.test.ts) |
| Type-level tests (`tsd`, `expect-type`) | Apps not libraries; consumers are in-tree; TS strict already gates |
| 5K-page envelope CI gating | Separate decision (scale-CI), not testing-strategy. Synthetic-site benchmarks per `design-scale.md` Cut 1 belong in their own workflow |
| Vitest `bench` | Experimental, no SemVer guarantee — adopt only with specific perf motivation |
| Named workflow profiles | Rejected by [`design-decisions.md`](design-decisions.md) #15 |

## Deferred branches

Branches surfaced during the 2026-05 testing-strategy grill but not walked.
Captured here so future-me / a future grill doesn't re-derive the same
questions. Each has a **revisit trigger** — the observable signal that would
promote it from deferred to active.

| Branch | Question | Revisit trigger |
|---|---|---|
| **C. Test-fixture seed library** | Should `_helpers/fixtures.ts` ship named seeds (`seedHomePage()`, `seedFragmentTree()`) to cut per-test JSON boilerplate? | When 3+ admin-API tests independently re-implement the same seed shape AND a change to that shape forces parallel edits. Risk: fixture coupling — one shared fixture, change-once-break-all. |
| **D. Property-based tests at the API tier** | Beyond pure-logic PBT, can `fast-check` drive random-but-valid manifest payloads through `app.request()` to assert audit / sidecar invariants always hold? | When a cross-foundation punch list item ships and the invariant is naturally PBT-shaped (e.g., "every save emits exactly one audit event regardless of payload shape"). Most invariants will be example-tested first; PBT lifts when the surface is clearly invariant-rich. |
| **E. AI-agent prompt template for API tests** | Should rule 31 (TDD ordering) carry a captured prompt template ("Write a Hono `app.request()` test that...") to reduce per-PR prompt drift? | When 3+ PRs in a row produce API tests with structurally different shape (e.g., one uses `setupApp()`, another inlines, a third forgets the principal middleware). Today's tests are structurally consistent; no drift observed. |
| **G. Cross-foundation punch list ordering** | The 7 items are ranked "by blast radius" — should they instead be ordered by "likelihood of being touched by next feature cut"? | When 2+ items have shipped via "land alongside next feature cut" policy, retrospect on whether blast-radius order matched the actual order. If not, switch to feature-cut-likelihood. |
| **H. E2e scenario coverage audit** | Are there cross-surface gaps the existing 5 scenarios miss? Specifically: archive × publish × audit chain (3 foundations); offline-replay × conflict (when `design-offline.md` ships); collaboration comments × audit (when `design-collaboration.md` ships). | When a new design pass crosses ≥3 surfaces (offline, collaboration, scheduling). Audit at design-time, not retrospectively. |

These are not committed work. Promotion to the body of this doc requires the
revisit trigger to fire AND the branch to survive a grill on whether it earns
its keep at that point.

## Sources

- [Anthropic — Property-Based Testing with Claude (2026)](https://red.anthropic.com/2026/property-based-testing/)
- [ThoughtWorks Radar — AI-aided test-first development (Vol 34)](https://www.thoughtworks.com/en-us/radar/techniques/ai-aided-test-first-development)
- [Simon Willison — Code proven to work (2025)](https://simonwillison.net/2025/Dec/18/code-proven-to-work/)
- [Kent C. Dodds — Testing Trophy (2018)](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications)
- [Spotify — Testing of Microservices (Honeycomb, 2018)](https://engineering.atspotify.com/2018/01/testing-of-microservices)
- [fast-check](https://fast-check.dev/) · [StrykerJS](https://stryker-mutator.io/) · [axe-core](https://www.deque.com/axe/)
- [Playwright POM](https://playwright.dev/docs/pom) · [testcontainers](https://testcontainers.com/)
