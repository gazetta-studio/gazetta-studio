---
paths:
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/assets.ts"
  - "packages/gazetta/src/admin-api/routes/publish.ts"
  - "packages/gazetta/src/renderer.ts"
  - "**/hook*"
---

# Hooks

Foundational dimension #7 of 13. Extension surface for save/publish/load lifecycles. Auto-slugify, auto-tag, validate against external API, enrich content at save time, send notifications on publish.

**Status**: design pass complete (2026-05). Implementation phases sit in Tier 3.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Hook check** every new primitive design must answer
- [`design-auth-rbac.md`](design-auth-rbac.md) — hook payload includes actor identity via `Principal` (requires auth/RBAC settled first)
- [`design-audit.md`](design-audit.md) — hook firings are recorded as audit events with the triggering actor
- [`design-plugins.md`](design-plugins.md) — hooks are an extension surface; plugin contract specifies how they're discovered + composed

**Reference**: [Payload Hooks](https://payloadcms.com/docs/hooks/overview).

## Why this is foundational

Hooks are foundational because every save / publish / load / render operation could fire hooks. Designing late means every primitive becomes hookable retroactively. That's structural rework on every consumer.

Audit category #2 from the CMS feature audit. Template Developer pain point.

## Locked invariants

### Inherited from prior design
- **Hooks compose with audit log.** A hook firing is an audit-loggable event (recorded actor, target, payload, result).
- **Hooks compose with RBAC.** Hook handlers receive actor identity via `Principal`; can authorize against role.
- **Hooks compose with the plugin contract.** Plugins are discovered and loaded per `design-plugins.md`; hooks are one of the things plugins can register.
- **Hooks fire AFTER validation, not during.** Per `design-validation.md`'s Foundational checks: validators are pure functions; firing hooks during validation creates circular dependencies. Validators run first; hooks fire on validated payload.

### Locked in this design pass

**v1 lifecycle phases** (Q1 locked):

```
Content lifecycle:
  beforeSave(scope, payload, ctx)   → mutated payload | throw to cancel
  afterSave(scope, result, ctx)     → void (observe)
  afterLoad(scope, result, ctx)     → mutated result (read-time enrichment)

Publish lifecycle:
  beforePublish(target, items, ctx) → mutated items | throw to cancel
  afterPublish(target, result, ctx) → void (observe)

Asset lifecycle:
  beforeUpload(asset, bytes, ctx)   → mutated bytes | throw to cancel
  afterUpload(asset, result, ctx)   → void (observe)

Review lifecycle (per design-review-workflow.md):
  beforeSubmitForReview  / afterSubmitForReview
  beforeApprove          / afterApprove
  beforeReject           / afterReject
  beforePublishRequest   / afterPublishRequest
  beforePublishApprove   / afterPublishApprove
```

**Naming convention** (locked):

| Pattern | Semantics |
|---|---|
| `before*` | Mutating; can cancel by throwing; blocks operation. Mutated payload returned to operation. |
| `after*` | Observing; cannot cancel. Result of operation is read-only. |

**Sync-blocking-with-timeout** (locked): all hooks return `Promise<...>`; operation awaits the hook result. Per-hook timeout (default 5s, configurable per hook) caps latency. Fire-and-forget mode (`mode: 'async'`) reserved for v2 — not v1.

**Why blocking, not fire-and-forget:**
- Multi-instance discipline: fire-and-forget on a killed process loses events. Blocking guarantees attempt completion.
- Audit alignment: matches `design-audit.md` Q3's sync-fail-open posture.
- Debuggability: hook latency surfaces in standard response-time monitoring.
- Operator predictability: response time = operation time + sum of hook times. Honest.

**Phases NOT in v1**:

| Phase | Why deferred |
|---|---|
| Render hooks (`beforeRender`, `afterRender`) | Per `design-rendering.md` Foundational checks: render hooks reserved for hooks design pass. v1 keeps render layer narrow — performance-critical, unbounded cost. Reserve until concrete operator demand. |
| Validation hooks | Per `design-validation.md`: validators are the validation primitive, not hooks-in-disguise. No `validate` hook category. |
| Audit hooks | Audit observes writes via the audit log itself; no separate hook firings. |
| `beforeLoad` | Nothing's loaded yet to mutate; only `afterLoad` makes sense. |

**Save flow with hooks** (locked sequence):

1. Save handler receives request
2. Validators run (save-delta) → fail with 409 on error
3. `beforeSave` hooks fire → can mutate payload or throw to cancel
4. Storage write
5. `afterSave` hooks fire → observe the result
6. Response sent

**Asset upload note**: `beforeUpload` / `afterUpload` are general-purpose hooks distinct from the existing `UploadPreprocessor` / `UploadAnalyzer` abstractions in media v1. Preprocessor/Analyzer are byte-stream-specific (sanitization, EXIF analysis, animated detection); hooks are general (auto-tag from filename, derive captions from EXIF metadata, copy to backup bucket). Both layers run; preprocessor/analyzer first (transforms bytes), hooks second (operate on the resulting asset manifest + bytes).

## Hook contract shape (Q2 locked)

**Signature** — return-new-payload (functional, not mutate-in-place, not delta-style):

```ts
// Content lifecycle
type BeforeSaveHook<T> = (
  scope: Scope,
  payload: T,
  ctx: HookContext
) => Promise<T>

type AfterSaveHook<T> = (
  scope: Scope,
  result: SaveResult<T>,
  ctx: HookContext
) => Promise<void>

type AfterLoadHook<T> = (
  scope: Scope,
  result: T,
  ctx: HookContext
) => Promise<T>

// Publish lifecycle
type BeforePublishHook = (
  target: TargetName,
  items: PublishItem[],
  ctx: HookContext
) => Promise<PublishItem[]>

type AfterPublishHook = (
  target: TargetName,
  result: PublishResult,
  ctx: HookContext
) => Promise<void>

// Asset lifecycle
type BeforeUploadHook = (
  asset: AssetMetadata,
  bytes: Uint8Array,
  ctx: HookContext
) => Promise<{ asset: AssetMetadata, bytes: Uint8Array }>

type AfterUploadHook = (
  asset: AssetMetadata,
  result: UploadResult,
  ctx: HookContext
) => Promise<void>

// Review lifecycle
type BeforeReviewTransitionHook = (
  scope: Scope,
  transition: ReviewTransition,
  ctx: HookContext
) => Promise<ReviewTransition>

type AfterReviewTransitionHook = (
  scope: Scope,
  result: ReviewTransitionResult,
  ctx: HookContext
) => Promise<void>
```

**`Scope` shape** matches `design-audit.md`'s scope:

```ts
type Scope = {
  kind: 'page' | 'fragment' | 'asset' | 'site'
  name?: string
  locale?: string
  theme?: string
}
```

**`HookContext` shape** — request context propagated to every hook:

```ts
interface HookContext {
  /** Auth/RBAC principal that triggered this operation */
  principal: Principal
  /** Active target name */
  target: TargetName
  /** Per-request correlation ID (matches design-audit.md's requestId) */
  requestId: string
  /** Request timestamp; deterministic across all hooks in this request */
  now: Date
  /** Logger scoped to this hook firing (correlates with audit log) */
  log: HookLogger
  /** Read-only access to site config for hooks that need it */
  site: SiteConfig
  /** Storage handle when hooks need to read other content
   *  (e.g., a beforeSave hook validating against existing pages).
   *  Reads only; writes go through the operation that fired the hook. */
  storage: ReadOnlyStorageProvider
}
```

**Mutation rules** (locked):

1. **`before*` hooks return mutated payload.** Returned value proceeds to the operation. Same-reference or new-object both valid.
2. **`before*` hooks throw to cancel.** Operation aborts with the hook's error. Audit event records cancellation; outcome value reserved (provisionally `'hook-cancelled'`, locked-enum extension to `design-audit.md`'s outcome).
3. **`after*` hooks return `Promise<void>`.** No mutation; observe-only.
4. **`after*` failures fail-open.** Operation already succeeded. Failure logged to audit + structured log; never propagated to caller. Matches `design-audit.md` Q3's fail-open posture.
5. **Payload immutability by convention.** Handlers should not mutate input directly; return new payload. Enforced by `Object.freeze` in dev mode; production trusts the contract.
6. **Hooks can read but not write storage.** `ctx.storage` is `ReadOnlyStorageProvider` (subset of `StorageProvider` with read methods only). Writes go through the operation that fired the hook by mutating the returned payload. Prevents hook-vs-operation write races.

**Why return-new-payload (B), not mutate-in-place (A) or delta (C)**:
- TS-typesafe (input shape = output shape; no Partial<> structural-checks)
- Composes naturally for multi-hook chains (output of hook 1 = input of hook 2 — see Q3)
- Audit "before/after" snapshot is trivial (log input + log return)
- Familiar functional shape; mutation-in-place is unfamiliar to JS audiences

**The before/after invariant**:
- `before*`: see payload as authored, return what should be persisted
- `after*`: see what was persisted, observe (notify, log, trigger external work)

## Composition (Q3 locked)

When multiple hooks register for the same phase, ordering is **priority-based**:

```ts
interface HookRegistration<T extends HookFn> {
  /** Hook handler */
  handler: T
  /** Optional human-readable name for diagnostics + audit */
  name?: string
  /** Lower runs earlier. Default 100. */
  priority?: number
  /** Optional per-hook timeout (ms). Default 5000. */
  timeout?: number
}
```

**Priority bands** (convention, not enforced):

| Band | Reserved for |
|---|---|
| 0-99 | Built-in Gazetta hooks |
| 100-999 | Plugin-supplied hooks |
| 1000+ | Site-local hooks |

Site hooks run last (highest priority number) so they see the result of plugin hooks. Operators can violate the convention with explicit intent.

**Tie-breaking**: same priority resolves to registration order. Stable sort.

**Composition rules**:

1. **`before*` hooks chain.** Output of hook N = input of hook N+1. Final output proceeds to operation.
2. **`after*` hooks run independently.** Each receives the same operation result. No chaining.
3. **One `before*` throws, all stop.** Operation cancels; subsequent hooks don't fire. Audit event records which hook cancelled.
4. **`after*` failures don't stop the chain.** All `after*` hooks fire even if earlier ones failed. Failures log independently (matches `design-audit.md` Q3's `Promise.allSettled` posture).

**Per-hook timeout** (default 5s, configurable per registration):
- `before*` timeout = throw = cancel operation
- `after*` timeout logged; chain continues

**No total operation timeout in v1.** Per-hook timeout is the cap. Operators with N hooks averaging 1s each see ~N seconds operation latency — predictable, tunable. Total cap reserved if observed pain surfaces.

**Audit events** (closed-enum extensions to `design-audit.md`):

```ts
{
  action: 'hook-fired',
  outcome: 'success' | 'hook-cancelled' | 'failed-render' | 'timeout',
  actor: { /* operation's principal */ },
  scope: { /* operation's scope */ },
  metadata: {
    hookName: 'auto-slugify',
    hookPriority: 1000,
    hookPhase: 'beforeSave',
    durationMs: 42,
    requestId: '...',
  }
}
```

`action: 'hook-fired'` and `outcome: 'hook-cancelled'` are closed-enum extensions to the audit `action` and `outcome` enums respectively. Multiple hooks per operation = multiple events; correlation via `requestId`.

## Discovery (Q4 locked)

Hook handlers come from two sources:

1. **Site-local** — files in `admin/hooks/*.ts` (the common case for site-specific logic)
2. **Plugin-supplied** — registered via the plugin contract (per `design-plugins.md`; for distributable cross-site logic)

Both register against the same priority-sorted dispatch. Both run with the same lifecycle, same `HookContext`, same audit shape.

**Site-local layout**:

```
my-project/
  admin/
    hooks/                        # NEW
      auto-slugify.ts             # one file per hook
      cdn-purge.ts
      audit-mirror.ts
    editors/                      # existing
    fields/                       # existing
  templates/                      # existing
  sites/
    main/
      site.config.ts
      pages/
      fragments/
```

**Hook file shape**:

```ts
// admin/hooks/auto-slugify.ts
import type { BeforeSaveHook } from 'gazetta/hooks'

export const beforeSave: BeforeSaveHook<PageManifest> = async (scope, payload, ctx) => {
  if (scope.kind !== 'page') return payload
  if (payload.metadata.slug) return payload
  return {
    ...payload,
    metadata: { ...payload.metadata, slug: slugify(payload.metadata.title ?? '') }
  }
}

// Optional metadata
export const meta = {
  name: 'auto-slugify',
  priority: 1000,
  timeout: 1000,
}
```

One file CAN export multiple phases (e.g., a CDN-purge hook exports `afterPublish` AND `afterSave`).

**Discovery mechanism** (admin boot):
1. Walk `admin/hooks/*.{ts,js}`
2. Dynamic-import each file
3. Extract named exports matching hook phase names
4. Apply optional `meta` for name / priority / timeout
5. Register against the appropriate phase

**Plugin-supplied registration** (per pending `design-plugins.md`):

```ts
// In a plugin
import { registerHook } from 'gazetta/plugins'

export default function plugin(api) {
  api.registerHook('beforePublish', async (target, items, ctx) => {
    // ...
  }, { name: 'cdn-purge', priority: 200 })
}
```

The exact plugin API surface is `design-plugins.md`'s concern. Hooks design pass commits: plugin-registered hooks land in the same dispatch as site-local hooks (priority-sorted, same lifecycle, same audit).

**Naming + namespacing**:
- Site-local hooks: name = file basename or `meta.name` (e.g., `'auto-slugify'`)
- Plugin-supplied hooks: name = `@plugin-name:hookName` (e.g., `'@gazetta/cdn-purge:purge'`)

Audit `metadata.hookName` carries the namespaced form. Forensic queries can filter by namespace pattern. No name collisions because namespacing structurally differs.

**Trust posture**:
- Site-local hooks: operator's own code; trusted as the operator
- Plugin-supplied hooks: third-party npm code; full Node access per `design-plugins.md` stub locks ("npm packages have no sandbox — accept and document")
- Both run with the triggering principal's capabilities by default
- Plugin-supplied hooks needing elevated access declare `serviceAccount` capabilities (operator-approved per-plugin in `site.config.ts`); deferred to `design-plugins.md`

**Hot-reload (deferred)**: v1 hook changes require admin restart. Site-local file watcher hot-reload reserved when v2 plugin hot-reload lands.

**Disable-by-config (deferred)**: v1 disables a hook by deleting the file (site-local) or unconfiguring the plugin. Future:

```ts
// Reserved for v2
export default defineSite({
  admin: {
    hooks: {
      disable: [
        'auto-slugify',
        '@gazetta/cdn-purge:purge',
      ],
    },
  },
})
```

**Plugin-promotion path**: a site-local hook can be extracted to an npm package + plugin without changing handler signature. The dispatch surface is identical — only registration differs.

## Foundational checks

How hooks compose with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Hook handlers run on whichever admin instance receives the save/publish request. No cross-instance ordering or coordination — the writing instance fires its own hooks against its own request.
- Hook state: handlers MUST NOT keep state between firings within a process (state would diverge across instances). State that persists goes through storage like any other write.
- `ctx.storage` is `ReadOnlyStorageProvider` — hooks can read from storage but cannot write. Writes happen via the operation that fired the hook (mutating returned payload).
- Plugin-supplied hooks inherit these rules.
- Discovery is per-instance: each instance walks `admin/hooks/` at boot; same files = same hooks across all instances. Plugin packages in `node_modules` deployed identically.

### Scale (#1)
- Per-hook timeout default 5s caps individual hook latency.
- N hooks per operation = N × hook latency (sequential `before*` chain; parallel `after*` independent).
- Operators with many hooks see proportional response-time growth — observable, tunable.
- No total operation timeout in v1; per-hook cap is the bound. Total cap reserved if observed pain surfaces.

### Locale (#2)
- `Scope` carries optional `locale`; hooks can branch on locale to apply locale-specific transforms (e.g., locale-specific slug rules).
- Hooks fire once per save (not per-locale-variant); a locale-variant save fires hooks with `scope.locale` set.

### Themes (#3)
- `Scope` carries optional `theme` for theme-variant content.
- Hooks generally don't need to touch theme; informational only.

### Auth + RBAC (#4)
- `HookContext.principal` is the load-bearing input. Hooks gate behavior on actor identity.
- Hooks run with the triggering principal's capabilities by default — they don't gain elevated access.
- Plugin-supplied hooks needing service-account capabilities declare them per-plugin (deferred to `design-plugins.md`).

### Audit (#5)
- Every hook firing emits an audit event (`action: 'hook-fired'`, `outcome: 'success' | 'hook-cancelled' | 'failed-render' | 'timeout'`). Closed-enum extensions to `design-audit.md`.
- Audit metadata records `hookName`, `hookPriority`, `hookPhase`, `durationMs`, `requestId`.
- `before*` hook cancellations record with `outcome: 'hook-cancelled'`; original operation also records its `outcome: 'forbidden'` (capability denial wraps the cancellation).
- Audit-fail-open posture: hook firing audit-record failure never propagates to the hook caller (per `design-audit.md` Q3).

### Review (#6)
- Review state machine transitions fire hooks per `design-review-workflow.md`'s 10 touchpoints.
- Review-state-changing hooks audit normally with `action: 'review-submit' | 'review-approve' | ...`; hook firings are separate `action: 'hook-fired'` events.
- A `beforeApprove` hook can throw to cancel the approval — same mechanism as any other `before*` cancellation.

### Render (#8)
- Render-lifecycle hooks (`beforeRender`, `afterRender`) NOT in v1 (per `design-rendering.md`). Reserved.
- Hooks DO fire on save/publish — those events trigger renders downstream, but the hook fires on the operation, not the render.

### Validation (#9)
- Hooks fire AFTER validation, not during. Save flow: validators run → `beforeSave` hooks fire on validated payload → storage write → `afterSave` hooks observe.
- Validators are pure functions per `design-validation.md`; hooks are observers/transformers. Distinct extension surfaces.

### Plugin (#10)
- Hooks are an extension surface registered via the plugin contract (per `design-plugins.md`'s upcoming pass).
- Plugin-supplied hooks land in the same priority-sorted dispatch as site-local hooks.
- Plugin-promotion path: site-local hook (file in `admin/hooks/`) → npm package + plugin registration. Same handler signature; only registration differs.

### Cache (#11)
- Hook results not cached. Each operation fires hooks fresh.
- A `beforeSave` hook that does expensive computation can use `ctx.storage` to cache results in a sidecar (operator's responsibility); Gazetta doesn't auto-cache hook output.

### Offline (#12)
- Save/publish queued offline + replayed on reconnect — replay fires hooks on the receiving instance per the standard flow.
- Hook firings during offline replay record `metadata.replayed: true` (matches `design-offline.md`'s pattern from `design-audit.md` Foundational checks).

### Collaboration (#13)
- Collaboration events (comment posted, mention sent) will fire their own hooks per `design-collaboration.md`'s upcoming pass — `afterCommentPosted`, `afterMention`.
- Plugin authors can wire external systems to collaboration via these hooks (Linear ticket on `#bug` mention, Slack notification on review comment).

## Migration

Sites without hooks configured continue to work — hook system is opt-in. Adding hooks doesn't change existing primitive shape; hooks are observers/transformers on top.

## Future directions

- Visual hook editor in admin UI — operator configures hooks without code
- Hook marketplace — npm package discovery for common patterns (slug, SEO defaults, etc.)
- Cross-site hooks (hooks that fire on multiple sites in a multi-site project) — out of scope for v1
