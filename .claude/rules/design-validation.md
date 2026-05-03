# Validation

How the CMS surfaces correctness, integrity, and quality issues to authors and operators. Designed around the editor-UX principle that detection point should match author commitment level — not "everything is checked at every gate."

**This doc covers the design:** four-phase model, validator abstraction, severity model, surfaces, what's in/out of scope, distinctive choices.

**Companion docs:**
- [design-validation-implementation.md](design-validation-implementation.md) — phased cut sequence, scope, deferred items, build order.

## Scope

**The final goal:** content that ships produces valid, accessible, performant HTML/CSS/JS. The validation system exists to surface deviations from that goal at the earliest cheap detection point that matches author intent.

**In v1.5:**
- Phase-aware validator abstraction (`Validator` interface + `Issue[]` shape)
- Save-delta validation (block save on refs the current edit just broke)
- Background scanner (continuous visibility into accumulated issues across the site)
- Quality validators using real tools (axe-core, html-validate) against rendered output
- Pre-publish gate with operator-controlled strictness
- `gazetta validate` CLI as a non-interactive run of the same validators

**Out of scope:**
- Real-time keystroke validation (already covered by @rjsf's Zod-driven form layer)
- Reimplementing accessibility / HTML / CSS analysis (use real tools — axe-core, html-validate, stylelint, Lighthouse, linkinator — under the abstraction)
- A "site SEO score" or content scoring (per [seo-plan.md](seo-plan.md): weakly correlated with rankings, encourages over-optimization)
- Blocking save on accumulated pre-existing issues (hostile UX; the background scanner surfaces them visibly without blocking)
- Server-side keystroke validation (the form layer is sufficient)

## The four-phase model

The load-bearing principle: **detection point should match author commitment level.** A keystroke is not a commitment; a save is light commitment; the background is observational; publishing is the firm commitment. Each phase has its own surface, severity, and timing.

| Phase | Trigger | Severity | Surface | Latency budget |
|---|---|---|---|---|
| **1. Format** | Field blur / 300ms idle keystroke | Block field commit | Inline next to field | <100ms |
| **2. Integrity** | Save click | Block save when this edit introduced the break | Banner + focus-to-first-error | <3s |
| **3. Quality** | Background, after save | Inform | Site-tree dots + "Site health" drawer | Async; minutes OK |
| **4. Publish gate** | Publish click | Configured by operator | Pre-publish modal with fix/ignore/override | Pre-commit |

This maps directly onto how successful tools (Sanity, Payload, GitHub PR review) handle validation — the best ones keep phases **distinct** rather than blending them. Where they fall short: their quality surfaces are weak or absent. Gazetta's render pipeline + per-target `editable` flag give it a structural advantage other CMSes don't have.

### Why phase-separation matters

Real-time validation on every keystroke increases user errors per [UX research](https://uxmovement.com/forms/why-users-make-more-errors-with-instant-inline-validation/) — authors are distracted by flashing errors while still composing. Aggregating unrelated issues in one giant list makes authors tune out. Conflating "draft" with "valid" forces premature commitment.

Each phase exists for a real reason:
- **Format** is for the author who's typing — fix it now while in flow
- **Integrity** is for the author who's pausing — what did *I* just break?
- **Quality** is for the author who's working — what's the holistic state?
- **Publish gate** is for the operator who's committing — am I about to ship something broken?

Mashing them produces hostile UX. Keeping them separate is the design.

### Why save-delta, not save-full

The integrity phase blocks save **only** on issues introduced by the current edit. If the page already had a missing-asset reference before the author touched it, that's the **background scanner's** problem to surface, not the save handler's.

Rationale:
- Matches author intent: "I touched this; tell me what I broke" — not "tell me about everything that's been broken since I started this morning"
- Avoids blocking on debt the author can't fix now (different author created it; templates changed; assets got deleted out-of-band)
- Keeps save fast: O(diff) instead of O(site)
- Catches the realistic introduction paths: hand-editing JSON, programmatic content imports, custom CLI flows

The background scanner surfaces the rest, visibly but non-blockingly.

### Why the publish gate is distinct from save

In Gazetta's stateless model, **the local target IS the draft**. `editable: true` on local; `editable: false` (default) on staging/prod. That's the natural draft/published boundary already encoded in the data model.

Save commits to the local target — incomplete is fine. Publish commits to a non-local target — that's the operator's "ship it" moment. Gating quality there matches existing semantics; gating it at save would force the author into commitment they didn't intend.

This also means: configured strictness lives at the publish gate. Operators with strict workflows enable quality gates at publish; operators with loose workflows don't. The save handler stays uniform.

## The Validator abstraction

One interface; many implementations; multiple entry points consume the same validators.

```ts
export interface Validator {
  /** Stable identifier for diagnostics ('referenced-asset-exists', 'accessibility'). */
  readonly name: string

  /** Which lifecycle stages this validator runs at. */
  readonly stages: readonly ValidationStage[]

  /** Default severity per stage. Operators may promote/demote at the publish gate. */
  defaultSeverity(stage: ValidationStage): Severity

  /** Run the validator. Returns issues; never throws on validation failure. */
  validate(input: ValidatorInput): Promise<Issue[]>
}

export type ValidationStage =
  | 'save-delta'        // diff incoming vs. existing manifest; check only new refs
  | 'background'        // continuous full-site scan
  | 'pre-publish'       // run before publish; can be heavy
  | 'cli'               // gazetta validate non-interactive

export type Severity = 'error' | 'warn' | 'info'

export interface ValidatorInput {
  stage: ValidationStage
  site: Site
  contentRoot: ContentRoot
  storage: StorageProvider
  templates: TemplateRegistry
  /** Scope is stage-specific:
   *   - save-delta: { item, before, after }
   *   - background: { item } iterated by the scanner
   *   - pre-publish: { items: published-set }
   *   - cli: site-wide
   */
  scope: ValidatorScope
  /** Cached rendered HTML when available (background, pre-publish). */
  renderedOutput?: RenderedOutputAccess
}

export interface Issue {
  validator: string
  severity: Severity
  /** Human-readable message. Author-facing. */
  message: string
  /** Item path like `pages/home/page.json`. */
  itemPath: string
  /** Content-tree path within the manifest, when applicable. */
  contentPath?: string
  /** Optional structured suppression hint — `Issue.suppressible: true`
   *  means a future "ignore this issue" mechanism would apply. */
  suppressible?: boolean
}
```

### What stages look like in practice

- **save-delta**: PUT /api/pages/:name diffs incoming vs. existing manifest. Validators run only against the introduced refs (new `_asset`, new `@fragment`, new component template). 409 with `Issue[]` body if any error-severity issues; 200 otherwise. Fast.

- **background**: Admin server runs a long-lived scanner. Initial scan on admin boot. Incremental rescan when file watcher detects manifest/template/asset changes. Per-page validation run cached by content hash; only re-runs when something material changed. Issues stored in a Pinia store, surfaced in the UI.

- **pre-publish**: Publish dialog gains a "Run audit" affordance (or always-runs for opted-in targets). Heavy validators (Lighthouse) only run here. Operator sees consolidated `Issue[]` with severity per their target's config. Fix / ignore / promote-to-error per issue. Block publish on remaining errors.

- **cli**: `gazetta validate` runs all validators in non-interactive mode. Exit non-zero on any error. Useful for CI gating before deploy.

### Stage × validator matrix

| Validator | save-delta | background | pre-publish | cli |
|---|---|---|---|---|
| `referenced-asset-exists` | ✓ error | ✓ error | ✓ error | ✓ error |
| `referenced-fragment-exists` | ✓ error | ✓ error | ✓ error | ✓ error |
| `referenced-template-exists` | ✓ error | ✓ error | ✓ error | ✓ error |
| `circular-fragment` | ✓ error | ✓ error | ✓ error | ✓ error |
| `dynamic-route-conflict` | ✓ error | ✓ error | ✓ error | ✓ error |
| `schema-conformance` | — | ✓ warn | ✓ error | ✓ warn |
| `altRequired` | ✓ error (when introduced) | ✓ error | ✓ error | ✓ error |
| `accessibility` (axe-core) | — | ✓ warn | ✓ warn (operator promotes) | ✓ warn |
| `html-validity` (html-validate) | — | ✓ warn | ✓ warn | ✓ warn |
| `css-validity` (stylelint) | — | ✓ info | ✓ warn | ✓ warn |
| `broken-links` (linkinator) | — | — | ✓ warn (opt-in) | ✓ warn (opt-in) |
| `lighthouse` | — | — | ✓ info (opt-in, heavy) | ✓ info (opt-in) |
| `orphaned-locale-file` | — | ✓ warn | — | ✓ warn |
| `unused-fragment` | — | ✓ info | — | ✓ info |

**Why save-delta has so few entries:** the save handler should be fast and narrow. Reference-existence checks run; everything else is the background scanner's job.

**Why some validators have `—` at save-delta:** they need full-site context (orphaned-locale-file) or rendered output (a11y, html-validity) — neither of which is available cheaply at save.

## Surfaces

Three distinct UI surfaces, each tied to a phase:

### Banner (save-time integrity)

When PUT returns 409 with `Issue[]`, the editor shows a dismissible banner at the top of the form with the issue list and a "focus" action that scrolls to the offending field. Save button stays disabled until issues clear.

**Visual weight:** high. Red. Author needs to act now.

**Scope:** only issues introduced by THIS save. Pre-existing issues NEVER appear here.

### Site tree dots + "Site health" drawer (background)

Site tree shows colored dots next to items with issues:
- Red dot — error-severity issue
- Amber dot — warn-severity issue
- (No dot for info-severity to avoid noise)

A "Site health" drawer (closed by default; icon in top bar) lists all current issues across the site, grouped by item, sortable by severity. Click an issue to navigate to the affected item with the relevant field highlighted.

**Visual weight:** ambient. Authors see what's broken; nothing blocks.

**Scope:** all current issues across the entire site.

### Pre-publish modal (publish gate)

Existing publish dialog gains a "Pre-publish audit" step before the destination picker. Shows the list of issues that would apply to the items being published. Per issue: "Fix" (jump to item), "Ignore" (mark as known-acceptable for this publish), "Promote to error" (block publish on this).

Operator-configurable per target: `targets.production.publishAudit: { strict: true }` promotes all warns to errors.

**Visual weight:** modal — operator is committing.

**Scope:** items being published × their issues × target config.

## Severity

Three levels:

- **`error`** — blocking at the gate where it appears. Save blocks on save-delta errors; publish blocks on pre-publish errors.
- **`warn`** — non-blocking; surfaced in UI; CLI exits non-zero by default but `--no-warn-as-error` flag tolerates.
- **`info`** — visible in detailed views; not surfaced by default; never blocks.

The severity is **per-stage**. The same validator can warn at background but error at pre-publish. Operators promote or demote at the publish-gate config.

## Quality validators: integrate, don't reimplement

The architectural call: use real tools for the actual analysis. Each tool plugs in via the `Validator` interface; the CMS owns scheduling, surfacing, and incremental scope.

| Domain | Tool | Engine notes |
|---|---|---|
| Accessibility | `axe-core` | Run via `jsdom` in admin process; ~50-100ms per page. Battle-tested by every major a11y product. |
| HTML validity | `html-validate` | Fast, configurable, widely used in CI. |
| CSS lint | `stylelint` | Industry standard. |
| Broken links | `linkinator` | Crawl rendered output for outbound link rot. |
| Performance / SEO score | Lighthouse via Playwright | Heavy (5-15s per page). Pre-publish only, opt-in. |

Why this is the right move:
- These tools encode decades of domain expertise; any in-house validator would be strictly worse
- Issues from real tools carry credibility (authors don't argue with axe-core results)
- Tool versions can be pinned and updated independently of Gazetta
- The CMS focuses on **integration** — scheduling, scope, surfacing, fix-it actions — which is the real CMS work

What we DON'T do:
- Reimplement a11y rules
- Build a Yoast-style content score (rejected per [seo-plan.md](seo-plan.md))
- Run heavy tools (Lighthouse) in the background scanner

## Render-for-analysis

Quality validators need rendered HTML/CSS to do their job. Gazetta already has a render pipeline (preview + publish). The validator framework exposes a "render-for-analysis" entry point that:

- Calls the same renderer used for preview/publish
- Returns rendered HTML/CSS/JS without writing to storage
- Caches by content hash + template hash + locale; re-renders only when something material changed
- Reuses the existing dependency-aware sidecar machinery (`findDependentsFromSidecars`) so a fragment edit only invalidates pages that use that fragment

This is a Gazetta-specific advantage other CMSes don't have. Most CMSes either:
- Don't have a render pipeline (headless-only) and force authors to wait for deploy
- Have one but it's coupled to publish (no analysis-only render path)
- Have one but no dependency-aware caching (re-render everything every time)

Gazetta's incremental sidecar tracking makes per-page quality validation cheap at scale.

## Distinctive choices

### Phase separation, not unification

Most CMSes blur the lines: validation rules fire at every gate, surfaces overlap, severity is one-dimensional. Gazetta keeps four distinct phases with three distinct surfaces, each matching a real author commitment level.

### Save-delta, not save-full

The save handler only blocks on what THIS save introduced. The accumulated state is the background scanner's surface. Authors aren't held responsible for debt they didn't create.

### Local target IS the draft

Other CMSes invent draft/published as a separate concept. Gazetta's `target.editable` already encodes commitment level — local is the draft, prod is the publish. Phase 4 (publish gate) maps onto this naturally without inventing new vocabulary.

### Quality validators integrate real tools

Don't reimplement axe-core. Don't write a Yoast clone. The CMS schedules and surfaces; the tools analyze. Each tool is one Validator implementation behind the same interface.

### Suppression is structural, not field-level

Issues carry a `suppressible: true` hint. Suppression itself is a future operation (operator says "ignore this rule for this content"); designing the field in from day one means we don't retrofit.

### Operator-configurable publish gates

Per-target `publishAudit` config controls whether quality warns block publish. Strict workflows enable; loose workflows skip. The CMS doesn't impose a one-size-fits-all severity.

## Migration

### Existing sites

Sites without any AI/validation config continue to work — validators run with default severities; no errors are introduced retroactively unless content was already broken (in which case authors needed to know).

### Existing `gazetta validate` behavior

The command is rewritten to run all validators in non-interactive mode. Output format stays roughly the same (per-item ✓/✗ summary). Adds new categories (a11y, html-validity) behind `--include-quality` flag (off by default for speed; CI opts in).

### Editor UX migration

Authors see new surfaces gradually:
- Cut 1 ships: save-time banner appears when an edit breaks a ref. Familiar pattern, low cognitive load.
- Cut 2 ships: site-tree dots and Site health drawer appear. Authors learn the "ambient visibility" pattern.
- Cut 3 ships: dots and drawer surface a11y/HTML/CSS issues alongside ref issues. No new UI; same surface.
- Cut 4 ships: publish dialog gains the audit step. Operators see the new modal at publish time.

Each cut is independently shippable; authors learn one new surface per ship.

## Open questions

1. **Rendered-output caching key.** Content hash + template hash + locale + theme is the obvious key, but: when a referenced fragment changes, every page using that fragment needs re-render-for-analysis. The sidecar dependency tracking knows the affected set; the cache key needs to incorporate the transitive dependency hash. Worth building correctly the first time.

2. **Severity promotion at the publish gate.** Per-target `publishAudit.strict` is a coarse switch. Per-validator override (`publishAudit.accessibility: error`) is cleaner. Compromise: ship the coarse switch in Cut 4; per-validator override lands when an operator asks.

3. **Background scanner cost on huge sites.** A 5000-page site running axe + html-validate on every fragment edit could take minutes. Mitigation already exists (dependency-aware re-validation); needs to be wired correctly.

4. **Suppression UX.** When an author wants to silence a specific issue ("I know this image is decorative even though axe doesn't"), where does the suppression live? Options: per-content (in the manifest as `_suppressions: {...}`), per-asset (on the asset manifest), per-site (in `site.yaml`). Each has different scoping characteristics. Defer designing until authors actually ask.

5. **Validator versioning.** axe-core releases new rules; sites that pass today might fail tomorrow. Pin versions; document update policy. Same as the AI alt refusal-marker maintenance question.
