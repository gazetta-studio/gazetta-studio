---
paths:
  - "**/*.test.ts"
  - "tests/e2e/**"
  - "packages/gazetta/tests/**"
  - "apps/admin/tests/**"
---

# Testing Plan

Active plan for expanding test coverage and restructuring e2e. Synthesised from a
codebase audit (2026-04-16).

**Status legend:** ☐ todo · ◐ in progress · ✓ done

When a task is actively being worked, link a GitHub issue: `☐ [#123] task`.
When the whole plan is complete, change frontmatter `paths:` to
`NEVER_MATCH_AUTO_LOAD` to archive (follow [implementation-plan.md](./implementation-plan.md) pattern).

---

## Part 1 — Coverage gaps

### Priority 1 — real, high-value

#### ✓ 1.1 Vue component tests for admin SFCs

Landed across all four target SFCs — 51 tests total via `@vue/test-utils` +
`createTestingPinia({ stubActions: false })`:

- [PublishPanel.test.ts](../../apps/admin/tests/PublishPanel.test.ts) — 15 tests.
  Picker wiring to `targetsStore`, source/destination selection, prod-confirmation
  gating on `environment: production`, read-only source disables publish, per-target
  progress rendering, invalid-template block banner.
- [ActiveTargetIndicator.test.ts](../../apps/admin/tests/ActiveTargetIndicator.test.ts)
  — 16 tests. Env-chrome class per `environment` value, read-only badge when
  `editable: false`, unsaved-guard integration when switching active target.
- [ComponentTree.test.ts](../../apps/admin/tests/ComponentTree.test.ts) — 8 tests.
  Add/remove mechanics, fragment-reference rendering, drag-reorder store calls.
- [SyncIndicators.test.ts](../../apps/admin/tests/SyncIndicators.test.ts) — 12 tests.
  "N behind/ahead" framing relative to active target, group collapse at 4+ peers.

All four run under the admin workspace's existing Vitest config (jsdom). No extra
test infra needed.

---

#### ✓ 1.2 Direct unit tests for sidecars.ts

Landed in [sidecars.test.ts](../../packages/gazetta/tests/sidecars.test.ts) — 20 tests
covering `readSidecars` (null on missing dir, full state with all three sidecar kinds,
ignores unrelated files, decodes subfolder-qualified names), `writeSidecars`
(idempotence, stale-sidecar cleanup, leaves non-sidecar files alone), `listSidecars`
(empty dir, recursion, skips sidecar-less subdirs), and `collectFragmentRefs`
(recursion + deduplication). In-memory `Map<string, string>`-backed StorageProvider.

---

#### ✓ 1.3 Property-based tests for hash.ts helpers

Landed in [hash-sidecar-names.test.ts](../../packages/gazetta/tests/hash-sidecar-names.test.ts) —
13 tests covering encode/decode round-trip, each sidecar-name codec round-trip, and
kind-disambiguation (hash/uses/tpl regexes never collide). PBT via `fast-check`.

**Real bug caught:** the original `/` ↔ `__` codec wasn't invertible against arbitrary
inputs — `_` is a legal character in reference names (per team preferences: "underscore
is a standard way to space in names"), so names like `"_/ "` encoded to `___` and
decoded back lossy. Fixed by switching the separator to `/` ↔ `.` (dot is already
off-limits in reference names per operations.md's character table, `_` stays valid)
and rejecting `.` at encode time with a clear error. PBT via `fast-check` catches any
future regression of the round-trip.

**Skipped:** `hashManifest` key-order invariance — already example-tested at
[hash.test.ts:55-68](../../packages/gazetta/tests/hash.test.ts#L55-L68).

---

#### ✓ 1.4 Fault-injection tests for history + publish

Landed in [history-fault-injection.test.ts](../../packages/gazetta/tests/history-fault-injection.test.ts)
— 6 tests using a `StorageProvider` decorator that fails the Nth call with a
configurable error. Covers mid-write crashes during index update, object-blob write,
revision-manifest write; concurrent saves racing to append; retention eviction
atomicity under partial delete failure. Assertions enforce: index and
`objects/`/`revisions/` never diverge, no two revisions share a `rev-<ts>` id
under contention, eviction rolls back on blob-GC failure so revisions remain
restorable.

`publish.ts` / `publish-rendered.ts` share the history pipeline via the same
`history-recorder.ts` code path, so their failure semantics are covered
transitively by the recorder tests (verified by call-graph: both enter history
exclusively through `recordRevision`).

---

### Priority 2 — good value, lower urgency

#### ✓ 2.1 Storage provider conformance parity

Shared `runProviderConformance(factory)` battery extracted to
[apps/admin/tests/_helpers/provider-conformance.ts](../../apps/admin/tests/_helpers/provider-conformance.ts)
— 8 direct CRUD tests covering read/write, exists (file + dir prefix), readDir
(file vs subdir), missing-file error, single-file rm, recursive dir rm, and
idempotent mkdir. Integration in [docker.test.ts](../../apps/admin/tests/docker.test.ts)
runs the battery against both S3 (MinIO) and Azure (Azurite), closing the
**Azure had no direct CRUD tests** gap. Providers opt in by calling
`runProviderConformance({ name, make(namespace) })` from their describe block.

R2 stays covered transitively through the MinIO factory (same
`createS3Provider` code path).

**Cleanup:** still open — `@testcontainers/azurite` in
[apps/admin/package.json](../../apps/admin/package.json) is unused (Azurite is
run via the `testcontainers` `DockerComposeEnvironment`, not the dedicated
module). Tracked in the cleanup section below.

---

#### ✓ 2.2 Documented-behavior tests from operations.md

Audited the "testable claims" list against the source. Three of six were
**aspirational entries in operations.md** — documented as current but unimplemented.
Those have been corrected in operations.md rather than tested. Landed tests for the
three real claims:

**Tested (real):**
- Circular fragment reference detection — [resolver.test.ts](../../packages/gazetta/tests/resolver.test.ts)
  added 4 tests: self-reference, 2-hop cycle, 3-hop cycle, diamond-without-cycle (no false positive)
- Keyboard shortcut `Ctrl/Cmd+S` saves — [editor.test.ts](../../tests/e2e/editor.test.ts)
  added 3 e2e tests: Control+S, Meta+S, clean-form no-op
- Keyboard shortcut `Ctrl/Cmd+Z` undo / `Shift+Z` redo — added e2e tests against
  the default `@rjsf` form editor (implementation lives at
  [packages/gazetta/src/editor/mount.tsx](../../packages/gazetta/src/editor/mount.tsx)
  lines 869-914, scoped to field-level edit history with a 50-entry stack)
- `Escape` closes dialogs — already covered by the existing `Escape key behavior`
  describe block in editor.test.ts
- Explicit `environment: production` confirmation — already covered by
  [PublishPanel.test.ts](../../apps/admin/tests/PublishPanel.test.ts) (PR #151)

**Corrected in operations.md (not implemented — documentation was aspirational):**
- Render timeouts (10s dev / 30s publish) — marked as future work; today a hung
  template hangs the process
- 20-level nesting-depth warning — marked as future `gazetta validate` work
- Connectivity precheck before publish — marked as future; today failures surface
  through the underlying SDK error when the first write or list fails

---

#### ✓ 2.3 Accessibility scans in e2e

Landed via `@axe-core/playwright` in [tests/e2e/a11y.test.ts](../../tests/e2e/a11y.test.ts).
Four surfaces scanned (site tree, editor view, Publish panel, active-target switcher).
Preview iframe excluded from the scan — it renders the user's site (not Gazetta's
admin chrome), so its WCAG status is the site author's concern.

**BASELINE allowlist pattern:** known violations tracked in the test file's `BASELINE`
array — each entry names a rule id + the reason it's deferred. New violations not in the
allowlist fail CI; fixes remove entries. **The array is now empty.**

**BASELINE burndown (complete, 2026-04-17):**

| Rule id | Resolution |
|---------|------------|
| `button-name` | #174 — Added `title` + `aria-label` to icon-only Buttons in CmsToolbar (back-to-browse, theme-toggle), SiteTree (delete-{page,fragment}-{name}), and ComponentTree (move-up / move-down / remove). Toolbar buttons get `title` (doubles as tooltip); row-scoped buttons get `aria-label` only. |
| `frame-title` | #175 — `previewTitle` computed bound to PreviewPanel.vue's `<iframe>` — composes route + active-target name (e.g. "Preview of /home on staging"). |
| `nested-interactive` + `label` | #176 — One DOM fix resolved both: PublishPanel's destination-group-header `<button>` containing a Checkbox `<input>` became a `<label for="dest-group-{env}">`. Native HTML semantics — label click toggles the input via `@update:modelValue` → `toggleGroup()`. |
| `color-contrast` | #180 — Three distinct root causes, all producing axe contrast failures in dark mode: (a) SiteTree's hardcoded grays + broken `:global(.dark)` overrides (specificity loss to scoped `[data-v]` per [team-preferences.md](./team-preferences.md) rule 12) — switched to `--color-*` tokens that auto-flip via PrimeVue's semantic layer; (b) SyncIndicators' `state-loading` / `.group-count` / `.sync-chip-member` opacities dragging contrast under WCAG AA — replaced with non-opacity hierarchy (italic status, font-weight differences, `↳ ` prefix); (c) DevPlayground's unscoped `.dark .X` rules leaking to other components — anchored each under `.playground` to scope cross-component pollution. |

**Skipped:** Vitest-level a11y via `@chialab/vitest-axe` — e2e coverage is sufficient.

---

### Priority 3 — optional

#### ✓ 3.1 Mutation testing (nightly, not per-commit)

Landed via StrykerJS v9.6.1 + `@stryker-mutator/vitest-runner` + `@stryker-mutator/typescript-checker`.

**Scope:** `packages/gazetta/src/{history-*,admin-api/**,publish*}` — see
[stryker.config.json](../../packages/gazetta/stryker.config.json).

**Config:**
- `inPlace: true` — tests reference `../../examples/starter` and other cross-workspace
  paths; Stryker's default sandbox orphans those. In-place mode mutates the real files
  and restores them from `.stryker-tmp/` on exit.
- `thresholds.break: 0` — no enforcement yet. Baseline needs to stabilise first.
- `reporters`: html + clear-text + progress

**Nightly workflow:** [.github/workflows/mutation.yml](../../.github/workflows/mutation.yml)
runs at 03:00 UTC on `schedule` + `workflow_dispatch` (for branch runs). `continue-on-error`
means mutation results are signal, not gate. Report uploaded as artifact (30-day retention).

**Smoke baseline:** `hash.ts` alone scored **70.27%** in the initial run — surfaced one
real survived mutant (removing `.sort()` on [hash.ts:111](../../packages/gazetta/src/hash.ts#L111)
went undetected by existing example tests). Worth investigating in a follow-up.

**Runtime:** ~7 min for `hash.ts` alone (65 mutants). Full target set likely hours —
this is nightly-only for a reason. When raising `thresholds.break`, do it gradually:
60 → 70 → 80 as real coverage gaps get fixed.

---

#### ✓ 3.2 Contract tests via shared Zod schemas

Landed across five PRs (#151, #168, #169, #170, #171) — 11 admin
endpoints now share Zod schemas as the single source of truth for
request/response shapes. 56 contract tests in
[apps/admin/tests/api-contract.test.ts](../../apps/admin/tests/api-contract.test.ts).

**Covered endpoints** (server validates with `safeParse`, client
derives types via `z.infer`):

| Endpoint | Shapes |
|---|---|
| `POST /api/pages` + list | CreatePageRequest, CreatePageResponse, PageSummary |
| `POST /api/fragments` + list | CreateFragmentRequest, CreateFragmentResponse, FragmentSummary |
| `GET /api/templates` | TemplateSummary |
| `GET /api/fields` | FieldSummary |
| `GET /api/targets` | TargetInfo + TargetEnvironment / TargetType (z.enum) |
| `GET /api/site` | SiteManifest (loose so empty-target fallback passes) |
| `GET /api/dependents` | DependentsResponse |
| `GET /api/compare` | CompareResult + InvalidTemplate |
| `POST /api/publish` + `/publish/stream` | PublishResult + PublishProgress (z.discriminatedUnion, 6 variants) |
| `GET /api/history` + `POST /api/history/{undo,restore}` | RevisionSummary, ListHistoryResponse, RestoreRevisionResponse |
| `POST /api/fetch` | FetchResponse |

**Pattern established:**
- Schemas live under `src/admin-api/schemas/{endpoint}.ts`
- Re-exported from `schemas/index.ts` (barrel)
- Subpath export `gazetta/admin-api/schemas` keeps Hono + storage
  providers off the client's type graph
- Client drops local interface/type declarations; derives all via
  `z.infer`

**Drift caught while landing:**
- `createPage` body type was `{ name, template }` but the server
  already accepted an optional `content` field — the schema made this
  visible and the migration widened the client type
- `PublishProgress` 6-variant union moved from hand-maintained TS
  union to `z.discriminatedUnion` — kind-mismatch rejection now has
  test coverage where before drift would bite silently

**Remaining (deferred, not blocking):**
- `GET /api/preview` — JSON configured-preview-data lookup; not used
  by the admin SPA
- `GET /api/templates/:name/schema` — spreads an arbitrary JSON
  Schema with sibling `hasEditor` / `editorUrl` / `fieldsBaseUrl`
  fields. Migration is blocked on reshaping the wire format into a
  proper `{ jsonSchema, ... }` envelope — a separate refactor.

**Skip:** Pact — overkill for single consumer/provider.

---

## Part 2 — E2E structure

### Current state (measured)

| File | Lines | Tests | Describes |
|------|-------|-------|-----------|
| [editor.test.ts](../../tests/e2e/editor.test.ts) | 1,134 | 59 | 26 |
| [production.test.ts](../../tests/e2e/production.test.ts) | 29 | 3 | — |
| [production-static.test.ts](../../tests/e2e/production-static.test.ts) | 17 | 2 | — |
| [production-esi.test.ts](../../tests/e2e/production-esi.test.ts) | 36 | 4 | — |
| [fixtures.ts](../../tests/e2e/fixtures.ts) | 176 | — | — |

**Problem:** editor.test.ts mixes 26 unrelated describes. The Publish panel block alone is
245 lines (largest cohesive block).

**What works — keep unchanged:**
- Worker-scoped temp site copy (team-preferences rule #10)
- Console-error guard with opt-out annotation
- `data-testid` discipline (rule #3)
- Azure-blob → filesystem patching for CI

---

### Target structure

```
tests/e2e/
├── fixtures.ts                 # unchanged
├── pages/                      # Page Objects (selective)
│   ├── AdminShell.ts
│   ├── SiteTree.ts
│   ├── ComponentTree.ts
│   ├── EditorPanel.ts
│   └── PublishPanel.ts
├── scenarios/                  # user-journey tests (5-10 files)
│   ├── first-edit-and-save.spec.ts
│   ├── publish-to-staging.spec.ts
│   ├── promote-staging-to-prod.spec.ts
│   ├── undo-a-publish.spec.ts
│   └── switch-active-target.spec.ts
├── features/                   # split editor.test.ts by describe
│   ├── toolbar.spec.ts
│   ├── theme.spec.ts
│   ├── component-tree-reorder.spec.ts
│   ├── publish-panel-ui.spec.ts
│   ├── unsaved-guard.spec.ts
│   ├── custom-editors.spec.ts
│   └── history.spec.ts
├── matrices/                   # parameterized across natural axes
│   ├── environments.spec.ts    # env × editable
│   └── target-types.spec.ts    # static × dynamic
└── production/
    ├── static.spec.ts
    ├── esi.spec.ts
    └── build.spec.ts
```

---

### Matrix axes (domain-natural)

| Axis | Values | Source |
|------|--------|--------|
| Target type | static, dynamic | design-concepts.md |
| Environment | local, staging, production, unset | design-concepts.md |
| Editable | yes, no | design-concepts.md |
| Storage provider | filesystem, R2, S3, azure-blob | architecture.md |

Env × editable × type = 16 combinations. Many admin behaviors differ across them.

**Example:**

```ts
const envMatrix = [
  { env: 'local', editable: true,  chrome: 'neutral', confirm: false },
  { env: 'staging', editable: false, chrome: 'amber',   confirm: false },
  { env: 'production', editable: false, chrome: 'red',  confirm: true  },
  { env: 'production', editable: true,  chrome: 'red',  confirm: true  },
]
for (const row of envMatrix) {
  test(`${row.env} ${row.editable ? 'editable' : 'readonly'}`, async ({ page, testSite }) => {
    await configureTarget(testSite, row)
    // parameterized body
  })
}
```

---

### Top user journeys (scenario candidates)

Derived from design-publishing.md and design-editor-ux.md — pick the 5-10 that matter most:

1. First edit → save
2. Save → publish to staging
3. Promote staging → prod (with confirmation)
4. Hotfix: publish prod → local
5. Undo a publish (transient Undo)
6. Rollback via history panel
7. Switch active target (preserves context)
8. Switch with unsaved edits (guard fires)
9. Multi-destination fan-out publish
10. Delete-and-recreate target

Write scenarios as Given/When/Then prose comments over POM method calls — no Cucumber.

---

### POM — selective adoption

| Surface | POM value |
|---------|-----------|
| `PublishPanel` | High — source + destinations + items + actions; in most scenarios |
| `SiteTree` | High — used in every test |
| `ComponentTree` | High — reorder/add/remove mechanics |
| Everything else | Keep inline; adopt POM when reuse hurts |

---

### Phased migration

#### ✓ Phase 1 — Reorganize (zero behavior change)

Landed. Split the old 1,246-line `editor.test.ts` (64 tests, 27 describes) into 12 feature
files + a shared `helpers.ts` for `openEditor`. Test count preserved exactly: 64 before, 64
after. All tests pass.

**New layout** (flat under `tests/e2e/`, naming `.spec.ts` for the new files):

- `smoke.spec.ts` — admin loads, toolbar tooltips
- `theme.spec.ts` — user theme, theme toggle, toast
- `site-tree.spec.ts` — dirty indicators
- `editor.spec.ts` — default editor, custom editor, custom field, rapid selection
- `unsaved-guard.spec.ts` — unsaved dialog, component stashing, escape key
- `deep-linking.spec.ts` — deep links + dev playground deep links
- `dev-playground.spec.ts` — dev playground
- `component-ops.spec.ts` — add/move/remove
- `publish.spec.ts` — publish panel, fragment blast radius, save labeling, sync grouping
- `target-switch.spec.ts` — preserves preview / missing item / unsaved edits
- `history.spec.ts` — undo last save + history panel
- `keyboard.spec.ts` — keyboard shortcuts

Deferred subdirectory layout (`scenarios/`, `features/`, `matrices/`, `production/`) — flat
under `tests/e2e/` was simpler for Phase 1. Subdirectories can come in later phases as the
suite grows; today's 12 files are fine flat.

playwright.config.ts `testMatch` extended to both `.test.ts` and `.spec.ts`. Production
files stay on `.test.ts` and are excluded via `testIgnore`.

---

#### ◐ Phase 2 — Page Objects

Two POMs landed:

**[PublishPanelPom](../../tests/e2e/pages/PublishPanel.ts)** — full Publish-panel surface:
opening, source/destinations, items, publish action (with prod confirmation variant),
status surfaces (confirm banner, invalid-templates, progress, per-target results).
Migrated the `Publish panel` describe in [publish.spec.ts](../../tests/e2e/publish.spec.ts)
(14 tests).

**[SiteTreePom](../../tests/e2e/pages/SiteTree.ts)** — site tree sidebar: page/fragment
rows, dirty dots, delete buttons, new-page/new-fragment creation buttons, selected-state
helpers (`selectedPage` / `selectedFragment`) for the `.selected` class. Migrated 27
selectors across 7 spec files (smoke, site-tree, editor, deep-linking, publish,
target-switch, unsaved-guard).

**Pattern:** POMs live under `tests/e2e/pages/`, one file per surface. Composition, no
inheritance — each POM takes a `page` in the constructor. Methods expose user-level
actions; getters/methods return locators; assertions stay in the tests. Matches
[Playwright POM docs](https://playwright.dev/docs/pom).

**Follow-ups:** ComponentTreePom — deferred to PR that migrates component-ops.spec and
similar. Each POM with its first consumer keeps the API honest (avoids dead-code POMs).

---

#### ◐ Phase 3 — Scenarios

Scenarios target **cross-surface integration gaps** — workflows that cross ≥3 surfaces
where feature tests cover each surface alone but not the interactions between them. The
surface codes below are used throughout for cross-referencing.

**Surfaces (shorthand for the matrix):**

| Code | Surface |
|------|---------|
| `ED` | Editor form (field input, dirty state) |
| `SV` | Save pipeline (API, toast) |
| `PB` | PublishPanel (open, source, destinations, items) |
| `PB.P` | Publish execution (actual stream + result) |
| `PB.C` | Production confirmation flow |
| `PB.G` | Destination groups / fan-out |
| `ST` | Site tree (navigation, dirty dots) |
| `CT` | Component tree (add/remove/move) |
| `AT` | Active target switcher |
| `UG` | Unsaved guard dialog |
| `HI` | History / undo / rollback |
| `SYN` | Sync indicators |
| `TOAST` | Toast (success, error, action) |
| `KEY` | Keyboard shortcuts |

**Cross-surface combo coverage:**

| Combo | Covered by | Status |
|-------|------------|--------|
| ED + SV + TOAST + HI | `history.spec` save-toast-undo | ✓ |
| AT + HI + ED + ST | `history.spec` restore-via-panel | ✓ |
| ED + UG + SV | `unsaved-guard.spec` unsaved-dialog | ✓ |
| AT + UG + ED | `target-switch.spec` unsaved-cancel | ✓ |
| **ED + SV + PB + PB.P + SYN** | Scenario #1 (this PR) | ◐ |
| **PB + PB.G + PB.P** | Scenario #2 (this PR) | ◐ |
| **AT + PB (reverse) + PB.P** | Scenario #3 (this PR) | ◐ |
| **HI + ST + SYN** | Scenario #4 (this PR) | ◐ |

**Filled by this PR — 3 scenarios under `tests/e2e/scenarios/`:**

1. **Full edit → save → publish → sync cycle** (ED + SV + PB + PB.P + SYN) — the happy path users do dozens of times a day, never previously covered end-to-end
2. **Fan-out publish with real execution** (PB + PB.G + PB.P) — existing `publish.spec` verifies the UI toggle but stops before dispatching the multi-target publish
3. **Rollback → downstream sync refresh** (HI + ST + SYN) — existing `history.spec` tests restore but not the cascade into site tree dirty state and sync indicators

**Deferred — hotfix: source=prod → local** (AT + PB reverse-direction + PB.P). Requires
`editable: true` on the production target to make the source dropdown appear, but the
dev server's site.yaml watcher doesn't invalidate the target registry on config change —
a beforeEach patch isn't picked up by the already-running admin API. Two paths for the
follow-up: (a) add a separate Playwright project that spawns its own dev server against
a pre-patched site.yaml, or (b) fix the dev server to reload target registry on
site.yaml change. Both are infrastructure work, not scenario work.

**Test-data isolation:** scenarios mutate both the editable source (local's
`pages/home/page.json`) and multiple target dist dirs. The worker-scoped `testSite`
fixture shares state across tests on the same worker, so each scenario's `beforeEach`
calls [scenarios/_isolation.ts](../../tests/e2e/scenarios/_isolation.ts)
`resetScenarioState` — restores `page.json` to a pristine starter baseline and wipes
every target's dist dir + history. Cost is a single file write + parallel `rm -rf`s,
measured in tens of ms per scenario.

**Not written — already covered by feature tests:**

- Save + publish prod-confirm + execution (scenario #2 from the longer plan) — `publish.spec` already covers prod confirm requirement and non-prod execution separately
- Full undo round-trip (scenario #5) — `history.spec` covers toast-undo end-to-end
- Target switch with unsaved edits (scenario #6) — `target-switch.spec` covers all three branches (Save / Discard / Cancel)

Adding these as scenarios too would duplicate existing coverage without closing a gap.

---

#### ✓ Phase 4 — Matrix tests

Landed. Two parameterized specs under
[tests/e2e/matrix/](../../tests/e2e/matrix/) running against a dedicated fixture site
(`tests/fixtures/sites/target-matrix/`) with 8 targets covering every
env × editable × type combo that matters:

- **env-chrome.spec.ts** (8 rows) — active-target chrome class + read-only badge track
  `environment` + `editable` independently of `type`
- **prod-confirm.spec.ts** (7 rows) — `environment: production` always gates the Publish
  button with a confirmation banner; non-prod destinations publish in one click,
  regardless of editable/type combinations

**Infrastructure added:**

- New workspace glob `tests/fixtures/sites/*` in root package.json — a home for test-only
  fixture sites that shouldn't pollute `examples/` (user-facing samples) or `sites/`
  (production dogfood)
- [tests/fixtures/sites/target-matrix/](../../tests/fixtures/sites/target-matrix/) — 8
  targets (local-edit, local-ro, local-dyn, staging-ro, staging-edit, prod-ro, prod-edit,
  prod-dyn) each exercising one meaningful axis combination
- New Playwright project `matrix` in [playwright.config.ts](../../playwright.config.ts) +
  matching `webServer` entry on port 4005

**Why fixture site over component-level tests:** env × editable × type gate real admin
UI paths that go through the targets API, not just Vue props. A component test could mount
with synthetic configs but wouldn't exercise the `/api/targets` serialization or source-
context resolution. The dedicated fixture site tests the full integration.

**Dev-server settings banner** added as a side effect — startup now prints resolved
project/site/templates paths, default source target with its env/editable/type, content
root, and every configured target's props + storage path. Catches fixture misconfig
(wrong `storage.path`, missing content root) at the first run instead of via empty API
responses. Opt out with `GAZETTA_QUIET=1`.

---

## Explicit non-recommendations

| Skip | Why |
|------|-----|
| Visual regression testing | css-theming.md and design-decisions.md explicitly defer; reintroduction criteria not met |
| Playwright Vue component testing | Experimental; Vitest + Vue Test Utils covers it |
| `vitest-axe` (original) | v0.1.0, last published 3 years ago — unmaintained |
| Pact for contracts | Overkill for single consumer/provider |
| Vitest `bench` | Experimental, no SemVer guarantee — adopt only with specific perf motivation |
| Cucumber / playwright-bdd | Intent gets split between feature files and step defs — worse maintainability for solo dev |
| Screenplay pattern | Designed for multi-team / multi-actor scaling |
| External CSV/JSON test data | TypeScript matrices are type-safe |
| Global setup hooks | Worker-scoped fixture already handles per-worker setup |
| Named workflow profiles | Rejected by design-decisions.md #15 |

---

## Cleanup items (orthogonal)

- ✓ Dead `@testcontainers/azurite` dep removed from
  [apps/admin/package.json](../../apps/admin/package.json)
- ✓ Formatter/linter placeholders in [node/conventions.md](./node/conventions.md) filled
  in against actual tooling (Biome format, linter disabled, Vitest + Playwright)

---

## Suggested sequence

| Week | Coverage work | E2E work |
|------|---------------|----------|
| 1 | ✓ Priority 1.1-1.3 (Vue tests, sidecars, PBT) | ✓ Phase 1 (file moves, no-risk) |
| 2 | ✓ Priority 1.4 (fault injection) | ◐ Phase 2 (POMs — two landed, more follow) |
| 3 | ✓ Priority 2.1 (Azure CRUD parity) | ◐ Phase 3 (scenarios — 3 landed, 1 deferred) |
| 4 | ✓ Priority 2.2 · ✓ Priority 2.3 (all 5 BASELINE entries cleared; preview iframe excluded — site-author scope) | ✓ Phase 4 (matrices) |
| Later | Priority 3 (✓ 3.1 mutation nightly · ✓ 3.2 contract-test endpoint burndown) | Cross-surface scenario #4 (hotfix source=prod) when dev-server target-registry reload lands |

Estimates are predictions. Real pace depends on what you hit.

---

## Sources (for future reference)

**Part 1:**
- [Pinia testing](https://pinia.vuejs.org/cookbook/testing.html)
- [fast-check](https://github.com/dubzzz/fast-check)
- [StrykerJS](https://github.com/stryker-mutator/stryker-js)
- [@stryker-mutator/vitest-runner](https://www.npmjs.com/package/@stryker-mutator/vitest-runner)
- [@vue/test-utils releases](https://github.com/vuejs/test-utils/releases)
- [@chialab/vitest-axe](https://www.npmjs.com/package/@chialab/vitest-axe)
- [PrimeVue accessibility](https://primevue.org/guides/accessibility/)
- [Vitest benchmark config](https://vitest.dev/config/benchmark)

**Part 2:**
- [Playwright POM](https://playwright.dev/docs/pom)
- [Playwright parameterize](https://playwright.dev/docs/test-parameterize)
- [Playwright fixtures](https://playwright.dev/docs/test-fixtures)
- [Playwright best practices](https://playwright.dev/docs/best-practices)
- [Cucumber vs Playwright](https://www.browserstack.com/guide/cucumber-vs-playwright)
- [BDD without Cucumber](https://javascript.plainenglish.io/playwright-bdd-testing-you-dont-need-cucumber-ae38085c51b7)
- [Data-driven Playwright](https://thenewstack.io/a-practical-guide-to-data-driven-tests-with-playwright/)
