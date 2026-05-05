# Provider factory returns instance for operator-facing config

> Full architectural model + per-surface details + foundational checks live in [`.claude/rules/design-provider-config.md`](../../.claude/rules/design-provider-config.md). Phased implementation cuts in [`.claude/rules/design-provider-config-implementation.md`](../../.claude/rules/design-provider-config-implementation.md). This ADR captures the load-bearing decision; the design doc captures everything else.

Operators configure Provider surfaces (Storage, Transform, Cache, AI, future Audit / Auth / Notification / Deploy) by calling factory functions inside `defineSite({...})` and `defineGazetta({...})`. Each factory **returns a constructed Provider instance**; the field's TypeScript type is the runtime Provider interface (`StorageProvider`, `TransformAdapter`, `AdminCache`, `AltTextAdapter`, etc.). There is no operator-facing config-data layer; the factory call IS the configuration.

```ts
// Operator writes
storage: r2Storage({ bucket, accountId, accessKeyId, secretAccessKey })

// At config-eval, evaluates to a constructed StorageProvider instance.
// Field type: StorageProvider.
```

We picked this over the alternatives evaluated (closed discriminated union with literal config; factory returning marked-config object; registry + module augmentation; helper-modifier patterns) because it scores 5/5 on SOLID across all five lenses, presents a single canonical operator syntax, and minimizes the plugin-author obligation to "export a factory returning the provider interface" — no registry augmentation, no separate registration step. The cost is build-time JSON precompile (`gazetta build:config` from `design-config.md` "Future directions") becomes incompatible with this shape and reshapes when v1.5 design pass starts; and that ADR-0004's operator-config-shape requirement (`provider: 'name'` literal blocks) is superseded.

We picked factory-returns-instance over factory-returns-marked-config because the marked-config layer added an indirection (operator config → boot dispatch → runtime instance) without earning its keep — every alternative we considered with a config-data layer ended up with permanent "two ways to do it" tension OR forced the literal escape to remain valid (operator-facing API surface that we can't deprecate without a breaking change). Factory-returns-instance mechanically blocks the literal shape — field type is the runtime interface, not a config object — which closes the API surface to one canonical syntax permanently.

We picked the factory-call ergonomic over keeping today's `provider: 'name'` literal shape (ADR-0004's mandate) because per-variant autocomplete, edit-time validation, plugin extensibility without a registry mechanism, and alignment with mature TypeScript-first ecosystem patterns (Vite plugins, Astro integrations, Sanity definePlugin) compound into a meaningfully better operator experience. ADR-0004's eight Universal Provider Requirements (multi-instance correctness, env-var credentials, fail-mode declared, never-throw-on-transport-errors at recording layer, stable typed contract, independent error taxonomy, sensible defaults, stateless interface) describe Provider INTERNALS and are preserved unchanged. Only ADR-0004's operator-facing config-shape consequence is superseded.

## Consequences

Operator-facing config across all Provider surfaces is **factory calls**. Field types are runtime interfaces. Each of the four shipped Pattern-A surfaces (Storage, Transform, Cache, AI) and each future surface (Audit, Auth, Notification, Deploy) follows one of three patterns reflecting the surface's structural axis count:

- **Pattern 1 — Single-axis (direct factory at field)** for surfaces with one axis (which provider variant): Storage, Transform, Cache, Auth, Deploy — `storage: r2Storage({...})`.
- **Pattern 2 — Multi-axis (transport × task) via two-layer split** for AI: `ai: { provider: anthropicProvider({...}), model: 'claude-haiku-4-5' }` cross-task transport + model; `altText: { systemPrompt, maxTokens }` per-task config; per-target `altText.ai` data-literal sub-block for environment-specific overrides. The `AIProvider` interface is transport-only (apiKey, baseUrl, etc.); per-task config (model, systemPrompt, maxTokens) lives in data-literal blocks the resolver feeds to `provider.altText({...})` at boot.
- **Pattern 3 — Multi-provider fan-out with cross-cutting settings** for surfaces composing multiple providers: Audit, Notifications — `audit: auditChain([historyAudit(), cloudwatchAudit({...})], { strict: false })`.

Two narrow data-layer exceptions are accepted (one fewer than earlier drafts of this ADR — Exception A collapsed under the locked **single-Site-per-process invariant** documented in `CONTEXT.md`):

- **Exception A** (AI task config across rungs): AI task config (model, systemPrompt, maxTokens) is a data-literal across rungs (gazetta-level → site-level → target-level). Per-target `altText.ai` sub-block accepts `provider` (factory-call), `model`, `systemPrompt`, `maxTokens` (data literals). Justified structurally: AI is the only Pattern-A surface that multiplexes one transport across multiple distinct request shapes (alt-text, translation, summarization, image-gen) with operator-tunable per-task config. Each rung carries documented operator value (gazetta-level for agency multi-Project setups with shared editorial voice; site-level for per-Site brand voice; target-level for environment-specific tuning). See `design-provider-config.md` "Why AI is the outlier" for the structural test that determines Exception A eligibility — Search would qualify if shipped; Storage/Transform/Cache/Audit/Auth/Notification/Deploy don't.
- **Exception B** (per-target behavior-only overrides): `targets.X.altText: { auto: false, maxImageEdge: 1024 }` are partial literals for runtime knobs the suggester reads per call — semantically distinct from AI task config because they don't flow into adapter construction.

**Why no per-Site-instance exception for cache:** earlier drafts carried an "Exception A" specifically for `gazetta.config.ts defaults.cache` to accept raw options so multiple Sites in one process would each build their own per-Site cache instance. The single-Site-per-process invariant (locked in `CONTEXT.md`) makes this unnecessary — each process loads exactly one Site, so a constructed cache instance at gazetta level is fine: every process re-evaluates `gazetta.config.ts` and gets a fresh instance. `defaults.cache` accepts a factory result like every other field (`memoryCache({...})`), and the single-Site sees it directly. No isolation concern, no per-Site re-instantiation, one canonical syntax.

Build-time JSON precompile (`gazetta build:config`, v1.5 reserved per `design-config.md`) is incompatible with factory output; reshape deferred to v1.5 design pass. Three approaches sketched in `design-provider-config.md` open question 1.

Migration is hard cutover per ADR-0005 precedent. No coexistence period; no compat shims; no `gazetta migrate-providers` CLI (matching ADR-0005's deferred migration tool). Operators rewrite `site.config.ts` per the migration section of `design-provider-config.md`.

Plugin authors shipping a Provider write a factory function returning the provider interface. No registry interface augmentation. No registration ceremony. Operator imports the factory and invokes it; the field accepts the returned instance because the field type is the runtime interface, not a closed union. When the Plugin foundation (`design-plugins.md`) ships, it composes orthogonally — plugin packages register hooks/validators/routes/capabilities AND export provider factories; the two surfaces don't interfere.

Hot reload (dev only) reconstructs all providers when `site.config.ts` changes. Provider authors document any construction-time side effects; convention is that providers build SDK config objects at construction time and defer network/auth to first method call. `gazetta validate` constructs providers but doesn't trigger SDK side effects per this convention.

Locale config is unified to `locales: { default?, supported }` shape (matching the existing `themes: { default?, supported }` convention); the previous top-level `defaultLocale` field is removed in the same migration.
