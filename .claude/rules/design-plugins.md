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

Reference doc, not a foundational dimension. Captures the operator-facing patterns for installing extensions; the format is set once via [ADR-0008](../../docs/adr/0008-provider-factory-returns-instance.md) and [ADR-0009](../../docs/adr/0009-no-plugin-runtime-factory-contributions.md).

**Status**: design pass complete (2026-05). Pre-cutover design (Plugin runtime + PluginAPI) superseded by ADR-0009 — this doc replaces it. Implementation is per-surface as those surfaces ship.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — the **Plugin check** every new extension surface answers
- [`design-config.md`](design-config.md) — `site.config.ts` is the discovery surface; plugins import inline
- [`design-provider-config.md`](design-provider-config.md) — operator-facing factory shape for Provider surfaces (Path X)
- [`design-hooks.md`](design-hooks.md) — `admin.hooks` factory contributions (already shipped)
- [ADR-0004](../../docs/adr/0004-pluggable-provider-pattern.md) — Universal Provider Requirements (preserved across ADR-0008 + ADR-0009 supersessions)
- [ADR-0008](../../docs/adr/0008-provider-factory-returns-instance.md) — Provider factory returns instance
- [ADR-0009](../../docs/adr/0009-no-plugin-runtime-factory-contributions.md) — No plugin runtime; factory contributions only

## Why this is reference, not foundational (anymore)

The locked design pre-2026-05 framed plugins as a runtime: `Plugin` + `PluginAPI` + `init(api)` + `dispose()` + eleven register methods. ADR-0008 (Path X) collapsed six provider surfaces into factory-call-at-field; Hooks Cut 9 collapsed `registerHook` into `admin.hooks` factory contributions. With both shipped, the unifying runtime contract has no surviving use case. ADR-0009 captures the decision; this doc captures what operators and plugin authors actually do under it.

Plugins are now an **operator-facing distribution pattern**, not a runtime concern that recurs in feature design. New extension surfaces follow either Pattern X (factory-call-at-field for Provider surfaces) or contribution-array (factory-returns-contribution for surfaces that aggregate). They don't have to design "how the plugin runtime composes."

## Operator's mental model

> "Extensions come from npm packages or from my own files. Each export is a factory function. I import each factory and invoke it where it goes. Provider factories go at config fields; hook / validator / route factories go in their `admin.{surface}` arrays."

There is no `Plugin` interface, no `init(api)` lifecycle, no `PluginAPI` god-object. The composition IS the configuration.

## Universal Provider requirements

Every Provider — regardless of which Extension Surface it implements — must satisfy these eight requirements from ADR-0004. They describe Provider internals; they apply per-surface; they're preserved unchanged across ADR-0008 + ADR-0009 supersessions.

**1. Multi-instance correctness.** Either:
- Per-instance scope (multi-instance-correct via independence — `MemoryCache`, `HistoryAuditProvider`); OR
- Storage-coordinated via the provider's own atomicity primitives (per-edge sidecars, content-addressed blobs, atomic compare-and-swap, etag-based conditional writes).

In-process state shared across operations is forbidden per the multi-instance discipline ([`feature-design-process.md`](feature-design-process.md) "Non-foundational disciplines").

**2. Stateless interface.** Provider methods are idempotent OR document where they aren't. Two instances calling the same method converge to the same result (or document the divergence + reconciliation).

**3. Configuration via env vars for credentials.** Credentials never appear in `site.config.ts` literals; they're injected via `process.env.X!`. Provider reads its own env vars matching upstream SDK conventions (`AWS_*`, `AZURE_*`, `R2_*`, `ANTHROPIC_API_KEY`, etc.).

**4. Sensible defaults.** Provider works with minimal config. Operator overrides defaults only when defaults don't fit.

**5. Fail-mode declared per surface.** Each surface declares its discipline:
- Audit fails open (audit failure must never block writes).
- Storage fails closed (storage write failure must abort the operation).
- Cache fails open (cache miss returns null; cache failure logs + falls through to source-of-truth).
- AltText fails open with refusal flag.

**6. Never throws on transport errors at the recording / observation layer.** Network errors, rate limits, transient failures are caught and logged. Throws reserved for unrecoverable infrastructure errors (configuration error, schema mismatch).

**7. Stable typed contract.** Provider interface is a TypeScript interface; consumers depend on the abstraction, not concrete classes. Adding required methods is a breaking change requiring a version bump; new optional methods are additive.

**8. Independent error taxonomy.** Each surface declares its Gazetta-side error type (`StorageError`, `CacheError`, `AuditError`, `AltAdapterError`, etc.). Provider implementations translate provider-specific errors into the surface's error type.

## How operators install extensions

Two distinct patterns based on what kind of surface a factory targets:

### Pattern A — Provider field (Storage, Cache, Transform, AI, AuthIdentity, Audit, future Notification / Deploy)

Operator imports a factory and assigns the result to a typed config field. Field type is the runtime Provider interface; per ADR-0008.

```ts
import { defineSite, r2Storage, sharpAdapter, memoryCache, anthropicProvider } from 'gazetta'

export default defineSite({
  cache: memoryCache({ maxEntries: 5000 }),
  ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }), model: 'claude-haiku-4-5' },

  targets: {
    production: {
      storage: r2Storage({ /* ... */ }),
      transforms: sharpAdapter(),
    },
  },
})
```

Factory throws at config-eval on bad input (missing required fields, malformed env-var sentinels). SDK side effects deferred to first method call per [design-provider-config.md](design-provider-config.md) construction-timing convention.

### Pattern B — Contribution array (Hooks, Validators, Routes)

Operator imports a factory and adds the result to a typed array under `admin.{surface}`.

```ts
import { defineSite } from 'gazetta'
import { autoSlugify } from './admin/hooks/auto-slugify'
import { slackHook, slackRoute } from '@example/slack-notify'
import linkChecker from '@example/link-checker'

export default defineSite({
  admin: {
    hooks:      [autoSlugify(), slackHook({ webhookUrl: process.env.SLACK_WEBHOOK! })],
    validators: [linkChecker({ excludePatterns: ['/admin/*'] })],
    routes:     [slackRoute({ webhookUrl: process.env.SLACK_WEBHOOK! })],
  },
})
```

Each array's element type is the matching contribution shape. Per-surface dispatch order is governed by surface semantics (priority for hooks per `design-hooks.md`; insertion order for validators; one handler per `(method, path)` for routes with collisions throwing).

### Patterns that DON'T need either

Templates, custom editors, custom fields use **file-based discovery** per [`custom-editors.md`](custom-editors.md). Operator places `.tsx` files in `templates/`, `admin/editors/`, `admin/fields/`. No factory; no contribution shape; the file IS the contribution. An npm package shipping a custom editor exports the mount function; the operator copies / imports / re-exports it from their `admin/editors/` directory.

## Contribution shapes

### `HookContribution` (per [design-hooks.md](design-hooks.md))

Already shipped in hooks v1 (Cut 9).

```ts
interface HookContribution {
  readonly source: string                                     // '@example/cdn-purge' | 'site-local:auto-slugify'
  readonly hooks: ReadonlyArray<HookEntry>
  readonly serviceAccount?: readonly Capability[]             // opt-in elevation; declared by author, approved by operator import
}

interface HookEntry {
  readonly phase: HookPhase
  readonly handler: HookHandler
  readonly options?: HookOptions                              // { name?, priority?, timeout? }
}
```

Wires into `admin.hooks: HookContribution[]`. Multiple handlers per contribution allowed (one factory contributing both `afterSave` + `afterPublish` shares closure state). Composition by priority bands (built-in 0-99 / factory 100-999 / site-local 1000+).

### `Validator` IS the contribution (per [design-validation.md](design-validation.md) + this design pass)

The `Validator` interface from validation Cut 1 extends with a `source` field. No wrapper.

```ts
interface Validator {
  readonly source: string                                     // '@example/link-checker' | 'site-local:custom-rule'
  readonly name: string
  readonly stages: readonly ValidationStage[]
  defaultSeverity(stage: ValidationStage): Severity
  validate(input: ValidatorInput): Promise<Issue[]>
}
```

Wires into `admin.validators: Validator[]`. Each factory returns one `Validator` (validators don't bundle phases the way hooks do; one validator = one concern). Operator config flows through the factory closure.

The validator runtime registry merges `admin.validators` entries with built-in validators (the five ref-existence ones from validation Cut 1) into one registry. Same dispatch path; same stage dispatch (save-delta / background / pre-publish / cli) per the validator's declared `stages`.

### `RouteContribution`

```ts
interface RouteContribution {
  readonly source: string                                     // '@example/slack' | 'site-local:custom-route'
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string                                       // '/test' (system mounts at /api/plugins/{source}/test)
  readonly capability: Capability
  readonly schema: { request?: ZodSchema; response: ZodSchema }
  readonly handler: (c: HonoContext) => Promise<Response>
}
```

Wires into `admin.routes: RouteContribution[]`. The system auto-prefixes paths with `/api/plugins/{source}/` to namespace by package and prevent collisions across plugins. Required Zod `schema` per the existing MCP-discipline rule (admin-API routes are MCP-discoverable via Zod schemas).

One contribution per route; multi-route packages export multiple factories (`slackRouteTest`, `slackRoutePing`, etc.).

Capability gates use the standard Hono middleware contract from `design-auth-rbac.md`. Plugin-contributed capabilities use a plugin-specific prefix (`search:rebuild-index`, `webhook:test`); built-in prefixes (`read:`, `edit:`, `delete:`, `publish:`, `configure:`, `review:`, `restore:`, `comment:`, `mention:`, `subscribe:`, `audit:`) are reserved.

## `source` convention (locked across surfaces)

Every contribution carries a `source: string`. Convention:

| Source pattern | Use |
|---|---|
| `'@scope/package-name'` | npm-distributed package |
| `'github.com/org/repo'` | git-distributed package |
| `'site-local:{name}'` | operator-authored factory in their own project |
| any other unambiguous string | plugin author's preference |

The reserved value `'site-local'` (without colon-suffix) is auto-applied where a system path would otherwise be ambiguous. Plugin authors writing distributables always know their package name; declaring it is one line.

Audit log records `source` as a separate metadata field (per ADR-0009 + this design pass): `metadata.source: '@example/cdn-purge'`, `metadata.hookName: 'cdn-purge-on-save'` (or `metadata.routePath: '/test'` for routes). Two fields, not one composed string. Forensic queries filter on `source` alone or `source` + name.

Duplicate sources allowed — operators legitimately invoke the same factory twice with different config (two CDN-purge instances for different regions). Both register; both fire; per-handler `name` distinguishes them in audit.

## Service-account capability elevation

A factory whose contribution fires with a `Principal` (hooks, future review-transition contributions) may need elevated capabilities. Plugin authors declare the requirement via the contribution's `serviceAccount?: readonly Capability[]` field; operators approve by leaving it in their factory invocation.

```ts
// Plugin author
export function cdnPurge(opts: CdnPurgeOptions): HookContribution {
  return {
    source: '@example/cdn-purge',
    serviceAccount: ['read:audit-log'],          // declared — needed to read audit during purge
    hooks: [
      { phase: 'afterPublish', handler: ..., options: { name: 'cdn-purge-on-publish' } },
    ],
  }
}

// Operator approves implicitly by importing + invoking
admin: {
  hooks: [cdnPurge({ zone: '...', apiToken: process.env.CF_TOKEN! })],
}
```

When the hook fires, the principal's effective capabilities are unioned with the declared `serviceAccount` for the duration of the firing. Audit records the elevation: `metadata.serviceAccount: ['read:audit-log']`.

`RouteContribution` doesn't carry `serviceAccount` — route handlers run with the request's `Principal` directly; capability gates handle the auth path differently. `Validator` doesn't carry it — validators are pure functions; no `Principal` context. Only contribution shapes that fire with a `Principal` carry the field.

The locked-design `withServiceAccount(...)` operator-side wrapper rejected — declarations live with the package author who knows what their code does; operators approve by config invocation, not by wrapping.

## `optional()` lazy wrapper

By default, factory throws at config-eval = admin boot fails. For dev-only / environment-conditional plugins where failure should be tolerated, wrap with `optional()`:

```ts
import { optional } from 'gazetta'

admin: {
  hooks: [
    autoSlugify(),
    optional(() => devOnlyTool({ apiKey: process.env.MAYBE_KEY! })),  // factory throw → log + skip
  ],
}
```

Lazy thunk required (`() => factory(...)`) — by the time `optional(factory(...))` would evaluate, the inner factory has already thrown; lazy form lets `optional()` control when the work happens.

The loader filters skip markers from the contribution arrays before passing them to consumers (registry, route mounter, validator runner). Failure logs structured info (factory source, error category) so operators can investigate.

Alternative TS pattern (no `optional()`): conditional inclusion via array spread.

```ts
admin: {
  hooks: [
    autoSlugify(),
    ...(process.env.NODE_ENV === 'development' ? [devOnlyTool({...})] : []),
  ],
}
```

Use `optional()` for "the plugin might fail at boot, that's OK"; use array-spread for "the plugin is conditional on env."

## Multi-concern packages

A plugin that contributes to multiple surfaces exports multiple named factories. One factory per surface contribution; one return type per factory; one extension surface targeted per call.

```ts
// In @example/slack-notify
import type { HookContribution, RouteContribution } from 'gazetta'

interface SlackOptions {
  webhookUrl: string
  channel?: string
}

export function slackHook(options: SlackOptions): HookContribution {
  return {
    source: '@example/slack-notify',
    hooks: [{ phase: 'afterPublish', handler: ..., options: { name: 'slack-on-publish' } }],
  }
}

export function slackRoute(options: SlackOptions): RouteContribution {
  return {
    source: '@example/slack-notify',
    method: 'POST', path: '/test',
    capability: 'configure:site',
    schema: { request: TestRequestSchema, response: TestResponseSchema },
    handler: async (c) => { /* ... */ },
  }
}

// Optional shared-config bundling factory
export default function slackNotify(options: SlackOptions) {
  return { slackHook: slackHook(options), slackRoute: slackRoute(options) }
}
```

Operator imports the inner factories directly (sharper TS inference, opt-in per surface) OR uses the bundling factory (one import for shared config across surfaces). Either works.

## Versioning

Peer dependency on `gazetta` is the primary compatibility mechanism:

```json
{
  "name": "@example/slack-notify",
  "version": "1.0.0",
  "peerDependencies": { "gazetta": "^1.0.0" }
}
```

npm/yarn/pnpm warn at install time on peerDep mismatch. Same pattern as ESLint plugins, Vite plugins, Astro integrations.

Gazetta SemVer policy for contribution-shape interfaces:
- **Patch**: bug fixes only; no contribution-shape changes
- **Minor**: additive changes (new optional fields, new contribution shapes); existing factories remain compatible
- **Major**: breaking changes (removed/renamed fields, changed signatures); plugins update peerDep range

Per Universal Provider Requirement #7. Adding required methods to a Provider interface is breaking; new optional methods are additive. Same rule for contribution shape fields.

Site-local factories (no `package.json`) skip the version check — operator's own code; assumed compatible.

## Trust posture

Plugins run with full Node access. No sandbox. Sandboxing Node code in production-grade ways isn't feasible at acceptable cost — VM contexts leak, worker threads break the registration model, subprocess isolation has high overhead, Realm/ShadowRealm are experimental. Accept the trust model.

Operators evaluate plugins like any npm dependency. Plugins can read filesystem, make network calls, execute child processes. Supply chain attacks are real but already a general npm ecosystem concern.

Documentation responsibility: trust posture documented prominently in operator-facing docs. "Plugins run with full Node access — install only from sources you trust, pin versions, audit dependencies."

Plugin marketplace + curation: out of v1. Plugins distributed via standard npm registry. Operator's responsibility (or their org's security policy) to review.

## Foundational checks

How plugins compose with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Contribution arrays are static config; same across instances. Each instance evaluates `site.config.ts`, builds the same contributions, registers them against per-instance registries (hooks registry, validator registry, route mounter).
- Plugin-supplied Providers inherit Universal Provider Requirement #1 (multi-instance correctness via per-instance scope OR storage-coordinated atomicity).
- Plugin contributions MUST NOT hold cross-operation state in process; per-build / per-request scopes only. Hook handlers using `ctx.storage` for derived state follow the same multi-instance-safe patterns the core uses (per-edge sidecars, content-addressed blobs, etag-based writes).

### Scale (#1)
- Contribution arrays are evaluated once per process boot. At envelope, evaluation is microseconds — factory closures bind config and return shape.
- Per-handler timeouts apply per surface (hooks per `design-hooks.md`); validators run with stage-appropriate budgets per `design-validation.md`; routes have request-time cost like any Hono route.
- Heavy plugins (warm-cache-at-construction, network probe at construction) flagged in plugin author docs; operator evaluates fit for their scale.

### Locale (#2) + Themes (#3)
- Plugins that touch render output respect locale/theme via `RenderContext` (when render hooks ship per `design-rendering.md` future).
- Most plugins compose transparently — they receive `ctx` with locale/theme set.

### Auth + RBAC (#4)
- `RouteContribution.capability` gates each route via the standard Hono middleware contract.
- Plugin-contributed capabilities use a plugin-specific prefix; built-in prefixes reserved per `design-auth-rbac.md`.
- Service-account elevation (`HookContribution.serviceAccount`) provides opt-in capability union for hook firings; declared by package author, approved by operator import.

### Audit (#5)
- Hook firings audit per `design-hooks.md` Cut 7 with `metadata.source` + `metadata.hookName` separate (per ADR-0009 + this design pass).
- Route invocations audit as `action: 'plugin-route'` with `metadata.source + metadata.routePath`.
- Service-account elevations recorded in `metadata.serviceAccount`.
- Audit-fail-open posture preserved: plugin-action audit-record failure never propagates to caller.

### Review (#6)
- Plugin-supplied review workflow integrations (e.g., GitHub PR-as-review): reserved per `design-review-workflow.md`. v1 uses hooks for external integration.

### Hooks (#7)
- `admin.hooks` factory contributions are the primary distribution mechanism (hooks v1 Cut 9).
- Plugin hooks land in priority band 100-999 by default; built-in 0-99; site-local 1000+.

### Render (#8)
- Render-lifecycle hooks deferred per `design-rendering.md`.
- Plugins affecting rendering today do so via custom editors/fields/templates (file discovery) or via static contributions that hooks transform.

### Validation (#9)
- `admin.validators: Validator[]` ships with validation Cut 1.
- `Validator.source` field added in this design pass.
- Validators are pure functions per `design-validation.md`; plugin-contributed validators inherit the same purity contract.

### Cache (#11)
- Plugin-supplied cache providers register via `cache: customCache({...})` per ADR-0008. No `registerCacheProvider` runtime — the field accepts any `AdminCache` instance.

### Offline (#12)
- Plugin behavior during offline matches the host surface's offline contract per `design-offline.md`.
- Browser-side plugins (custom editors / fields) follow the offline-aware patterns in `design-offline.md`.

### Collaboration (#13)
- Plugin-supplied notification providers register at the `admin.notifications` field per the future `NotificationProvider` extension surface (per `design-collaboration.md`).
- Plugin hooks for `afterCommentPosted`, `afterMention` register via `admin.hooks` once collaboration ships.

### Site config ([`design-config.md`](design-config.md))
- Plugins are imported and invoked inline in `site.config.ts` via factory functions. Discovery surface is the config file.
- Plugin options are typed; TS inference at the call site catches misconfiguration at edit time. Runtime Zod still validates at load.
- `optional()` wrapper supports dev-only / environment-conditional plugins.

## Comparison to the locked design

The locked design pre-2026-05 specified:

| Locked design | What we have now |
|---|---|
| `Plugin` interface with `name`, `version`, `init(api)`, `dispose?()` | No `Plugin` interface. Packages export factories; that's the contract. |
| `PluginAPI` god-object with 11 register methods | No `PluginAPI`. Each surface has its own contribution mechanism (factory-call-at-field for Providers; typed arrays for Hooks/Validators/Routes). |
| Discovery via `admin.plugins: Plugin[]` array, serial async init | Discovery via per-surface arrays + provider fields. No init phase — factories construct at config-eval. |
| `RegistrationAfterInitError` | Not needed — registration is implicit at config-eval; no window to violate. |
| `Plugin.requires` advisory metadata | Dropped. Operators read package READMEs. Future admin UI inventory uses npm `package.json gazetta` field. |
| `withServiceAccount(plugin, capabilities)` operator-side wrapper | `serviceAccount` field on the contribution; declared by author, approved by import. |

None of the locked design's runtime constructs were ever implemented — only documented in shipped code as JSDoc references to its intent. The transition is documentation-only.

## Migration

Existing surfaces continue to work — the design pass is documentation-only on the user-facing side. Per-surface implementation work lands as those surfaces ship:
- Hook audit `source` field — ✓ already shipped (hooks v1 Cut 7 + Cut 9). Locked here so the contract is durable.
- `admin.validators` with validation Cut 1
- Service-account elevation with auth/RBAC's service-account primitive
- `admin.routes` standalone when first concrete demand surfaces

No `gazetta migrate-plugins` CLI; nothing to migrate (the locked plugin runtime never shipped).

## Future directions

- **Plugin marketplace** — npm registry filter, curated listings — out of scope for v1
- **Plugin hot-reload** — out of scope; reload requires admin restart
- **Plugin-defined surfaces** (a plugin defining a new extension surface other plugins target) — out of v1; trigger pattern: 3+ operator requests for the same kind of new surface within 6 months → Gazetta adds it as a first-class extension surface in-tree
- **Admin UI plugin inventory** — when shipped, plugin metadata reaches it via npm `package.json gazetta` field rather than contribution-shape fields
