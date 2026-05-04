---
paths:
  - "packages/gazetta/src/config/**"
  - "packages/gazetta/src/site-loader.ts"
  - "**/site.config.ts"
  - "**/gazetta.config.ts"
---

# Site config — Implementation

Companion to [design-config.md](design-config.md) and [ADR-0005](../../docs/adr/0005-typescript-config-format.md). Cut sequence with risk ordering.

See [design-config.md](design-config.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `config-ts-migration` off `main`. **No backwards compatibility** — single-PR sweep replaces YAML loader wholesale; cutover commit (8) crystallizes the breaking change.

**Locked decisions before implementation:**

- **Q1**: jiti for TS evaluation (reuses existing template-loading infrastructure)
- **Q2**: file-not-found handling — site directory without `site.config.ts` warns + skips; empty `sites/` warns + continues; flat + `sites/` both present errors on conflict
- **Q3**: single PR with code + design-doc sweep + user-doc sweep + examples
- **Q4**: dotenv loads BEFORE config eval; project-root only (no per-site `.env`); CI-skip preserved
- **Q5**: 10-commit sequence (additive scaffolding → integration → docs sweep → cutover)

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `config/` types + Zod schemas + `defineSite` / `defineGazetta` exports | ✓ | Low | Type contracts |
| 2 | `config/` loader: walks filesystem; jiti evaluation; Zod validation | ✓ | Medium | Real file loading |
| 3 | Loader integration tests with fixture configs | ✓ | Low | Loader works against `defineSite()` outputs |
| 4 | Wire `site-loader.ts` to use new config loader | ✓ | Medium-high | Cutover; existing consumers see same `Site` shape |
| 5 | Migrate `examples/starter` + CLI bootstrap/dispatch (was Cut 5 + Cut 10 — merged) | ✓ | Medium | End-to-end pipeline; dogfood; CLI commands work via TS config |
| 6 | Sweep design docs (~30 files) — mechanical YAML → TS examples | ✓ | Low | Doc accuracy |
| 7 | Sweep user-facing docs (`getting-started`, `cloudflare`, `self-hosted`, `migration`) | ☐ | Low | Operator UX |
| 8 | Remove YAML loader code paths (the actual cutover) | ☐ | Medium | Hard cutover |
| 9 | Update `gazetta init` scaffolding to produce TS config | ☐ | Low | New-site UX |
| ~~10~~ | ~~Update CLI handlers~~ — folded into Cut 5 (the starter migration cannot be verified without it) | ✓ | — | — |

## Per-cut scope

### Cut 1: types + Zod schemas + `defineSite` / `defineGazetta`

**Files added:**
- `packages/gazetta/src/config/types.ts` — `GazettaConfig`, `SiteConfig` interfaces
- `packages/gazetta/src/config/schemas.ts` — Zod schemas matching the TS interfaces (single source of truth via `z.infer<typeof SiteConfigSchema>`)
- `packages/gazetta/src/config/define.ts` — `defineSite<T>(config: T): T` + `defineGazetta<T>(config: T): T` (typed identity functions)
- `packages/gazetta/src/config/index.ts` — barrel export
- `packages/gazetta/src/index.ts` — re-export `defineSite`, `defineGazetta` from package root (top-level export)

**Tests:** schema parsing happy path + invalid config rejection; type-level checks confirming `defineSite` preserves literal types

**Why first:** lowest blast radius. Types + identity functions; no runtime loading behavior. Reverting one file rolls back without breaking working state.

**Files modified:** none yet — additive only.

### Cut 2: loader

**Files added:**
- `packages/gazetta/src/config/loader.ts` — `loadGazettaConfig(projectRoot)` + `loadSiteConfig(siteDir)` + `discoverSites(projectRoot)`
- Loader uses jiti (already in `packages/gazetta/package.json` deps for templates)

**Loader responsibilities** (per design-config.md + Q2 lock):
- dotenv load BEFORE jiti evaluation (Q4 lock); project-root only; CI-skip preserved
- Discover layout: if `sites/` directory exists → walk it; otherwise → flat layout (`site.config.ts` at root)
- Validate per Q2: site dir without config warns + skips; empty `sites/` warns; flat + sites/ conflict errors
- Evaluate `gazetta.config.ts` if present at root (optional)
- Evaluate each `site.config.ts` (mandatory for declared sites)
- Apply Zod validation; throw `ConfigValidationError` with file path on failure
- Apply `gazetta.config.defaults` to site configs (per design-config.md "Defaults flow")

**Tests:** unit tests with mocked filesystem + real jiti evaluation against fixture files

**Why second:** real file loading; depends on Cut 1 types. Reverting drops loader; types stay.

### Cut 3: loader integration tests

**Files added:**
- `packages/gazetta/tests/config-loader.test.ts` — fixture-based integration tests
- `packages/gazetta/tests/fixtures/configs/` — multiple fixture sites:
  - `flat-single-site/site.config.ts`
  - `multi-site/sites/main/site.config.ts` + `sites/blog/site.config.ts`
  - `with-global/gazetta.config.ts` + `sites/main/site.config.ts`
  - `conflict-flat-and-sites/` (both layouts present — must error)
  - `empty-sites-dir/sites/` (empty)
  - `site-without-config/sites/incomplete/` (no site.config.ts — warn + skip)

**Tests:** all Q2 scenarios + happy paths

**Why now:** validates the loader against real-world layouts before integrating with site-loader.ts.

### Cut 4: wire `site-loader.ts` to new config loader

**Files modified:**
- `packages/gazetta/src/site-loader.ts` — `loadSite()` accepts pre-evaluated config from new loader; falls back to existing YAML reading when config absent (this commit; YAML removed in Cut 8)
- `packages/gazetta/src/site-loader.ts` `LoadSiteOptions` — extend with `config?: SiteConfig` field

**Tests:** existing test suite passes (regression check); new tests with `config: SiteConfig` input

**Why now:** integration moment. Both YAML and TS config work briefly. Existing consumers still see the same `Site` shape; downstream code unaffected.

### Cut 5: migrate `examples/starter`

**Files modified:**
- `examples/starter/sites/main/site.yaml` → `examples/starter/sites/main/site.config.ts`
- `examples/starter/package.json` — add `gazetta` as dep if not already
- Verify dev server boots; verify `gazetta publish` works

**Tests:** e2e tests for starter site continue to pass

**Why now:** dogfood the full pipeline before sweeping docs.

### Cut 6: sweep design docs

**Files modified (~30):**
- All `.claude/rules/design-*.md` files with YAML config examples
- Mechanical find/replace: YAML block → TS block
- Pattern: `\`\`\`yaml\nadmin:\n  cache:\n    type: memory\n\`\`\`` → `\`\`\`ts\nimport { defineSite } from 'gazetta'\nexport default defineSite({\n  admin: {\n    cache: { provider: 'memory' },\n  },\n})\n\`\`\``

**Tests:** none directly; manual review for example correctness

**Why now:** mechanical sweep after code is verified working.

### Cut 7: sweep user-facing docs

**Files modified:**
- `docs/getting-started.md` — operator's first-run experience
- `docs/cloudflare.md` — deployment guide
- `docs/self-hosted.md` — self-hosted deployment guide
- `docs/migration.md` — replace gradual-migration narrative with v0→v1 upgrade notes (no automated migration tool per ADR-0005)
- `docs/template-assets.md`, `docs/content-assets.md`, `docs/transform-adapters.md` — any YAML examples

**Why now:** mechanical; depends on real working code from earlier cuts.

### Cut 8: remove YAML loader (the cutover)

**Files modified:**
- `packages/gazetta/src/manifest.ts` — remove `parseSiteManifest` (the YAML reader)
- `packages/gazetta/src/site-loader.ts` — remove YAML fallback branch
- `packages/gazetta/package.json` — remove `js-yaml` dep
- All test fixtures referencing `site.yaml` updated to use `site.config.ts`

**Tests:** full test suite passes; YAML files removed from fixtures and source

**Why now:** hard cutover. Until this commit, YAML still works (degraded; warning logged). After this commit, YAML is gone.

### Cut 9: `gazetta init` scaffolding

**Files modified:**
- `packages/gazetta/src/cli/init.ts` — produce `site.config.ts` instead of `site.yaml`
- `examples/starter/` template (the `init` template source) — TS config

**Tests:** `gazetta init` produces a runnable site

### Cut 10: CLI handler updates

**Files modified:**
- `packages/gazetta/src/cli/dev.ts`, `publish.ts`, etc. — boot flow uses new loader
- `packages/gazetta/src/app.ts` — admin server boot flow uses new loader

**Tests:** e2e tests for all CLI commands pass

## Validation gate (definition of done)

- [ ] All 10 commits merged
- [ ] All ~30 design docs reference TS config (not YAML)
- [ ] All user-facing docs reference TS config
- [ ] `examples/starter` runs from TS config
- [ ] `gazetta init` produces TS config
- [ ] `js-yaml` dep removed from `packages/gazetta`
- [ ] No `site.yaml` references in source tree (grep verified)
- [ ] CHANGELOG entry: "Breaking: site.yaml → site.config.ts"

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `gazetta migrate-config` CLI | No backwards compat per ADR-0005; pre-1.0 product. Operators rewrite by hand. Could ship later if a v1.x→v2.x flip needs it. |
| Per-site `.env.local` files | Concrete demand from a multi-site project with truly distinct secret sets |
| `gazetta build:config` JSON precompile (v1.5) | Cold-start latency pain on cloud deployments |
| Custom `--env-file` Gazetta flag | Operators use Node's built-in `--env-file` directly |
| Hot-reload for config changes (dev) | Locked in design-config.md Q4; included in implementation when dev server's file-watcher is extended |

## Open implementation questions

1. **jiti version + config**: Gazetta already uses jiti for templates. Reuse the same instance with same config? Or per-purpose? Recommend reuse — single jiti instance with appropriate cache settings.

2. **Site name discovery for multi-site flat layout**: when `sites/main/site.config.ts` exists, the directory name "main" is the site name. If `site.config.export.name` differs from the directory name, error or warn? Recommend error — directory name should match config's `name` field for predictability.

3. **Hot-reload for site.config.ts in dev**: file watcher needs to invalidate the loader cache + trigger SSE refresh. Per design-config.md Q4 lock: dev hot-reload re-evaluates; plugin `dispose()` called before reinit. v1 implementation can defer plugin lifecycle (no plugins yet); just re-run loader.

4. **Type export for `SiteConfig`**: TS users importing `SiteConfig` for their own typing should get the full type. Export from `gazetta` package root.

## Test infrastructure

- Fixture sites under `packages/gazetta/tests/fixtures/configs/` cover Q2 scenarios
- Real jiti evaluation in tests (not mocked) — proves the integration works
- Existing e2e tests run against migrated `examples/starter`

## Estimates

| Commit | Estimate |
|---|---|
| 1 (types) | 0.5 day |
| 2 (loader) | 1 day |
| 3 (loader tests) | 0.5 day |
| 4 (site-loader integration) | 1 day |
| 5 (starter migration) | 0.5 day |
| 6 (design docs sweep) | 1 day |
| 7 (user docs sweep) | 0.5 day |
| 8 (YAML removal) | 0.5 day |
| 9 (init scaffolding) | 0.5 day |
| 10 (CLI handlers) | 0.5 day |

**Total: ~6.5 days.** With CI iteration + integration discoveries, budget ~1.5-2 weeks.

## SOLID checks per cut

- **Cut 1**: SRP per file (types / schemas / define / index). DIP — consumers depend on `SiteConfig` interface, not concrete loader.
- **Cut 2**: SRP — loader has one concern (read + validate); jiti integration is one composable; Zod validation is another.
- **Cut 4**: integration preserves the existing `Site` shape; no consumer downstream sees a contract change.
- **Cut 8**: removing YAML is structural — every reference must be updated together. SOLID through grep-clean closure.
