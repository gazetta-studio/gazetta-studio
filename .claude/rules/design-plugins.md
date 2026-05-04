---
paths:
  - "packages/gazetta/src/providers/**"
  - "packages/gazetta/src/alt/*.ts"
  - "packages/gazetta/src/transforms/**"
  - "packages/gazetta/src/editor/mount.tsx"
  - "**/templates/**/index.tsx"
  - "**/admin/editors/**"
  - "**/admin/fields/**"
---

# Plugin / extensibility

Foundational dimension #10 of 13. Unifying contract for the existing extension surfaces — discovery, loading, lifecycle, composition.

**Status**: design pass complete (2026-05). Implementation phases sit in Tier 3.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Plugin check** every new extension surface must answer
- [`design-config.md`](design-config.md) — plugins are imported and invoked inline in `defineSite()`; config is the discovery surface
- [`design-hooks.md`](design-hooks.md) — hooks are an extension surface; plugins register hooks via `PluginAPI.registerHook`
- [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md) — Universal Provider requirements for the 11 extension surfaces

## Why this is foundational

Today, nine extension surfaces exist (storage providers, templates, custom editors, custom field widgets, transform adapters, deploy adapters, AI providers, validators, cache providers) plus hooks (incoming). Each has its own interface contract. Without a unifying plugin contract, future surfaces (whatever 11th or 12th surface gets added) drift toward their own ad-hoc plug-in pattern. Unifying later is structural rework.

Strategic commitment locked: **plugins are foundational** (resolved from "open question"). The named surfaces ARE the plugin system. The unifying contract formalizes how they compose.

## Locked invariants (already decided)

- **Existing surfaces stay distinct interfaces** — `StorageProvider`, `EditorMount`, `FieldMount`, `AltTextAdapter`, `TransformAdapter`, etc. The plugin contract doesn't replace them; it provides discovery + loading + composition rules on top.
- **MCP schema discipline** — new admin-API routes use the existing Zod schema pattern. MCP tooling auto-generates from these. Plugin contract respects this — plugins that add admin-API routes follow the schema pattern.
- **Real-time event-source discipline** — plugins that observe save/publish do so via audit log, not by patching handlers. Per `feature-design-process.md` non-foundational disciplines.
- **Pluggable provider pattern** — per [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md), Storage, Cache, Audit, AltText (AI), Transform Adapter, Deploy Adapter, Validator, AuthIdentity, Hook, Admin Editor, Admin Field follow the universal Provider requirements below.

## Universal Provider requirements

Every Provider — regardless of which Extension Surface it implements — must satisfy these requirements. Per-surface contracts (in each surface's design doc) specialize on top of these.

**1. Multi-instance correctness.** Either:
- Per-instance scope (multi-instance-correct via independence — `MemoryCache`, `HistoryAuditProvider`); OR
- Storage-coordinated via the provider's own atomicity primitives (per-edge sidecars, content-addressed blobs, atomic compare-and-swap, etag-based conditional writes).
- In-process state shared across operations is forbidden per the multi-instance discipline ([`feature-design-process.md`](feature-design-process.md) "Non-foundational disciplines").

**2. Stateless interface.** Provider methods are idempotent OR document where they aren't. Two instances calling the same method converge to the same result (or document the divergence and the expected reconciliation).

**3. Configuration via env vars for credentials.** Credentials never appear in `site.yaml`. Provider reads its own env vars matching the upstream SDK's conventions (`AWS_*`, `AZURE_*`, `R2_*`, `ANTHROPIC_API_KEY`, etc.). Site config names the Provider + non-secret options only.

**4. Sensible defaults.** Provider works with minimal config. Operator overrides defaults only when defaults don't fit. Defaults documented per-Provider in the surface's design doc.

**5. Fail-mode declared per surface.** Each surface declares its discipline:
- Audit fails open (audit failure must never block writes).
- Storage fails closed (storage write failure must abort the operation).
- Cache fails open (cache miss returns null; cache failure logs + falls through to source-of-truth).
- AltText fails open with refusal flag (provider failure surfaces as null suggestion + structured error event).

**6. Never throws on transport errors at the recording / observation layer.** Network errors, rate limits, transient failures are caught and logged. Throws reserved for unrecoverable infrastructure errors (configuration error, schema mismatch, init failure).

**7. Stable typed contract.** Provider interface is a TypeScript interface; consumers depend on the abstraction, not concrete classes. Adding required methods is a breaking change requiring a version bump; new optional methods are additive.

**8. Independent error taxonomy.** Each surface declares its Gazetta-side error type (`StorageError`, `CacheError`, `AuditError`, `AltAdapterError`, etc.). Provider implementations translate provider-specific errors (AWS SDK errors, Redis connection errors, etc.) into the surface's error type. Consumers handle the Gazetta error type, not the upstream SDK error.

**9. Operator config consistency.** Across surfaces, operator config follows the same pattern: `provider: name` (or `providers: [...]` for multi-Provider surfaces) + minimal yaml + env-var credentials. Operators learn the pattern once.

**10. Forward-compatible plugin promotion.** v1 ships in-tree Providers. Future plugin-packaged Providers slot in via the same interface — additive, never breaking. The internal `Provider` interface and the plugin contract converge.

## Discovery (Q1 locked)

**Plugins are imported into `site.config.ts` and invoked inline within the `admin.plugins` array.** No auto-discovery.

```ts
import slackNotify from '@gazetta/slack-notify'
import autoSlugify from './admin/plugins/auto-slugify'

export default defineSite({
  admin: {
    plugins: [
      slackNotify({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
      autoSlugify(),
    ],
  },
})
```

**Two sources, both via TypeScript imports**:

| Source | How operator references it |
|---|---|
| **npm package** | `import slackNotify from '@gazetta/slack-notify'` (must be in `package.json`) |
| **Site-local** | `import autoSlugify from './admin/plugins/auto-slugify'` (relative path from config file) |

Both produce a `Plugin` object that goes into `admin.plugins`. Same registration; only the import path differs.

**Discovery rules**:
- No `package.json` `gazetta` field required at load time (optional metadata for tooling/marketplace UX, future)
- No `gazetta-plugin-*` naming convention required
- Order in `admin.plugins` array is registration order; per-surface dispatch order is governed by surface semantics (e.g., hooks priority bands per `design-hooks.md` Q3)

This is the same pattern as Vite plugins, Astro integrations, Tailwind plugins, ESLint plugins-as-imports.

## Loading lifecycle (Q2 locked)

**Phases**:
1. Config evaluation (`site.config.ts` runs; factory invocations return `Plugin` objects)
2. Zod validation of full config
3. **Plugin init** — Gazetta calls `plugin.init(api)` for each, in array order, awaiting each
4. Admin server starts accepting requests
5. (operations dispatch hooks, providers, routes registered by plugins)
6. **Plugin dispose** on dev reload OR shutdown — `plugin.dispose?()` called

**Init order**: serial, in `admin.plugins` array order. Predictable; no parallel-init races.

**Async init**: `init()` returns `void | Promise<void>`. Use cases:
- Credential validation (test connection to external service)
- Capability discovery (query upstream for allowed features)
- State pre-loading (warm internal cache)
- Schema fetching (download external schema)
- Lazy resource setup (long-lived connections held for plugin lifetime)

**Registration window**: `PluginAPI` registration methods are valid only during init's lifetime. After init resolves, registration calls throw `RegistrationAfterInitError`. Pins plugin contributions deterministically per boot.

**Failure mode**:
- **Default**: `init()` throwing fails admin boot. Operator sees error, fixes config, retries.
- **Optional plugins**: wrap with `optional()`:
  ```ts
  import { optional } from 'gazetta'
  import devOnlyTool from '@my-org/dev-only-tool'

  plugins: [
    slackNotify({ /* ... */ }),
    optional(devOnlyTool({ /* ... */ })),  // failure → log + continue
  ]
  ```

`optional()` is a typed wrapper returning `PluginRegistration` with `optional: true`. Direct `Plugin` instances are implicitly `optional: false`. The `admin.plugins` array accepts both shapes.

**Dispose** (per `design-config.md` lock):
- Called on dev reload before reinit
- Production never calls dispose (process restart releases everything)
- All registrations (hooks, providers, routes) cleanly unregistered

## Plugin payload + PluginAPI (Q3 locked)

**Plugin shape**:

```ts
interface Plugin {
  /** Stable identifier; used in audit, error messages, config disable lists.
   *  Convention: '@scope/package' for npm; bare name for site-local. */
  name: string
  /** Plugin version; pulled from package.json or declared inline. Used for
   *  diagnostics + telemetry; not used for compatibility checks. */
  version?: string
  /** Optional advisory metadata about what the plugin does. Not enforced;
   *  surfaces in admin UI for operator inspection (v1.5 ergonomic). */
  requires?: {
    network?: string[]              // documented network endpoints
    capabilities?: Capability[]      // Gazetta capabilities needed (service account)
    hooks?: HookPhase[]              // informational
  }
  /** Initialization. Called once after config validation, before admin
   *  starts accepting requests. Async supported. Throws to fail boot
   *  (or log+continue if wrapped in optional()). */
  init(api: PluginAPI): void | Promise<void>
  /** Cleanup. Called on dev reload before reinit. Production never calls
   *  dispose — process restart releases resources. */
  dispose?(): void | Promise<void>
}
```

**Plugin authors export factory functions** returning `Plugin`:

```ts
// In @gazetta/slack-notify
import type { Plugin, PluginAPI } from 'gazetta'

interface SlackOptions {
  webhookUrl: string
  channel?: string
}

export default function slackNotify(options: SlackOptions): Plugin {
  return {
    name: '@gazetta/slack-notify',
    version: '1.0.0',
    init(api: PluginAPI) {
      api.registerHook('afterPublish', async (target, result, ctx) => {
        await fetch(options.webhookUrl, { /* ... */ })
      })
    },
  }
}
```

**`PluginAPI` shape** — per-surface methods (not unified `register()`); preserves type safety + IDE autocomplete:

```ts
interface PluginAPI {
  readonly self: { name: string; version?: string }

  // Hooks (per design-hooks.md)
  registerHook<TPhase extends HookPhase>(
    phase: TPhase,
    handler: HookHandler<TPhase>,
    options?: HookOptions
  ): void

  // Provider surfaces
  registerStorageProvider(name: string, factory: StorageProviderFactory): void
  registerCacheProvider(name: string, factory: CacheProviderFactory): void
  registerAuditProvider(name: string, factory: AuditProviderFactory): void
  registerAuthIdentityProvider(name: string, factory: AuthIdentityProviderFactory): void
  registerAltTextAdapter(name: string, factory: AltTextAdapterFactory): void
  registerTransformAdapter(name: string, factory: TransformAdapterFactory): void
  registerDeployAdapter(name: string, factory: DeployAdapterFactory): void
  registerValidator(validator: Validator): void

  // Admin UI extensions
  registerEditor(name: string, mount: EditorMount): void
  registerField(name: string, mount: FieldMount): void

  // Admin-API routes (Q3b lock)
  registerRoute(definition: RouteDefinition): void

  // Read-only access
  readonly storage: ReadOnlyStorageProvider     // Q3d: read-only
  readonly site: ReadOnlySiteConfig
  readonly gazetta: ReadOnlyGazettaConfig
  readonly log: PluginLogger
}
```

**Route definition** (Q3b):

```ts
interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string                                   // e.g., '/api/plugins/slack-notify/test'
  capability: Capability                         // e.g., 'configure:site'
  schema: { request?: ZodSchema; response: ZodSchema }
  handler: (c: HonoContext) => Promise<Response>
}
```

Routes namespace under `/api/plugins/{plugin-name}/...` by convention. Path collisions caught at registration time.

**Reserved capability prefixes** (Q3c):

| Prefix | Reserved for |
|---|---|
| `read:*`, `edit:*`, `delete:*`, `publish:*`, `configure:*` | Built-in Gazetta capabilities |
| `review:*`, `restore:*` | Built-in (review workflow + history) |
| Any other prefix | Plugin-contributed (e.g., `search:rebuild-index`, `webhook:test`) |

Plugin-contributed capabilities use a plugin-specific prefix (typically derived from purpose, not name — `search:` rather than `gazetta-plugin-search:`). Site config lists them in role definitions like any built-in capability.

**Read-only storage in PluginAPI** (Q3d): plugins can read storage during init but cannot write. Writes during init would race across instances and create non-deterministic boot state. State persistence happens via storage during operation (e.g., from inside hook handlers using their `ctx.storage`), not init.

**Plugin author types** exported from `gazetta`:

```ts
export type { Plugin, PluginAPI, HookPhase, HookHandler, Capability, /* ... */ } from 'gazetta'
export { optional, defineSite, defineGazetta } from 'gazetta'
```

## Composition (Q4 locked)

**Multi-plugin per surface**: each surface's existing semantics govern. No central rule at the plugin layer.

| Surface | Multi-plugin behavior |
|---|---|
| Hooks | Priority-based composition per `design-hooks.md` Q3; all run in priority order |
| Storage providers | Operator picks one per target; plugins extend the catalog |
| Cache providers | Operator picks one per `admin.cache`; plugins extend the catalog |
| Audit providers | Multi-provider supported per `design-audit.md`; plugins extend the catalog |
| AuthIdentity | Operator picks one per `admin.auth.trust`; plugins extend the catalog |
| Alt-text adapters | Operator picks one per `admin.altText.provider`; plugins extend the catalog |
| Transform adapters | Operator picks one per `target.transforms.adapter`; plugins extend the catalog |
| Deploy adapters | Operator picks one per target's deploy config; plugins extend the catalog |
| Validators | All run; results aggregated per `design-validation.md`; plugins add to the registry |
| Editors / Fields | Templates declare which they want; plugins extend the catalog |
| Routes | One handler per (method, path); collisions throw at registration time |

**Provider name collisions** (two plugins both registering the same provider name): error at registration time. Error message names both plugins so the operator can pick one:

```
Provider name 's3' already registered by plugin '@gazetta/r2-storage';
'@my-org/custom-storage' cannot register the same name.
```

**Plugins adding new surfaces** (e.g., a plugin defining `SearchProvider` as a new extension surface other plugins target): **out of v1**. Meta-extensibility is too complex for v1. v1 ships with the 11 named extension surfaces per ADR-0004; plugins extend these catalogs and add admin routes via `registerRoute`.

When plugins genuinely need a new surface (search-backend example), trigger pattern matches plugin-promotion convention: 3+ operator requests for the same kind of new surface within 6 months → Gazetta adds it as a first-class extension surface in-tree, with documented contract. Plugins then implement the new surface like any other.

**Plugins adding admin routes via `registerRoute`** is in v1 — covers most "I want to add a feature" cases.

## Versioning (Q5 locked)

**Peer dependency on `gazetta`** is the primary compatibility mechanism:

```json
{
  "name": "@gazetta/slack-notify",
  "version": "1.0.0",
  "peerDependencies": {
    "gazetta": "^1.0.0"
  }
}
```

npm/yarn/pnpm warn (or error) at install time on peerDep mismatch. Same pattern as ESLint plugins, Vite plugins, etc.

**Load-time check** (Gazetta-side, additive to npm enforcement):
1. Read plugin's `package.json` (resolvable via `import.meta.resolve` or filesystem walk for site-local)
2. Extract `peerDependencies.gazetta`
3. Compare against running Gazetta version using semver
4. If mismatch → log warning naming plugin, declared range, actual version. Does NOT refuse to load.

Site-local plugins (no `package.json`) skip the version check — operator's own code; assumed compatible.

**Gazetta SemVer policy for `PluginAPI`**:
- **Patch (1.0.0 → 1.0.1)**: bug fixes only; no `PluginAPI` changes
- **Minor (1.0.x → 1.1.0)**: additive changes (new methods, new optional fields); existing plugins remain compatible
- **Major (1.x.x → 2.0.0)**: breaking changes (removed/renamed methods, changed signatures, changed semantics); plugins update peerDep range

Per Universal Provider Requirement #7: "Adding required methods is a breaking change requiring a version bump; new optional methods are additive."

**Multiple installed Gazetta versions in one project**: out of v1 scope.

## Sandbox / trust (Q6 locked)

**Plugins run with full Node access. No sandbox.**

Sandboxing Node code in production-grade ways isn't feasible at acceptable cost — VM contexts leak, worker threads break the registration model, subprocess isolation has high overhead, Realm/ShadowRealm are experimental. Accept the trust model.

**Trust posture**: operators evaluate plugins like any npm dependency. Plugins can read filesystem, make network calls, execute child processes. Supply chain attacks are real but already a general npm ecosystem concern.

**Service-account capabilities** (opt-in, operator-approved):

A plugin's hook may need elevated access (e.g., write to a sidecar that requires `configure:targets` even though the publishing principal lacks it). The plugin declares the requirement; operator approves at site config:

```ts
import slackNotify from '@gazetta/slack-notify'

export default defineSite({
  admin: {
    plugins: [
      slackNotify({
        webhookUrl: process.env.SLACK_WEBHOOK_URL!,
        serviceAccount: { capabilities: ['read:audit-log'] },  // operator approves
      }),
    ],
  },
})
```

When the plugin's hook fires, the principal's capabilities are unioned with the service account's for the duration of the hook. Audit records the elevation:

```ts
{
  action: 'hook-fired',
  outcome: 'success',
  actor: { /* triggering principal */ },
  metadata: {
    hookName: '@gazetta/slack-notify:notify',
    serviceAccount: ['read:audit-log'],   // declared elevation
  }
}
```

**Plugin marketplace + curation**: out of v1. Plugins distributed via standard npm registry. Operator's responsibility (or their org's security policy) to review plugins.

**Documentation responsibility**: trust posture documented prominently in `docs/` (operator guide). "Plugins run with full Node access — install only from sources you trust, pin versions, audit dependencies."

## Foundational checks

How plugins compose with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Plugins are file-based (npm packages or site-local TS files). Every instance imports the same plugins via `site.config.ts` deployed identically.
- Plugin discovery + loading happens at admin boot; each instance loads its own plugin set independently.
- **Plugins MUST NOT hold state in process across operations.** Any state goes through storage (using the same multi-instance-safe patterns the core uses: per-edge sidecars, content-addressed blobs, atomic writes).
- Plugin-contributed extensions (storage providers, AI adapters, validators, etc.) inherit the multi-instance discipline of their host surface — a plugin-supplied storage provider must be as multi-instance-safe as in-tree providers (per Universal Provider Requirement #1).
- Hot-deployed plugin (added without admin restart): out of v1 scope. v1 plugins require admin restart on each instance to pick up changes.

### Scale (#1)
- Plugin init runs serially at boot; total boot time = sum of init times. Per-plugin async init can be slow (network calls); operators with many plugins see proportional boot delay.
- Per-plugin timeout NOT in v1 (init failures fail boot loudly; operators investigate). Reserved if observed pain surfaces.
- Heavy plugins (e.g., one that warms a 10k-page cache at boot) flagged in plugin docs; operators evaluate fit for their scale.

### Locale (#2) + Themes (#3)
- Plugins that touch render output (rare in v1 — render hooks deferred per `design-hooks.md`) respect locale/theme dimensions via `RenderContext` (per `design-rendering.md`).
- Most plugins compose with locale/theme transparently — they receive `ctx` with locale/theme set; can branch on them if needed.

### Auth + RBAC (#4)
- Plugin-added admin routes gate on capabilities via `RouteDefinition.capability`.
- Plugin-contributed capabilities use a plugin-specific prefix (`search:`, `webhook:`, etc.); built-in prefixes reserved.
- Service-account capabilities (Q6 lock) provide opt-in elevation for plugin hooks needing access beyond the triggering principal's.

### Audit (#5)
- Plugin actions audit per the existing audit shape. Hooks emit `action: 'hook-fired'` with `metadata.hookName: '@plugin-name:hookName'`.
- Plugin route invocations audit as `action: 'plugin-route'` with `metadata.pluginName + path`.
- Service-account elevations recorded in audit metadata (per Q6 lock).
- Audit-fail-open posture preserved: plugin-action audit-record failure never propagates to caller.

### Review (#6)
- Plugin-supplied review workflow integrations (e.g., GitHub PR-as-review): reserved per `design-review-workflow.md` future directions. v1 uses hooks for external integration; provider surface deferred.

### Hooks (#7)
- Plugins are the primary distribution mechanism for hooks (per `design-hooks.md` Q4 locking dual discovery: site-local + plugin-supplied).
- Plugin hooks land in priority band 100-999 (per `design-hooks.md` Q3); built-in 0-99; site-local 1000+.
- Plugin-supplied hooks register via `api.registerHook(phase, handler, options)` during init.

### Render (#8)
- Render-lifecycle hooks deferred per `design-rendering.md`; not v1.
- Plugins that affect rendering today do so via static + island components or by registering custom editors/fields/templates.

### Validation (#9)
- Plugin-supplied validators register via `api.registerValidator(validator)` during init.
- Validators are pure functions; plugin-contributed validators inherit the same purity contract per `design-validation.md`.
- Validator stages (save-delta / background / pre-publish / cli) per the registered validator's `stages` declaration.

### Cache (#11)
- Plugin-supplied cache providers register via `api.registerCacheProvider(name, factory)` during init.
- Plugin-contributed cache providers must inherit Universal Provider Requirement #1 (multi-instance correctness via per-instance scope OR storage-coordinated atomicity).

### Offline (#12)
- Plugin behavior during offline matches the host surface's offline contract (per `design-offline.md`'s upcoming pass).
- Plugin-supplied offline-aware behavior follows the same patterns as in-tree code: write paths queue + replay; read paths degrade to cache.

### Collaboration (#13)
- Plugin-supplied notification providers (Slack, Discord, email) register as Notification Providers — reserved Extension Surface candidate per `design-collaboration.md`'s upcoming pass.
- Plugin hooks for `afterCommentPosted`, `afterMention` register via the standard hook contract once collaboration ships.

### Site config (`design-config.md`)
- Plugins are imported and invoked inline in `site.config.ts` via factory functions. Discovery surface is the config file itself.
- Plugin options are typed; TS inference at the call site catches misconfiguration at edit time. Runtime Zod still validates at load.
- `optional()` wrapper supports dev-only / environment-conditional plugins.

## Migration

Existing surfaces continue to work — plugin contract is additive on top. The migration is per-surface as the contract is applied:
- Built-in storage providers (filesystem, R2, S3, Azure) become "in-tree plugins" registered the same way external plugins would be
- Templates / custom editors / custom fields stay where they are; the contract applies to npm-packaged versions

## Future directions

- Plugin marketplace — npm registry filter, curated listings — out of scope for v1
- Custom routes / custom CLI as plugin surface — strategic non-fit per ROADMAP non-goals (waits for concrete demand)
- Plugin hot-reload — out of scope; reload requires admin restart
