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

# Provider config — design

How operators configure providers (Storage, Transform, Cache, AI, future Audit / Auth / Notification / Deploy) in `site.config.ts` and `gazetta.config.ts`. The operator-facing shape is **factory calls returning fully-constructed Provider instances**; the field type is the runtime Provider interface (`StorageProvider`, `TransformAdapter`, `AdminCache`, `AltTextAdapter`, etc.).

**Status**: design pass in progress (2026-05). Reference doc, not a foundational dimension. Captures the operator-facing config shape and the rationale; the format is set once and doesn't recur in feature designs.

**Companion docs**:
- [`design-provider-config-implementation.md`](design-provider-config-implementation.md) — phased cut sequence per surface
- [`docs/adr/0008-provider-factory-returns-instance.md`](../../docs/adr/0008-provider-factory-returns-instance.md) — load-bearing decision
- [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md) — Universal Provider Requirements (preserved); operator-config-shape requirement (superseded by ADR-0008)
- [`docs/adr/0005-typescript-config-format.md`](../../docs/adr/0005-typescript-config-format.md) — TS config foundation (defineSite, defineGazetta identity functions)
- [`design-config.md`](design-config.md) — site/global config split, evaluation timing, secrets handling
- [`design-plugins.md`](design-plugins.md) — Universal Provider requirements; plugin foundation contract (deferred)

## Scope

**In:** operator-facing config shape for the provider surfaces — what operators write inside `defineSite({...})` and `defineGazetta({...})`. Single canonical syntax: factory calls.

**Surfaces covered:**
- Storage (per-target)
- Transform Adapter (per-target)
- Cache (site-level admin)
- AI (site-level cross-task base + per-task overrides)
- Future: Audit, Auth, Notification, Deploy — design pattern applies when those foundations ship

**Out of scope:**
- Plugin foundation runtime (registration, lifecycle, dispose) — see [`design-plugins.md`](design-plugins.md)
- Build-time JSON precompile (`gazetta build:config`) — incompatible with factory-returns-instance; reshape deferred to v1.5 design pass
- Operator literal-config escape — mechanically blocked under this design; one canonical syntax only
- Migration tooling — pre-1.0 product per ADR-0005; operators rewrite by hand

**Non-goals:**
- Two-way config (literal AND factory) — single canonical syntax, period
- Config introspection via JSON.stringify — factory output is live instances; not serializable
- Config-shape consistency with ADR-0004's `provider: 'name'` mandate — this design supersedes that requirement

## Distinctive choices

### 1. Factory returns Provider instance, not config-data

```ts
// What operator writes
storage: r2Storage({ bucket, accountId, accessKeyId, secretAccessKey })

// What the call evaluates to
storage: <constructed StorageProvider instance>

// Field type
storage: StorageProvider
```

The factory **constructs** the provider at config-eval time. Field type is the runtime interface. There is no intermediate config-data layer.

**Rejected alternatives:**

- **Closed disc union with literal config** (η path): operators write `{ type: 'r2', ... }`; runtime dispatches on discriminator. SOLID 3-4/5; permanent literal-shape API surface; "two ways to do it" tension if factories layered on top.
- **Factory returns marked config** (Solution 4 / locked plan we abandoned): `r2Storage({...})` returns `{ type: 'r2', ... }`. SOLID 5/5; preserves serialization; preserves dispatch layer. Multi-axis surfaces require composition (`altText: { ai: openaiProvider({...}), auto: true }`) or modifier helpers. Two layers (config-data + runtime) maintained.
- **Helper factories with shared union** (Solution 3 from 7-alternatives audit): registry interface + module augmentation for plugin extensibility. Type-system extensibility without runtime mechanism is theater while plugin foundation is unshipped.

**Why factory-returns-instance wins:**
- SOLID 5/5 (cleanest of all alternatives evaluated)
- Single canonical syntax — mechanically enforced by field type being the runtime interface
- Smallest plugin-author obligation: just export a factory returning the provider interface; no registry augmentation, no registration ceremony
- Operator-input validation throws at config-eval (missing required fields, malformed sentinel strings); SDK side effects deferred to first method call (per provider author convention) so `gazetta validate` stays fast
- Aligns with mature TypeScript-first ecosystem patterns (Vite plugins, Astro integrations, Sanity definePlugin)

**The cost:**
- Build-time JSON precompile (`gazetta build:config`, v1.5 reserved) impossible without reshape
- Config introspection via `JSON.stringify` produces nothing useful for provider fields
- Hot reload reconstructs providers (resource churn; acceptable for dev-only)
- ADR-0004's operator-config-shape mandate (`provider: 'name'`) superseded

### 2. Three patterns reflecting surface dimensionality

Surface-by-surface analysis revealed three distinct config-shape patterns. Each pattern matches the surface's structural axis count.

**Pattern 1 — Single-axis (direct factory at field):**
```ts
storage: r2Storage({...})
transforms: cloudflareAdapter({...})
cache: memoryCache({...})
```
Surfaces with one axis (which provider variant). Field-level factory call.

**Pattern 2 — Multi-axis (transport × task) via two-layer split:**
```ts
const anthropic = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })

ai: { provider: anthropic, model: 'claude-haiku-4-5' }   // cross-task transport + model
altText: { systemPrompt: 'editorial voice', maxTokens: 300 }  // per-task config
// future: translation: { systemPrompt: '...', maxTokens: 500 }
```
The `AIProvider` interface is **transport-only** (apiKey, baseUrl, timeout — credentials and endpoint identity). Per-task **operational config** (model, systemPrompt, maxTokens) lives in data-literal blocks at the site root. The `provider` field inside the `ai:` block is always a factory call (Path X); the surrounding fields and the `altText:` task block are data literals. Three-rung inheritance (gazetta → site → target) carries provider/model/systemPrompt/maxTokens independently — see Exception B below for the rationale.

**Pattern 3 — Multi-provider fan-out with cross-cutting settings:**
```ts
audit: auditChain([
  historyAudit(),
  cloudwatchAudit({ logGroup: 'gazetta-audit' }),
], { strict: false, actorPseudonym: 'sha256' })
```
Surfaces that compose multiple providers (audit, notifications) with cross-cutting settings. `auditChain` factory wraps array + opts; returns a single provider implementing the surface interface.

These patterns are **principled heterogeneity** — each shape reflects a structural property of its surface. Operator learns three patterns (one per dimensionality class); each pattern is consistent within its surface family.

### 3. Two narrow data-layer exceptions

The "no config-data layer" principle has two pragmatic exceptions:

**Exception A — Defaults inheritance in `gazetta.config.ts`:**
```ts
defaults: {
  cache: { provider: 'memory', maxEntries: 5000 }  // RAW OPTIONS, not factory call
}
```

`defaults.cache` accepts raw options instead of a factory call. Reason: `AdminCache` requires per-site instances (`design-cache.md` Gap 3 lock). If `defaults.cache` were a constructed instance, every inheriting site would share that instance, violating per-site isolation. Raw options let each site's loader construct its own instance from the inherited defaults.

This is a **single-slot exception** for inheritance semantics. Sites that don't inherit don't see this layer.

**Exception B — AI task config across three rungs (gazetta / site / target):**
```ts
// gazetta.config.ts (cross-site)
defineGazetta({
  ai: { provider: anthropic, model: 'claude-haiku-4-5' },
  altText: { systemPrompt: 'editorial voice', maxTokens: 300 },
})

// site.config.ts (per-site)
defineSite({
  ai: { provider: openai, model: 'gpt-4o-mini' },         // overrides gazetta
  altText: { systemPrompt: 'site-specific voice' },        // overrides gazetta task
  targets: {
    production: {
      altText: {
        auto: false,                                       // behavior (Exception C)
        ai: { model: 'gpt-4o', systemPrompt: 'prod voice' },  // task override
      },
    },
  },
})
```

The `ai:` block (gazetta or site level) carries `provider` (factory-call) and `model` (data literal). The per-task block (`altText:` etc.) carries `systemPrompt` and `maxTokens` (data literals). The per-target `altText.ai` sub-block accepts the union (`provider`, `model`, `systemPrompt`, `maxTokens`) for full per-target task tuning.

Why data-literal here? See "Why AI is the outlier" below. Why three rungs? Each has documented operator value: gazetta-level for agency operators running multi-site setups with shared editorial voice + cost ceilings; site-level for per-site brand voice; target-level for environment-specific tuning (prod uses higher-quality model; staging uses cheaper).

Resolver chain (per task — example for `altText`):
- `provider`: `target.altText.ai.provider ?? site.ai.provider ?? gazetta.ai.provider`
- `model`: `target.altText.ai.model ?? site.ai.model ?? gazetta.ai.model ?? PROVIDER_DEFAULT_MODELS[provider.name]`
- `systemPrompt`: `target.altText.ai.systemPrompt ?? site.altText.systemPrompt ?? gazetta.altText.systemPrompt ?? null`
- `maxTokens`: `target.altText.ai.maxTokens ?? site.altText.maxTokens ?? gazetta.altText.maxTokens`

Per-target `ai` sub-block applies its fields atop the inherited chain; absent fields inherit naturally.

**Exception C — Per-target behavior-only overrides:**
```ts
targets: {
  production: {
    altText: { auto: false, maxImageEdge: 1024 }   // behavior fields at root
  }
}
```

`targets.X.altText.auto` and `targets.X.altText.maxImageEdge` are partial literals for **behavior-only fields** — runtime knobs that don't affect adapter construction (the suggester reads them per call). They sit at the root of `altText:` (alongside the `ai:` sub-block from Exception B); semantically distinct from AI task config because they don't flow into provider/adapter construction.

All three exceptions (A, B, C) are honest pragmatic compromises scoped narrowly so the factory-returns-instance principle holds for the dominant case.

### 3a. Why AI is the outlier (and other surfaces aren't)

Path X's default is "operator-facing config is factory calls returning instances." AI is the only Pattern-A surface that earns Exception B (data-literal task config across three rungs). The rationale matters because future surface designers will ask "why can't I do this for X?" — the honest test is structural, not stylistic.

**The structural test for Exception B eligibility:** the surface multiplexes one transport across multiple distinct request shapes that operators legitimately want to tune independently. AI passes because one Anthropic API account serves alt-text, translation, summarization, and image-gen as distinct tasks with different model / prompt / generation params per task. Storage doesn't pass — one R2 bucket isn't multiplexed across "tasks"; per-target storage is full reconfiguration. Transform doesn't pass — the width ladder and adapter config are bundled per-target. Cache doesn't pass — TTL and size limits are per-instance config, not per-task. Audit doesn't pass — the chain composition arg is already a small data-literal exception within Pattern 3, but each provider's transport is still a factory call.

**Inheritance rungs per surface** also reflect structural honesty:

| Surface | Pattern | Transport | Operational config | Inheritance rungs |
|---|---|---|---|---|
| Storage | 1 | Factory-call | (bundled) | 2 (site → target); gazetta default optional via Exception A class |
| Transform | 1 | Factory-call | (bundled) | 2 (site → target) |
| Cache | 1 + Exception A | Factory-call | (bundled) | 2 (site → target); gazetta `defaults.cache` raw options |
| **AI** | **2** | **Factory-call (provider field)** | **Data-literal (model/systemPrompt/maxTokens)** | **3 (gazetta → site → target)** |
| Audit | 3 | Factory-call (chain) | Chain composition arg | 2 (site → target) |
| Auth | 1 | Factory-call | (bundled) | 2 |
| Notification | 1 | Factory-call | (bundled) | 2 |
| Deploy | 1 | Factory-call | (bundled) | 2 |

Three-rung inheritance for non-AI surfaces would add complexity for no documented use case. Operator running multi-site setup wants shared editorial voice for AI (agency setup); operator does NOT want shared R2 bucket across sites (each site has its own storage account). The asymmetry reflects how operators actually configure these surfaces.

**Search reservation.** If a future Search surface ships (currently Tier 3 deferred), it has the same transport-multiplexed-across-tasks property as AI: one Algolia / Typesense / Meilisearch / Elasticsearch account serves multiple indexes (pages, assets, audit log) with per-index config (ranking, faceting, typo tolerance). When/if Search ships, it reuses Pattern 2 + Exception B without widening Path X — same justification, same shape (`search: { provider: searchProvider, ... }; pages: { ranking: ... }; assets: { facets: [...] }`). Documented in advance so future grilling doesn't re-litigate.

**The default for new surfaces is Pattern 1, factory-call, no exceptions.** Surface designers asking "should I do data-literal here?" answer: "only if the surface multiplexes one transport across distinct request shapes that operators tune per-shape." Most surfaces don't.

### 4. Internal `create*` factories stay public

The codebase has internal factories (`createR2Provider`, `createMemoryCache`, `createCloudflareAdapter`, etc.) that take already-resolved options and construct runtime instances. Operator-facing factories (`r2Storage`, `memoryCache`, `cloudflareAdapter`) wrap these — they validate operator input, resolve env-var sentinels, then delegate.

Both layers stay publicly exported:
- Operator-facing: used in `site.config.ts` (the canonical path)
- Internal: used in tests (mocking, instantiation with pre-resolved values), advanced wiring

Naming convention encodes intent:
- `create<Provider><Surface>` — verb prefix; constructs runtime instance from validated options
- `<provider><Surface>` — noun-only; operator-facing factory; produces same runtime instance after validation/resolution

### 5. `<const T>` on identity functions

```ts
export function defineSite<const T extends SiteManifest>(config: T): T { return config }
export function defineGazetta<const T extends GazettaManifest>(config: T): T { return config }
```

The `const` modifier (TS 5.0+) preserves literal types. Without it, `environment: 'production'` widens to `string`, breaking downstream type narrowing. Free addition; matches Sanity / Astro pattern.

### 6. Locale config shape

```ts
locales: { default?: 'en', supported: ['en', 'fr', 'ja'] }
```

Single block. `default` optional; falls back to `supported[0]`. Matches existing `themes: { default?, supported }` shape — establishes the project-wide convention for closed-list dimensional configs.

The previous top-level `defaultLocale` field is removed. Hard cutover per ADR-0005's precedent. Operators with `defaultLocale: 'x'` + `locales: { supported: [...] }` migrate to `locales: { default: 'x', supported: [...] }` by hand.

## Architectural model

### Operator's mental model

> "I describe my site's runtime composition by calling factory functions. Each factory returns a constructed provider. The composition is the configuration."

There is no separate config-as-data step. The factory call IS the configuration. The field's type is the runtime interface; the field's value IS the runtime instance.

### Factory layer (operator-facing)

For each Provider surface, the gazetta package exports operator-facing factories:

- **Storage**: `filesystemStorage`, `r2Storage`, `s3Storage`, `azureBlobStorage`
- **Transform**: `sharpAdapter`, `cloudflareAdapter`
- **Cache**: `memoryCache`
- **AI**: `anthropicProvider`, `openaiProvider`, `ollamaProvider`

Each factory:
1. Accepts typed options (operator-style: env-var sentinels OK; defaults documented)
2. Validates required fields; throws `ConfigError` on bad input
3. Resolves env-var sentinels via existing `resolveEnvVars` utility
4. Delegates to internal `create*` factory with resolved options
5. Returns the constructed runtime instance, typed as the surface interface

Plugin-contributed providers (when plugin foundation ships) follow the same shape: plugin author exports a factory; operator imports + invokes; field accepts the returned instance.

### Field types

| Field | Type | Lifecycle |
|---|---|---|
| `targets.X.storage` | `StorageProvider` | Per-target instance constructed at config-eval |
| `targets.X.transforms` | `TransformAdapter` | Per-target instance |
| `targets.X.altText` | `AltTextTargetConfig` (behavior fields at root + `ai` sub-block data literal) | Resolver builds per-target `AltTextAdapter` from chain at boot |
| `cache` | `AdminCache` | Site-level instance |
| `ai` | `{ provider?: AIProvider; model?: string }` | Site-level (or gazetta-level) cross-task transport + model default |
| `altText` | `{ systemPrompt?: string; maxTokens?: number }` | Site-level (or gazetta-level) per-task config defaults |
| `translation` (future) | `{ systemPrompt?: string; maxTokens?: number; ... }` | Same shape as `altText` for the translation task |
| `audit` (future) | `AuditProvider` | Site-level audit; can be `auditChain([...], opts)` for fan-out |

The `AIProvider` interface itself is transport-only: `apiKey`, `baseUrl`, `organizationId`, `timeout`, `retryPolicy`. It exposes per-task builder methods (`provider.altText(taskConfig): AltTextAdapter`) consumed by the resolver, not by operators directly. Operators populate the data-literal blocks (`ai`, `altText`); the resolver chains rungs and calls `provider.altText({...})` with the resolved task config to construct the per-target adapter.

### Construction timing

Per G6'iii: factories construct **at config-eval time** (when `defineSite({...})` runs). This happens at:
- Admin boot (every CLI command that loads the config)
- `gazetta dev` boot
- `gazetta serve` boot
- `gazetta validate` (constructs but doesn't trigger SDK side effects per provider author convention)
- Test imports of config files

Construction should be **side-effect-free** at the SDK level. Documented expectation: factories build SDK config objects; first method call (read/write/list) is when network/auth happens. Plugin authors document any deviations.

Bad credentials throw at first SDK CALL, not at construction. Operators see auth failures during real operations (publish, save), not during validate.

### Hot reload (dev only)

`gazetta dev` watches `site.config.ts` and re-evaluates on save. Re-evaluation reconstructs all providers; old instances are discarded. Resource churn is acceptable for dev:
- Provider construction is typically fast (ms; SDK config-object creation)
- SDK clients are typically lightweight config holders for built-in providers (filesystem, R2, S3, Azure Blob, sharp, Cloudflare, in-memory cache, Anthropic / OpenAI / Ollama clients)
- Plugin authors document construction cost when their provider deviates (e.g., a provider that opens a persistent connection at construction)

Production never hot-reloads (per `design-config.md`'s evaluation timing); reconstruction churn is dev-only.

## Operator examples

### Solo blog (single AI provider, common case)

```ts
import {
  defineSite,
  filesystemStorage,
  r2Storage,
  sharpAdapter,
  cloudflareAdapter,
  memoryCache,
  anthropicProvider,
} from 'gazetta'

export default defineSite({
  name: 'My Blog',
  locales: { supported: ['en'] },

  cache: memoryCache({ maxEntries: 5000 }),
  ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }), model: 'claude-haiku-4-5' },

  // No altText: site falls back to ai's transport + model; per-task systemPrompt/maxTokens use system defaults

  targets: {
    local: {
      storage: filesystemStorage(),
      transforms: sharpAdapter(),
    },
    production: {
      storage: r2Storage({
        bucket: 'my-blog-prod',
        accountId: process.env.R2_ACCOUNT_ID!,
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      transforms: cloudflareAdapter({ zone: 'cdn.myblog.com' }),
      environment: 'production',
      siteUrl: 'https://myblog.com',
    },
  },
})
```

### Different AI providers/models per task and per target

```ts
const anthropic = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })
const openai = openaiProvider({ apiKey: process.env.OPENAI_API_KEY! })

export default defineSite({
  name: 'Multilingual Blog',
  locales: { default: 'en', supported: ['en', 'fr', 'ja'] },

  cache: memoryCache(),

  // Cross-task default: Anthropic for everything unless a task overrides
  ai: { provider: anthropic, model: 'claude-haiku-4-5' },

  // Task config: alt-text gets its own system prompt + token budget
  altText: { systemPrompt: 'descriptive, screen-reader-friendly', maxTokens: 300 },

  targets: {
    staging: {
      altText: {
        auto: true,                                    // behavior (Exception C)
        // Inherits provider/model/systemPrompt/maxTokens from site
      },
    },
    production: {
      altText: {
        auto: false,                                   // behavior (Exception C)
        ai: {                                          // task config override (Exception B)
          provider: openai,                            // swap to OpenAI for prod
          model: 'gpt-4o',                             // higher-quality model
          systemPrompt: 'descriptive, brand-aligned, screen-reader-friendly',
          maxTokens: 400,
        },
      },
    },
  },
})
```

The resolver builds per-target adapters at config-eval. Production gets an OpenAI gpt-4o adapter with the production prompt + 400 maxTokens. Staging gets an Anthropic Haiku adapter inheriting site defaults. Each rung overrides only the fields it specifies.

### Plugin-contributed provider

```ts
import { defineSite, r2Storage, sharpAdapter, memoryCache, anthropicProvider } from 'gazetta'
import { dropboxStorage } from '@example/dropbox-storage'

export default defineSite({
  name: 'Site with Dropbox archive',
  cache: memoryCache(),
  ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }), model: 'claude-haiku-4-5' },

  targets: {
    production: {
      storage: r2Storage({...}),
      transforms: sharpAdapter(),
    },
    archive: {
      storage: dropboxStorage({
        folderId: 'root-archive',
        token: process.env.DROPBOX_TOKEN!,
      }),
    },
  },
})
```

Plugin's `dropboxStorage` returns a `StorageProvider` instance. Operator's `storage:` field accepts it because the field type is `StorageProvider`, not a closed union. **Plugin author writes one thing: a factory.**

### Project-level defaults (gazetta.config.ts)

```ts
import { defineGazetta } from 'gazetta'

export default defineGazetta({
  logLevel: 'info',
  telemetry: false,
  dev: { port: 3000, hostname: 'localhost' },

  // Exception A — defaults take raw options; each site builds own instance
  defaults: {
    cache: { provider: 'memory', maxEntries: 5000 },
  },

  // Exception B — cross-site AI defaults (provider transport via factory; model + task config as data literals)
  ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }), model: 'claude-haiku-4-5' },
  altText: { systemPrompt: 'agency editorial voice', maxTokens: 300 },

  mcp: { enabled: true, port: 3100 },
})
```

Sites that don't set their own `cache:` field inherit by building from `defaults.cache` raw options. Sites that DO set their own `cache:` field override entirely (no merge).

Sites inherit the gazetta-level `ai:` and `altText:` per-field via the three-rung chain (Exception B): a site that sets only `altText: { systemPrompt: 'site voice' }` inherits the gazetta-level `ai.provider`, `ai.model`, and `altText.maxTokens` while overriding the system prompt. Three-rung inheritance is per-field, not per-block.

### Failure modes (what TypeScript catches at edit time)

```ts
defineSite({
  // ❌ TS error: "Property 'accountId' is missing in type"
  storage: r2Storage({ bucket: 'foo' }),

  // ❌ TS error: "Type 'string' is not assignable to type 'number'"
  cache: memoryCache({ maxEntries: 'lots' }),

  // ❌ TS error: "Type '{ type: 'r2'; ... }' is not assignable to type 'StorageProvider'"
  // The literal shape stops type-checking under Path X — must use the factory call
  targets: {
    production: {
      storage: { type: 'r2', bucket: 'foo', accountId: 'bar' },
    },
  },

  // ❌ TS error: "Property 'apiKey' does not exist on type 'AltTextTargetAiConfig'"
  // The ai sub-block accepts provider/model/systemPrompt/maxTokens; credentials live in the provider factory
  targets: {
    production: {
      altText: { ai: { apiKey: 'secret' } },
    },
  },

  // ❌ TS error: "Type 'string' is not assignable to type 'AIProvider'"
  // The provider field requires a factory result, not a string discriminator
  ai: { provider: 'anthropic', model: 'claude-haiku-4-5' },

  // ❌ TS error: factory not exported from 'gazetta'
  // (Plugin not imported; operator must `import { dropboxStorage } from '@example/dropbox-storage'`)
  targets: {
    archive: {
      storage: dropboxStorage({...}),
    },
  },
})
```

Errors surface in the IDE before save. No "you'll find out at runtime" gap for the schema layer; only semantic-failures (bad credentials hitting the SDK) surface at first use per `design-provider-config.md`'s construction-timing convention.

### Filesystem path defaulting

`filesystemStorage(opts?)` accepts an optional `path:` parameter. **The factory does NOT auto-default to a target-name-derived path** like the pre-Path-X dispatch did. Behavior:

- `filesystemStorage()` (no args) defaults to `./targets/local` for backward fixture compatibility
- `filesystemStorage({ path: './dist/staging' })` uses the specified path
- Operators wanting per-target paths name them explicitly

Why explicit? Auto-defaulting from target name would require either: (a) the factory receives the target name (breaks Pattern 1's "factory at field" simplicity by needing late-binding); (b) the factory returns a "buildable" the loader resolves later (breaks "factory returns instance" purity); (c) the provider resolves path lazily on first method call from runtime context (couples filesystem provider to runtime context lookup). Each of these added complexity to preserve a small ergonomic. The honest trade: operators write `path:` when they need a non-default — explicitness over magic.

## Foundational checks

Per [`feature-design-process.md`](feature-design-process.md), every feature design answers each of the 13 foundational dimensions plus the multi-instance discipline. Provider config is a reference doc, not a foundational dimension itself; the checks describe how this design composes with each dimension.

### Multi-instance check (discipline)

Provider instances constructed at config-eval are **per-process scope**: every Gazetta admin process constructs its own provider instances from the same config file. No cross-process instance sharing. Multi-instance correctness depends on each provider's own contract (per ADR-0004's universal requirements):

- `MemoryCache`: each process holds its own instance; SSE invalidation broadcast (Cut 4) keeps process-local caches eventually consistent across instances
- `RedisCache` (future): each process holds its own client; cache STATE is shared via Redis (the backing service), and instances coordinate via Redis pub/sub
- Storage providers wrap stateless SDK clients; each process constructs its own client; backing store (R2 / S3 / Azure / filesystem) is the shared state
- `AdminCache` defaults inheritance (Exception A) preserves per-site-per-process scope: defaults are options, not instances; each site×process constructs its own from the inherited options

Hot reload (dev only) reconstructs per-process; production never reloads. No multi-process coordination state created across reloads.

### Scale check (#1)

Provider construction at config-eval runs once per admin process boot. At the documented operating envelope (5000 pages, ~10 targets per site), construction cost is bounded per process:
- ~10 storage provider constructions (one per target)
- ~10 transform adapter constructions
- 1 cache instance per site (multi-site projects: N caches across N sites; per-process)
- 1 AI base + per-task adapters built lazily on first resolver call

Each construction is sub-millisecond (SDK config object creation). Total config-eval overhead is negligible vs. file-system walks, template scans, etc. that dominate boot time.

`gazetta validate` constructs all providers but doesn't trigger SDK side effects (per provider author convention). Validate stays fast.

### Locale (#2)

Locale config shape changes here: `locales: { default?, supported }` (single block) replaces today's top-level `locale` + `locales.supported` split. Locale-priority cross-dimension fallback (per `design-i18n.md` locked invariant) is unaffected — fallback semantics live in resolver code, not in operator-config shape.

Provider configuration is locale-agnostic. Targets serve their configured locales; the provider doesn't know about locales at the config layer.

Per-locale provider variants (e.g., region-specific storage per locale) aren't supported today and aren't enabled by this design. Could ship as a future dimension if concrete demand surfaces; Pattern 2 (chained method) generalizes to per-locale chaining if needed.

### Themes (#3)

Theme config (`themes: { default?, supported }`) is unchanged. Provider config doesn't carry theme variants — themes affect render-time output, not provider selection. Asset variant resolution (per `design-media.md`) is theme-aware via the cross-dimension fallback chain; provider config doesn't participate.

### Auth + RBAC (#4)

**Q: How does this feature gate on roles?** A: It doesn't — provider config is read at boot before any request arrives; no `Principal` exists at config-eval time. Provider construction doesn't depend on auth.

**Q: What capabilities does it require?** A: None at config-eval. Provider methods invoked during request handling DO see the request's `Principal` (per per-foundation contracts) and gate per their own contracts. Capability gates on writes flow through routes, not through provider config.

**Q: How does it consume the `Principal`?** A: Provider config layer doesn't. Provider runtime methods receive context as needed. Plugin-contributed providers follow the same pattern: factory constructs from config; runtime methods receive context.

### Audit (#5)

**Q: What audit events does this feature emit?** A: None directly. Provider construction is a system-internal event, not an audited action. Audit log records WRITES (save, publish, delete, restore) — not config-eval.

**Q: How does it compose with `AuditProvider`?** A: When Audit foundation ships, `audit:` field accepts an `AuditProvider` constructed via `auditChain([...], opts)` (Pattern 3 — multi-provider fan-out) or a single-provider factory like `historyAudit()`. This design defines HOW operators configure audit providers; audit-event semantics are unchanged.

Audit recording itself is request-scoped and not affected by this design — provider config defines WHAT audit provider, not WHEN audit fires.

### Review workflow (#6)

**Q: Does this feature flow through the review state machine?** A: No. Provider config is admin-runtime configuration, not content. Review state lives on content (page/fragment manifests); provider config is read once at admin boot.

**Q: What capabilities does it use (`review:submit`, `review:approve`, `publish:approve`)?** A: None at config layer. Pending-review CONTENT publishes through the configured storage provider; review-workflow gates run before publish; provider construction doesn't participate.

### Hook (#7)

Hooks fire at lifecycle phases (save, publish, etc.) — never at config-eval. Provider construction doesn't participate in the hook system.

Site-local hooks (`admin/hooks/*.ts`) and plugin-contributed hooks (when plugins ship) are configured separately from providers — `admin.hooks` block in `site.config.ts` (or per-target). Different field; different concern.

Plugin packages may contribute BOTH a provider AND hooks. Operator imports both from the package: factory call wires the provider; plugin's hook contributions register via the plugin foundation when it ships.

### Rendering modes (#8)

**Q: Which rendering modes does this support (static / ESI / request-SSR / island)?** A: All four. Provider config (storage, transforms, cache) is orthogonal to rendering mode — each rendering mode reads/writes through whatever storage provider the target configures. Storage provider API contract (read/write bytes) doesn't change per rendering mode.

**Q: What's the limitation for unsupported modes?** A: None — all four modes work with any storage/transform/cache combination. Per-target `type: 'dynamic'` is independent of storage provider choice.

**Q: Does it expose render-time queries (listings)?** A: No. Provider config is admin-runtime; render-time queries (per `design-rendering.md`) are content-tree queries against the configured storage.

### Validation (#9)

Provider config is type-checked at edit time (via `<const T extends SiteManifest>` and per-factory typed options) — TypeScript catches missing fields, wrong types, wrong-variant fields. No separate validation phase needed for shape.

Runtime validation:
- Factories validate at config-eval (throw `ConfigError` on invalid input)
- Bad credentials surface at first SDK method call (operators see auth failures during real operations)

`gazetta validate` runs the validator framework against content (per `design-validation.md`); doesn't separately validate provider config beyond what TS already enforces.

### Plugin (#10)

Plugin foundation is **deferred indefinitely** per the conversation that produced this design. Operator-facing factory pattern works for in-tree built-in providers today. Pure-provider plugin packages (e.g., `@example/dropbox-storage` that contributes only a Storage provider) require:
- Factory function exported from the package
- Returned instance satisfies the relevant provider interface (`StorageProvider`, `AdminCache`, etc.)
- Operator imports + invokes; field accepts the instance

Pure-provider plugins work without the plugin foundation runtime — the factory directly returns the constructed provider. This is a real simplification specifically for provider-only plugins.

Multi-concern plugin packages (e.g., a plugin that contributes a Storage provider AND `afterPublish` hooks AND a custom Validator) still depend on the plugin foundation for the non-provider contributions. The plugin foundation provides:
- Plugin lifecycle (`init` / `dispose`)
- Plugin discovery + version checks + disable lists
- Capability requirements (service-account opt-in per `design-plugins.md`)
- Hook / validator / route / capability registration

Plugin authors choose: ship a pure-provider package (just a factory) and don't depend on plugin foundation; OR ship a multi-concern plugin and follow `design-plugins.md`'s `Plugin` interface. Provider factory compose orthogonally with plugin foundation when both apply — the same package can export `init(api)` for hooks AND a factory for the provider.

### Cache (#11)

`AdminCache` is itself one of the surfaces this design configures. The design recursively applies: `cache: memoryCache({...})` returns an `AdminCache`. `gazetta.config.ts defaults.cache` takes raw options (Exception A) for per-site instance construction.

`AdminCache` SSE invalidation (Cut 4 of `design-cache-implementation.md`) is independent of provider config — it's a runtime concern of the cache provider's `subscribe()` method.

### Offline (#12)

**Q: Does this feature work when admin is offline?** A: Provider config is read at admin boot; offline mode (per `design-offline.md`) is a browser-admin concern (UX during connectivity loss). No interaction at the server-side provider-config layer.

**Q: Read paths degrade to cache; write paths queue and replay; conflict resolution on reconnect — how do these compose?** A: Offline-aware provider behavior (e.g., a storage provider that queues writes during connectivity failures) is the provider's runtime concern, designed by the provider implementation. Provider config layer doesn't drive offline behavior; provider's contract does.

**Q: If feature is online-only, document the limitation.** A: Provider config layer is online-only (read at boot); browser-admin offline state is unaffected by config-layer concerns.

### Collaboration (#13)

**Q: Does this feature carry conversation (comments, mentions)?** A: No — provider config is admin-runtime configuration, read once at boot.

**Q: Does it generate notifications?** A: Not at config-layer. When `NotificationProvider` ships (Extension Surface #12 per `design-collaboration.md`), it follows Pattern 3 (multi-provider fan-out) for the `admin.notifications` field — `admin.notifications: notificationsChain([...], opts)` or single-provider factory call.

**Q: Does it appear in the activity feed?** A: No — provider config-eval is system-internal, not surfaced to authors.

## UX check

Per [`team-preferences.md`](team-preferences.md) rule 23 — "Don't Make Me Think" applied to operator config:

**Absence-as-state**:
- Sites without `ai:` field have AI features off; not "AI is configured but inactive"
- Sites without `cache:` use the default `MemoryCache` with default options; not "no cache"
- Per-target `altText: { auto: false }` only specifies what's overridden; absent fields inherit
- Discoverable via single-config-block reading; no need to chase nested defaults

**Universal idiom over jargon**:
- Factory call (`r2Storage({...})`) reads as "configure R2 storage with these options" — natural verb-object phrasing
- Discriminator strings (`type: 'r2'`) replaced with function names (`r2Storage`); function name self-describes
- Operator never types `provider: 'name'` strings; always factory calls

**Same affordance regardless of state**:
- Factory call works identically whether operator is using built-in or plugin-contributed providers
- Operator's mental model: "I import a factory, I invoke it"; doesn't change between scenarios
- Single canonical syntax — no "literal style" vs "factory style" choice

**Plain language**:
- Field names are verbs/nouns aligned with operator intent (`storage`, `cache`, `ai`, `transforms`)
- Factory names match provider names (`anthropicProvider`, `r2Storage`); no Gazetta-specific neologisms
- Error messages from factories use field paths from `site.config.ts` (e.g., "R2 storage requires `accessKeyId`")

**No help-tooltips-as-bandaid**:
- Discoverability is via TypeScript autocomplete + JSDoc on factory parameters; not separate docs to look up
- IDE shows what each factory accepts; what each field's type is; what each enum value means
- ADR-0008 + this design doc are operator-discoverable from code via JSDoc links

## Migration

Hard cutover per ADR-0005 precedent. No coexistence period; no compat shims; no `gazetta migrate-providers` CLI (matching ADR-0005's deferred migration tool).

**What changes for operators with existing v0.x configs:**

Storage:
```ts
// Before
storage: { type: 'r2', bucket, accountId, accessKeyId, secretAccessKey }

// After
storage: r2Storage({ bucket, accountId, accessKeyId, secretAccessKey })
```

Transform:
```ts
// Before
transforms: { adapter: 'cloudflare', zone: 'cdn.example.com' }

// After
transforms: cloudflareAdapter({ zone: 'cdn.example.com' })
```

Cache:
```ts
// Before
admin: { cache: { provider: 'memory', memory: { maxEntries: 5000 } } }

// After
cache: memoryCache({ maxEntries: 5000 })  // moved out of admin block
```

AI:
```ts
// Before
ai: { provider: 'anthropic', defaultModel: 'claude-haiku-4-5' }
altText: { provider: 'openai', model: 'gpt-4o-mini', auto: true, maxImageEdge: 1024 }

// After
ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }), model: 'claude-haiku-4-5' }
altText: { auto: true, maxImageEdge: 1024 }   // behavior + per-task config (no per-task provider override needed in this example)

// To override per-task with a different provider/model:
const openai = openaiProvider({ apiKey: process.env.OPENAI_API_KEY! })
// In a target's altText.ai sub-block:
targets: {
  production: {
    altText: { auto: false, ai: { provider: openai, model: 'gpt-4o-mini' } }
  }
}
```

Notes:
- `defaultModel` (constructor arg) is gone. Provider constructors take transport only (apiKey, baseUrl, etc.). `model` lives in the data-literal `ai:` block (gazetta/site) or `altText.ai` sub-block (per-target).
- Existing `AltTextSiteConfig.provider` and `AltTextSiteConfig.model` fields collapse: site-level model is `site.ai.model` (cross-task default); site-level provider is `site.ai.provider`. Per-task provider override at site level is not exposed in v1.5 (was theoretical; no operator demand). Per-target provider override is exposed via `targets.X.altText.ai.provider`.
- Existing `AltTextTargetConfig.model` field moves into `targets.X.altText.ai.model`. Old top-level `model` is removed.

Locale:
```ts
// Before
defaultLocale: 'en'
locales: { supported: ['en', 'fr'] }

// After
locales: { default: 'en', supported: ['en', 'fr'] }
```

**Migration scope:**
- 10 fixture configs in repo (starter, gazetta.studio, target-matrix, test fixtures) — rewritten in dedicated PR phase
- ~13 design docs with operator-config examples — swept to factory style
- All public docs (`docs/cloudflare.md`, `docs/self-hosted.md`, `docs/getting-started.md`, etc.) — swept

**Migration cost** for external operators: per-config rewrite. Mechanical for storage/transform/cache (1:1 syntactic change); slightly more work for AI (per-task chaining). Pre-1.0 product; operators absorb the cost.

## Open questions

1. **Build-time JSON precompile (`gazetta build:config`)** — incompatible with factory-returns-instance. Three options for v1.5+ design pass:
   - (a) Drop the precompile capability; cold-start optimization happens differently (e.g., bundling)
   - (b) Factories opt into a `serialize()` method; precompile calls it; rehydrate at boot calls factory again with serialized args
   - (c) Precompile produces a "construction recipe" (factory name + args); boot evaluates the recipe via factory map
   - Decide when v1.5 design pass starts; out of scope here.

2. **Provider construction side-effect convention** — providers SHOULD defer SDK side effects to first method call; `gazetta validate` benefits from this. Documented as plugin author convention; not enforced. Trigger to revisit: a plugin author ships a provider that auths/connects at construction, breaking validate. Add an opt-in "skip side effects" mode if pain emerges.

3. **`AIProvider` interface per-task method shape** — locked: `provider.altText(taskConfig: AltTextTaskConfig): AltTextAdapter`. Future tasks add their own builder method (`.translation(taskConfig)`, `.summarization(taskConfig)`). Plugin author adding a new AI task (e.g., a custom embedding task) ships a `CapableProvider` extension interface (`EmbeddingCapableProvider extends AIProvider`) and an in-tree-or-plugin task-config block. Capability detection at the resolver via `'embedding' in provider`. Defer concrete shape to first capability extension.

4. **Per-target provider override semantic** — locked: per-target `altText.ai` sub-block accepts `provider`, `model`, `systemPrompt`, `maxTokens` as data literals (Exception B). Operator wanting region-specific provider per target writes the full factory call inside the sub-block (`ai: { provider: r2Storage(...) }` analog for AI: `ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_EU_KEY! }) }`). The data-literal at target level is what supports this — Exception B's three-rung scope is exactly the per-target override path.

5. **Hot reload `dispose()` lifecycle for providers** — accepted as G7'a (no formalization); revisit if a provider author reports resource-leak issues from hot reload.

## Future directions

- **JSON precompile reshape (v1.5)** — see open question 1
- **Plugin foundation integration** — when plugin foundation ships (deferred until cross-site shared-extension demand surfaces), provider factories from plugins compose with this design without changes
- **Per-locale provider variants** — Pattern 2 generalizes; not enabled today
- **Per-target provider/credentials overrides** — see open question 4; currently solved via per-target factory calls
- **Audit / Auth / Notification / Deploy surfaces** — Patterns 1, 3, 1, 1 respectively when those foundations ship
- **AI task expansion** (translation, summarization, image generation, tag suggestion) — Pattern 2 chained methods on `AIProvider` interface; designed for forward-additivity per `design-ai-implementation.md`

---

This design supersedes ADR-0004's operator-config-shape requirement (operators write `provider: 'name'` literal). ADR-0004's eight Universal Provider Requirements (multi-instance correctness, env-var credentials, fail-mode declared, stable typed contract, etc.) are preserved unchanged.

