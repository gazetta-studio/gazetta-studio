---
paths:
  - "**/site.config.ts"
  - "**/gazetta.config.ts"
  - "packages/gazetta/src/config/**"
  - "packages/gazetta/src/types.ts"
  - "packages/gazetta/src/providers/**"
  - "packages/gazetta/src/transforms/**"
  - "packages/gazetta/src/cache/**"
  - "packages/gazetta/src/alt/**"
  - "packages/gazetta/src/targets.ts"
---

# Provider config — Implementation

Companion to [`design-provider-config.md`](design-provider-config.md). Phased cut sequence per surface; per-cut scope + tests + risk + SOLID checks.

See [`design-provider-config.md`](design-provider-config.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `provider-config-v1` off `main` (sequenced after Phase 0 design pass merges). Hard cutover per ADR-0005 + ADR-0008; no coexistence. Each phase is independently revertable per [team-preferences rule 17](team-preferences.md).

**Locked decisions before implementation:**

- **D1**: factory returns Provider instance (not marked config); field type is the runtime interface
- **D2**: construction at config-eval; bad credentials throw at first SDK method call (providers defer side effects)
- **D3**: `gazetta validate` constructs providers; runtime side effects deferred per provider author convention
- **D7**: build-time JSON precompile incompatible; reshape deferred to v1.5 design pass
- **D11**: hard cutover, no coexistence, no migration CLI
- **G1'c**: AI cross-task fallback via `AIProvider` per-task builder methods
- **G2'c**: defaults inheritance accepts raw options (Exception A)
- **G4'a**: per-target overrides as partial literals for behavior-only fields (Exception B)

| # | Phase | Status | Risk | Validates |
|---|---|---|---|---|
| 0 | Design pass: `design-provider-config.md` + this doc + ADR-0008 + ADR-0004 supersession header | ☐ | Low | Documents direction; no code |
| 1 | Storage migration: 4 operator-facing factories + dispatch removal in `targets.ts` + fixture migration + storage-section docs | ☐ | Medium-high | First instance of factory-returns-instance pattern; load-bearing for all subsequent phases |
| 2 | Transform migration: 2 operator-facing factories + dispatch removal in `transforms/index.ts` + fixture/doc updates | ☐ | Medium | Single-axis pattern repeats Storage's shape |
| 3 | Cache migration: `memoryCache` factory + Exception A defaults handling in `gazetta.config.ts` loader + dispatch removal | ☐ | Medium | Single-axis + Exception A defaults inheritance |
| 4 | AI migration: 3 operator-facing factories + `AIProvider` interface with per-task builder methods + AltTextSiteConfig nests via Pattern 2 + Exception B per-target partial overrides + `alt/factory.ts` rewrite | ☐ | High | Pattern 2 (multi-axis); largest single phase by code surface |
| 5 | Layer 1 typing cleanup: typed `GazettaManifest`, `<const T>` on defineSite/defineGazetta, validator boundary, drop loose public `SiteConfig`/`GazettaConfig`, locale-shape change (`locales: { default?, supported }`), regression tests | ☐ | Medium | Final type-system tightening; locale shape unification |
| 6 | Doc sweep: design docs, public docs, plugin authoring guide section, ADR-0004 supersession header reaffirmation | ☐ | Low | User-facing accuracy |

**Total estimate:** 4-5 weeks.

## Per-phase scope

### Phase 0 — Design pass (1 week)

**Files added:**
- `.claude/rules/design-provider-config.md` — ✓ DONE
- `.claude/rules/design-provider-config-implementation.md` — this file
- `docs/adr/0008-provider-factory-returns-instance.md` — ☐ pending
- `docs/adr/0004-pluggable-provider-pattern.md` — ☐ supersession header update

**Tests:** none; docs only.

**Why first:** establishes the durable design before any code touches the tree. Per `feature-design-process.md`, work of this magnitude requires the full doc set (design + implementation + ADR) before phase 1.

**Validation gate to merge phase 0:**
- All 13 foundational checks answered in design doc
- Multi-instance discipline check answered
- UX check answered
- Migration plan documented
- Open questions enumerated
- ADR-0008 documents the load-bearing decision
- ADR-0004 superseded scope precisely identified (operator-config-shape only; universal requirements preserved)
- Grilling pass conducted before merge

### Phase 1 — Storage migration (1 week)

**Files added:**
- Operator-facing factory functions (one per built-in storage variant), exposed as top-level exports from `gazetta`:
  - `r2Storage(opts: R2Options): StorageProvider`
  - `s3Storage(opts: S3Options): StorageProvider`
  - `azureBlobStorage(opts: AzureBlobOptions): StorageProvider`
  - `filesystemStorage(opts?: FilesystemOptions): StorageProvider`
- Each factory: validates required fields → resolves `${VAR}` env-var sentinels via existing `resolveEnvVars` → delegates to internal `create*Provider` factory → returns the constructed `StorageProvider`

**Files modified:**
- `packages/gazetta/src/types.ts`:
  - `TargetConfig.storage: StorageProvider` (was `StorageConfig`)
  - Delete `StorageConfig` interface (not needed; replaced by direct interface reference)
- `packages/gazetta/src/targets.ts`:
  - Delete `createStorageProvider(config, siteDir, targetName)` switch dispatch — operator's factory is already the instance
  - Path resolution for `filesystemStorage()` happens INSIDE the factory (uses `targetName` if provided through factory closure or via late-binding hook)
- `packages/gazetta/src/index.ts`:
  - Export the 4 operator-facing factory functions
  - Keep existing `createFilesystemProvider` / `createAzureBlobProvider` / `createS3Provider` / `createR2Provider` exports (per G5'a — internal factories stay public for tests + advanced wiring)
- `packages/gazetta/src/site-loader.ts`:
  - `loadSite` accepts `targets.X.storage: StorageProvider` directly; no construction needed

**Files updated (fixture configs):**
- `examples/starter/sites/main/site.config.ts`
- `sites/gazetta.studio/site.config.ts`
- `tests/fixtures/sites/target-matrix/sites/main/site.config.ts`
- `packages/gazetta/tests/fixtures/configs/*/site.config.ts` (4 fixture configs)

**Files updated (docs):**
- `docs/getting-started.md`, `docs/cloudflare.md`, `docs/self-hosted.md` — storage sections
- `.claude/rules/operations.md`, `.claude/rules/configurations.md`, `.claude/rules/hosting.md` — examples

**Tests:**
- Unit: each operator-facing factory accepts valid options + throws `ConfigError` on missing required fields
- Integration: existing storage tests work because internal `create*Provider` factories unchanged
- Update `tests/_helpers/starter.ts` if storage-construction pattern changed (likely no change since `loadSite` accepts pre-constructed providers per existing behavior)

**Tricky bit — filesystem path defaulting:**
Today: `targets.ts createStorageProvider` defaults `path` to `targets/<name>` based on the target name. Under Phase 1, the factory receives no target name; defaulting moves to one of:
- (a) Operator MUST specify `path:` explicitly — breaking for fixture configs that omit it
- (b) Factory accepts a deferred path via late-binding (factory returns a "buildable" that the loader resolves)
- (c) `filesystemStorage()` (no opts) returns a provider that resolves path lazily on first method call, knowing the target name from runtime context
- (d) Loader passes target name to factory at config-eval somehow

(b) breaks the "factory returns instance" purity. (c) couples filesystem provider to runtime context lookup. (a) is most honest but breaks ergonomics for "default to per-target dir" convenience.

**Decision: (a)** — operators specify `path:` explicitly when needed; default to `'./targets/local'` (or similar) when omitted. Loses the auto-naming-from-target convenience but matches the design's pure factory model. Fixture configs migrate to specify paths.

Document the change clearly in the migration section of the doc sweep.

**Risk:** medium-high. First phase to implement the factory pattern; load-bearing for all subsequent phases. The filesystem path defaulting compromise needs operator validation.

**SOLID:**
- SRP: each factory owns one provider's construction
- OCP: new built-in storage = new factory file
- LSP: every factory returns a `StorageProvider`; substitutable
- ISP: operator imports only the factories they use
- DIP: `targets.ts` depends on `StorageProvider` interface; concretions injected via factories

### Phase 2 — Transform migration (3 days)

**Files added:**
- `sharpAdapter(opts?: SharpAdapterOptions): TransformAdapter`
- `cloudflareAdapter(opts: CloudflareAdapterOptions): TransformAdapter`

**Files modified:**
- `packages/gazetta/src/types.ts`:
  - `TargetConfig.transforms: TransformAdapter` (was `TransformConfig`)
  - Delete `TransformConfig` interface
- `packages/gazetta/src/transforms/index.ts`:
  - Delete `buildTransformAdapter(target)` switch dispatch
  - `target.transforms` is already a `TransformAdapter` instance
- `packages/gazetta/src/index.ts`:
  - Export `sharpAdapter`, `cloudflareAdapter`
  - Keep existing `createCloudflareAdapter` and `sharpAdapter` const (per G5'a)
- Fixture configs (none use transforms today per pre-flight; no migrations needed)
- Docs: transform-section examples in `docs/transform-adapters.md`, design docs

**Tests:** Unit tests per factory; integration tests unchanged.

**Risk:** medium. Pattern repeats Storage; less novel.

**SOLID:** same as Phase 1.

### Phase 3 — Cache migration (3 days)

**Files added:**
- `memoryCache(opts?: MemoryCacheOptions): AdminCache`

**Files modified:**
- `packages/gazetta/src/types.ts`:
  - `SiteManifest.cache: AdminCache` (was nested under `admin.cache: CacheSiteConfig`)
  - Delete `CacheSiteConfig` interface; delete `MemoryCacheConfig` interface (parameter type lives on factory signature)
  - Move `cache:` from `admin.cache` to top-level on `SiteManifest` (simpler — admin block was an artifact of the loose-record schema)
- `packages/gazetta/src/cache/memory.ts`:
  - Existing `createMemoryCache(opts)` stays — operator-facing `memoryCache` wraps it
- `packages/gazetta/src/config/loader.ts`:
  - `applyGazettaDefaults` rewrites: `defaults.cache` is now raw options (Exception A); apply via per-site factory call
  - When site doesn't override `cache:`, loader builds `memoryCache(defaults.cache.memory)` per site
- `packages/gazetta/src/config/schemas.ts`:
  - Tighten `defaults.cache` Zod from `z.record(z.string(), z.unknown())` to typed shape (matches Exception A's raw-options shape)
- `packages/gazetta/src/index.ts`:
  - Export `memoryCache`

**Files updated (fixture configs):**
- `packages/gazetta/tests/fixtures/configs/with-global/gazetta.config.ts` — uses `defaults.cache` raw options shape
- Any site config explicitly setting `cache:` (none today; `cache` foundation just shipped Cuts 1-2 with no operator consumer yet)

**Tests:**
- Unit: `memoryCache` factory accepts opts, returns `AdminCache`
- Integration: defaults inheritance — site without `cache:` builds from `gazetta.config.ts defaults.cache` raw options
- Existing cache tests (cache-keys, cache-memory) unchanged

**Risk:** medium. Exception A's per-site-instance-from-shared-defaults logic in the loader is the load-bearing piece.

**SOLID:** same as Phase 1.

### Phase 4 — AI migration (1 week)

Phase 4 implements the two-axis split (transport vs task config) and three-rung inheritance (gazetta → site → target) per `design-provider-config.md` Exception B + `design-ai.md` "Two-axis split."

**Files added:**
- `anthropicProvider(opts: AnthropicTransportOptions): AIProvider`
- `openaiProvider(opts: OpenAITransportOptions): AIProvider`
- `ollamaProvider(opts: OllamaTransportOptions): AIProvider`
  - Each takes transport-only fields: `apiKey`, optional `baseUrl`, optional `organizationId`, optional `timeout`. Does NOT take `model` or `defaultModel`.
- `AIProvider` interface narrowed to transport + per-task builders:
  - `.altText(taskConfig: AltTextTaskConfig): AltTextAdapter`
  - (future) `.translation(taskConfig: TranslationTaskConfig): TranslationAdapter`
- `AltTextTaskConfig` data-literal type: `{ model: string; systemPrompt?: string; maxTokens?: number }`. The `model` field is non-optional at adapter construction (resolver always supplies); operator-facing data-literal blocks make it optional and fall back via the chain.
- `PROVIDER_DEFAULT_MODELS: Record<string, string>` exported from `ai/provider.ts` — anthropic → claude-haiku-4-5, openai → gpt-4o-mini, ollama → llama3.2-vision.

**Files modified:**
- `packages/gazetta/src/types.ts`:
  - `GazettaManifest.ai?: { provider?: AIProvider; model?: string }` (new — gazetta-level cross-task)
  - `GazettaManifest.altText?: { systemPrompt?: string; maxTokens?: number }` (new — gazetta-level per-task)
  - `SiteManifest.ai?: { provider?: AIProvider; model?: string }` (replaces current `AIConfig`)
  - `SiteManifest.altText?: { systemPrompt?: string; maxTokens?: number }` (replaces current `AltTextSiteConfig`)
  - `AltTextTargetConfig` reshape: behavior fields at root (`auto?: boolean`, `maxImageEdge?: number`); new `ai?: { provider?: AIProvider; model?: string; systemPrompt?: string; maxTokens?: number }` sub-block. Drop top-level `model?: string` field (was Exception B's old single-rung shape; now lives inside `ai` sub-block).
  - Delete `AIConfig` and `AltTextSiteConfig` interfaces (replaced by anonymous shapes above for clarity).
- `packages/gazetta/src/alt/config.ts` — resolver rewrite per `design-ai.md` "Three-rung inheritance":
  ```ts
  export function resolveAltAdapter(
    gazetta: GazettaManifest | undefined,
    site: SiteManifest,
    target: TargetConfig,
  ): AltTextAdapter | null {
    const provider = target.altText?.ai?.provider ?? site.ai?.provider ?? gazetta?.ai?.provider
    if (!provider) return null
    const model = target.altText?.ai?.model ?? site.ai?.model ?? gazetta?.ai?.model ?? PROVIDER_DEFAULT_MODELS[provider.name]
    const systemPrompt = target.altText?.ai?.systemPrompt ?? site.altText?.systemPrompt ?? gazetta?.altText?.systemPrompt
    const maxTokens = target.altText?.ai?.maxTokens ?? site.altText?.maxTokens ?? gazetta?.altText?.maxTokens
    return provider.altText({ model, systemPrompt, maxTokens })
  }
  ```
  Per-field chain (not per-block); each field independently inherits gazetta → site → target.
- `packages/gazetta/src/alt/factory.ts` — `buildAltAdapter(gazetta, site, target)`: thin wrapper that delegates to `resolveAltAdapter` + behavior-field reading (`auto`, `maxImageEdge` from target.altText root or site default). Removes string-discriminator dispatch entirely.
- Each AI provider package (`alt/anthropic.ts`, `alt/openai.ts`, `alt/ollama.ts`):
  - Constructor takes transport only
  - `.altText(taskConfig)` method on returned `AIProvider` instance constructs an `AltTextAdapter` carrying the task config (model + systemPrompt + maxTokens)
  - Internal `create*AltAdapter(transport, taskConfig)` factories unchanged in shape; called by the per-task builder method
- `packages/gazetta/src/alt/suggester.ts` (or equivalent) — operator's `systemPrompt` prepend logic per `design-ai.md` "Prompt composition":
  ```ts
  const operatorPrompt = adapter.config.systemPrompt
  const systemComposed = composePrompt(request, DEFAULT_POLICIES)
  const finalPrompt = [operatorPrompt, systemComposed].filter(Boolean).join('\n\n')
  ```
  Adapters expose their config (or a `getSystemPrompt(): string | null` method) so the suggester can read it.
- `packages/gazetta/src/index.ts`:
  - Export `anthropicProvider`, `openaiProvider`, `ollamaProvider`
  - Export `PROVIDER_DEFAULT_MODELS`
  - Keep existing `createAnthropicAltAdapter` etc. exports (per G5'a)

**Files updated (fixture configs):**
- Any fixture using `ai:` or `altText:` (none today per pre-flight; all commented-out in starter)

**Files updated (docs):**
- `.claude/rules/design-ai.md`, `.claude/rules/design-ai-implementation.md` — operator examples (already updated in Phase 0)
- `docs/content-assets.md` — operator-facing AI alt config example

**Tests:**
- Unit: each AI provider factory + per-task builder method
  - `anthropicProvider({apiKey: 'sk-...'})` returns `AIProvider` with `name === 'anthropic'`
  - `provider.altText({model: 'claude-haiku-4-5'})` returns `AltTextAdapter` with stored model
  - `provider.altText({model: 'X', systemPrompt: 'voice'})` returns adapter that emits `voice\n\n<system-composed>` as final prompt at suggest time
- Resolver chain tests:
  - Gazetta-only — site and target have no AI config; resolver picks gazetta's provider/model/systemPrompt
  - Site overrides gazetta — site.ai.model wins; gazetta's systemPrompt still inherits because site.altText is empty
  - Target overrides site — target.altText.ai.model wins; gazetta/site systemPrompt still inherits because target.altText.ai.systemPrompt is empty
  - Per-field chain — site sets only altText.systemPrompt; provider+model still inherit from gazetta
  - Empty chain — no AI configured anywhere; resolver returns null
  - Default model fallback — provider configured but no model anywhere in chain; resolver uses `PROVIDER_DEFAULT_MODELS[provider.name]`
- systemPrompt prepend semantics:
  - Operator systemPrompt set → prepended to system-composed
  - Operator systemPrompt absent → only system-composed
  - Empty string operator systemPrompt → treated as absent (filter(Boolean))
- Per-target provider override:
  - Site uses Anthropic; target uses OpenAI via `targets.X.altText.ai.provider: openaiProvider(...)` — resolver returns OpenAI adapter
- Capability negative test:
  - Hypothetical `AIProvider` impl missing `.altText` method → TypeScript error at config-eval (interface enforcement)
- Existing tests in `tests/alt-config-resolver.test.ts`, `tests/alt-factory.test.ts`, `tests/alt-anthropic.test.ts`, `tests/alt-openai.test.ts`, `tests/alt-ollama.test.ts` rewritten to construct providers via the new shape and assert per-rung inheritance
- Existing tests in `tests/admin-api-suggest-alt.test.ts` use `loadSite({ manifest: {...} })`; need updates for the new manifest shape (data-literal `ai:` block carrying provider instance)

**Tricky bit — capability interfaces deferred:**

Earlier draft considered `AltTextCapableProvider extends AIProvider` for plugin extensibility. With three v1.5 providers all implementing `.altText`, the capability split adds surface without earning value yet. **Phase 4 ships the simpler form**: `AIProvider` declares `.altText(taskConfig): AltTextAdapter` as a required method; all three providers implement it. Capability interfaces (`AltTextCapableProvider`, `TranslationCapableProvider`) become a Phase 5+ design open question — formalize when the second AI task (translation) ships and proves the abstraction is needed.

**Tricky bit — `gazetta.config.ts` loading and three-rung resolution timing:**

The resolver needs access to the gazetta-level config at boot. `defineGazetta()` exists per `design-config.md`; the config loader reads `gazetta.config.ts` at project root before site config. Phase 4 wires the gazetta manifest into the resolver call site (currently most resolver calls have access to site only). Specifically:
- `loadSite({ manifest: SiteManifest })` extends to `loadSite({ gazettaManifest?: GazettaManifest, siteManifest: SiteManifest })` — the optional gazetta layer threads through
- Capability resolvers in `admin-api/routes/targets.ts` and the suggest-alt route call `resolveAltAdapter(gazetta, site, target)` instead of the current two-arg form
- Gazetta manifest is loaded once at boot, cached in module scope; per-target resolver call composes against the cached gazetta + per-request site/target

**Risk:** high. Largest single phase. Two-axis split + three-rung inheritance + transport/task-config interface change + provider constructor signature change + resolver rewrite + admin-api wiring all converge here.

**SOLID:**
- SRP: provider constructor owns transport; `.altText()` builder owns per-task config storage; resolver owns chain composition; suggester owns prompt prepend. Each module changes for one reason.
- OCP: new AI task (translation) adds `.translation()` method to `AIProvider` + new `TranslationTaskConfig` data-literal type + new resolver function. Existing providers add the method; existing tasks untouched.
- LSP: all three providers implementing `AIProvider` are substitutable in the resolver; per-task adapters (`AltTextAdapter`) are substitutable across providers.
- ISP: `AIProvider` interface stays narrow (transport identity + per-task builder methods). Per-task adapter interfaces are independent.
- DIP: resolver depends on `AIProvider` abstraction, not on Anthropic/OpenAI/Ollama concrete classes. Suggester depends on `AltTextAdapter` abstraction, not on per-provider adapter classes.

### Phase 5 — Layer 1 typing cleanup (3 days)

**Files modified:**
- `packages/gazetta/src/types.ts`:
  - Add typed `GazettaManifest` interface mirroring `GazettaConfigSchema` shape (with typed sub-blocks where foundations exist; loose `Record<string, unknown>` where foundations don't ship yet)
  - `SiteManifest` cleanup: remove top-level `locale` field (locale-shape change — hard cutover per ADR-0005)
  - `LocalesConfig.default?: string` field added (per Path X locale-shape change)
  - Drop unused or stale fields surfaced during the migration
- `packages/gazetta/src/config/define.ts`:
  - `defineSite<const T extends SiteManifest>(config: T): T` — add `<const T>` modifier
  - `defineGazetta<const T extends GazettaManifest>(config: T): T` — add `<const T>` + tighten constraint
- `packages/gazetta/src/config/types.ts`:
  - Drop public `SiteConfig` and `GazettaConfig` z.infer-derived aliases (or rename to `LoadedSiteConfig`, `LoadedGazettaConfig` and demote to internal)
- `packages/gazetta/src/config/loader.ts`:
  - `validateSiteConfig` returns `SiteManifest` directly (cast through unknown at validation boundary)
  - Drop `siteConfigToManifest()` if its only purpose was the cast (callers receive `SiteManifest` from validate)
- `packages/gazetta/src/config/index.ts`, `packages/gazetta/src/index.ts`:
  - Drop public `SiteConfig`/`GazettaConfig` re-exports
- `packages/gazetta/src/locale.ts`:
  - `defaultLocaleFor()`: read `site.locales?.default ?? site.locales?.supported?.[0] ?? 'en'`
- Fixture configs:
  - Migrate `defaultLocale: 'x'` + `locales: { supported: [...] }` → `locales: { default: 'x', supported: [...] }`

**Tests:**
- Type-equality tests in `tests/config-types.test.ts`:
  - `expectTypeOf<typeof cfg.targets.production.environment>().toEqualTypeOf<'production'>()` — proves `<const T>` literal preservation
  - `expectTypeOf<typeof cfg.targets.local.storage>().toMatchTypeOf<StorageProvider>()` — proves field type
- Locale resolution test: `locales: { supported: ['en', 'fr'] }` → default = 'en'; `locales: { default: 'fr', supported: ['en', 'fr'] }` → default = 'fr'

**Risk:** medium. Layer 1 work was always going to ship; bundles cleanly with locale-shape change since both touch SiteManifest.

**Bundling note:** locale-shape change (`locales: { default?, supported }`) is a small adjacent concern bundled into Phase 5 because both touch `SiteManifest`/`types.ts`. If reviewers prefer separate commits, Phase 5 can split into 5a (typing cleanup) + 5b (locale shape) with no scope-overlap concerns.

**SOLID:**
- SRP: `defineSite`/`defineGazetta` are single-purpose identity functions
- DIP: consumers depend on `SiteManifest`/`GazettaManifest` typed interfaces

### Phase 6 — Doc sweep (3-5 days)

**Files modified:**
- `.claude/rules/design-{i18n,themes,publishing,validation,collaboration,offline,cache,hooks,plugins,ai,ai-implementation,media,rendering,scale,auth-rbac,audit,config}.md` — sweep operator-config examples to factory style; ~13 files
- `docs/{getting-started,cloudflare,self-hosted,migration,template-assets,content-assets,transform-adapters}.md` — public docs sweep
- `docs/adr/0004-pluggable-provider-pattern.md` — header update reaffirming supersession scope (operator-config-shape only; universal requirements preserved)
- `.claude/rules/configurations.md`, `.claude/rules/hosting.md`, `.claude/rules/operations.md`, `.claude/rules/cli.md` — example sweeps
- New: plugin authoring guide section in `design-plugins.md` (or separate `docs/plugin-authoring.md`)

**Tests:** none directly; manual review of examples for correctness.

**Risk:** low. Mechanical sweep after code is stable.

## Validation gate (definition of done)

- [ ] All 6 phases shipped
- [ ] All ~13 design docs reflect factory-call operator config (no `provider: 'name'` literal examples remaining for the 4 migrated surfaces)
- [ ] All public docs reference factory style
- [ ] `examples/starter` runs from factory-style config
- [ ] `gazetta init` scaffolds factory-style config (bundled into Phase 6 doc sweep — `gazetta init` template lives in starter and is updated as part of starter migration in Phase 1; reaffirmed in Phase 6 docs)
- [ ] Test coverage: every operator-facing factory has unit tests; every fixture config type-checks under `<const T>`
- [ ] No public exports of pre-cutover types (`SiteConfig` z.infer-derived; `StorageConfig`; `TransformConfig`; `CacheSiteConfig`; `AIConfig`; `AltTextSiteConfig`)
- [ ] CHANGELOG entry: "Breaking: provider config shape changed; operators write factory calls"

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `gazetta migrate-providers` CLI | None planned. Pre-1.0 product per ADR-0005 precedent (`gazetta migrate-config` was promised in ADR-0005 but never built). Operators rewrite by hand. |
| Build-time JSON precompile (`gazetta build:config`) reshape | Cold-start latency pain on cloud deployments; design pass when concrete demand surfaces. Three approaches sketched in `design-provider-config.md` open question 1. |
| Plugin foundation runtime integration | Plugin foundation ships (deferred indefinitely until cross-site shared-extension demand). Provider factories from plugins compose with this design without changes. |
| Per-locale provider variants | Concrete demand. Pattern 2 generalizes; not enabled today. |
| Per-target provider/credentials override (non-AI surfaces) | Workaround exists (per-target factory call for storage/transform); add explicit syntax only if a real pattern emerges. AI gets per-target via Exception B's `altText.ai` sub-block. |
| `dispose()` lifecycle for providers on hot reload | Provider author reports resource-leak issues from hot reload. Accept G7'a churn until then. |
| AI capability-interface formalization (`AltTextCapableProvider`, `TranslationCapableProvider`) | Translation v1.6 lands. Phase 4 ships `AIProvider.altText()` as a required method on the base interface — capability split deferred until second AI task proves the abstraction is needed. |
| Custom prompt policies (operator replaces WCAG-grounded base) | Operator with editorial style guide differs enough from WCAG default. Per-site or per-task config field threaded through resolver to override `DEFAULT_POLICIES` in `composePrompt(req, policies)`. |

## Open implementation questions

1. **Filesystem `path` defaulting** — Phase 1's tricky bit. The design doc locks "(a) operator specifies path explicitly" but UX-test the fixture migration: is the loss of auto-naming-from-target painful enough to warrant a workaround? Decide at Phase 1 implementation.

2. **`AdminCache` SSE subscribe lifecycle on hot reload** — Phase 3 ships `memoryCache()` factory; Cut 4 of `design-cache-implementation.md` will eventually wire SSE. Hot reload reconstructs the cache; SSE handlers re-subscribe. Verify no leak.

3. **AI `AIProvider` discriminator field** — locked: `AIProvider.name: string` (e.g., `'anthropic'`, `'openai'`, `'ollama'`, plugin name) is required on the interface. Resolver reads `provider.name` to look up `PROVIDER_DEFAULT_MODELS[provider.name]` when the model chain falls through. Plugin providers contribute their own name; default-model fallback for unknown plugin names returns the chain's terminal undefined (operator must specify `model` somewhere in the chain — same failure mode as omitting an apiKey).

4. **Plugin provider's factory return type** — does the field accept `StorageProvider` from any source, or must the source be Gazetta-blessed? Per the design, ANY object satisfying `StorageProvider` works — TypeScript structural typing. No "blessed" mechanism. Plugin authors who get the interface wrong fail at type-check time.

5. **Internal `create*` factory exports** — keep public exports per G5'a, but DO they get marked `@internal` in JSDoc to discourage operator use in `site.config.ts`? Plugin authors using them is fine; operators doing so bypasses the validation/env-var-resolution layer. Recommend `@internal` JSDoc tag without breaking exports.

## Test infrastructure

- **Type-equality tests** in `tests/config-types.test.ts` use Vitest's `expectTypeOf` (existing pattern from `tests/schema-content.test.ts`)
- **Factory unit tests** per surface — happy path, validation failures, env-var sentinel resolution
- **Integration tests** unchanged — `loadSite({ manifest })` accepts `SiteManifest` with pre-constructed Provider instances; tests inject mock providers via this path

## Estimates

Wall-clock for solo dev:

| Phase | Estimate |
|---|---|
| 0 (Design pass) | 1 week |
| 1 (Storage) | 1 week |
| 2 (Transform) | 0.5 week |
| 3 (Cache) | 0.5 week |
| 4 (AI) | 1 week |
| 5 (Layer 1 + locale) | 0.5 week |
| 6 (Doc sweep) | 0.5 week |

**Total: ~5 weeks.** With CI iteration + integration discoveries + grilling rounds, budget ~6-7 weeks realistic.

## SOLID checks per phase

Each phase preserves SOLID 5/5:

- **Phase 1**: SRP per factory; OCP open for new built-ins via new factory file; LSP across all storage providers; ISP narrow factory imports; DIP `targets.ts` depends on `StorageProvider` abstraction.
- **Phase 2**: Same shape; transforms repeats Storage's pattern.
- **Phase 3**: Same; Exception A's defaults logic in loader is SRP — defaults application is one concern.
- **Phase 4**: Capability interfaces (per-task) preserve ISP; `AIProvider` stays narrow; per-task adapters (`AltTextAdapter`, `TranslationAdapter`) are independent surfaces.
- **Phase 5**: Identity functions are SRP; `<const T>` is type-system mechanism, no architectural impact.
- **Phase 6**: docs only.

Any phase failing SOLID review at PR time is a structural correction (per [team-preferences rule 18](team-preferences.md)), not a patch — amend before merge.

## Migration

### Existing sites

Pre-cutover `site.config.ts` files don't type-check after this PR sequence merges. Operators rewrite per the migration section of `design-provider-config.md`. No coexistence period; no compat shims; per ADR-0005 precedent.

The repo's 10 fixture configs migrate as part of phases 1-4 (each phase migrates fixtures for its surface).

### `gazetta init` scaffolding

`gazetta init` template (per Cut 9 of TS config migration) ships factory-style config in the scaffolded site. Update happens in phase 6 (doc sweep) or as part of the relevant per-surface phase, whichever lands first.

### CHANGELOG

Single entry covering the full PR sequence:
> Breaking: provider configuration uses factory calls returning Provider instances. Operators rewrite `site.config.ts` per `design-provider-config.md`'s migration section. Locale config also unified to `locales: { default?, supported }` shape.

## Branch + PR posture

- Branch: `provider-config-v1` off `main` (after Phase 0 design merges)
- Each phase is its own PR for reviewability
- All PRs target `provider-config-v1` rather than `main`; final merge is one commit to `main` once all phases are green
- Alternative: each phase ships directly to `main` (per the project's preference for linear small PRs); requires that intermediate states between phases compile
  - Phase 1 leaves `TransformConfig`/`CacheSiteConfig`/`AIConfig` still alive — they should still type-check
  - This is feasible but means each PR carries the migration burden for its surface; cleaner narrative
  - **Recommend small-PRs-to-main per the project's preference; intermediate states tested per-phase**

## Cross-phase dependencies

- Phase 1 (Storage) is foundational — establishes the pattern; Phases 2-4 follow it
- Phase 5 (Layer 1) can run in parallel with 1-4 OR after; choose based on review bandwidth
- Phase 6 (Doc sweep) sequentially last

Phases 2-4 don't depend on each other strictly, but each surface migration introduces breakage to that surface's consumers. Sequencing matters less than ensuring each phase ships green CI.
