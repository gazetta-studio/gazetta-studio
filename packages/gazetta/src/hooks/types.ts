/**
 * Hook types — the contract every hook handler implements + the
 * dispatch metadata the registry consumes.
 *
 * Per design-hooks.md "Locked invariants":
 *
 *   - Naming convention: `before*` mutates payload + can cancel via
 *     throw; `after*` observes only + cannot cancel.
 *   - Sync-blocking-with-timeout: every hook returns Promise<T>;
 *     operation awaits; per-hook timeout (default 5s) caps latency.
 *   - Mutation rules: `before*` returns the new payload (functional,
 *     not mutate-in-place, not delta-style). `after*` returns void.
 *   - `before*` throws to cancel — operation aborts with the hook's
 *     error; audit records `outcome: 'hook-cancelled'`.
 *   - `after*` failures fail-open per Universal Provider Requirement
 *     #5; operation already succeeded, failure logged, never
 *     propagated.
 *
 * # Why functional return-new-payload (option B from grilling)
 *
 *   - TS-typesafe: input shape = output shape; no Partial<>
 *     structural-checks
 *   - Composes naturally for multi-hook chains (output of N = input
 *     of N+1)
 *   - Audit "before/after" snapshot trivial (log input + log return)
 *   - Familiar functional shape; mutate-in-place is unfamiliar in
 *     a JS audience
 *
 * # The before/after invariant
 *
 *   - `before*` sees payload as authored, returns what should be
 *     persisted
 *   - `after*` sees what was persisted, observes (notify, log,
 *     trigger external work)
 *
 * # Phase enum is forward-compatible
 *
 * `HookPhase` is the closed union for v1's lifecycle phases. Cut 8
 * extends with the 10 review-lifecycle phases (forward-compat for
 * `design-review-workflow.md`'s state machine when it ships).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the contract vocabulary. Doesn't read
 *     storage; pure types.
 *   - DIP: registry, dispatcher, plugin loader all depend on these
 *     types — never on which specific handler produced the change.
 *   - LSP: every handler honoring the typed signature is
 *     substitutable in the registry; consumers never branch on
 *     handler identity.
 */
import type { Principal } from '../auth/types.js'
import type { ReadOnlyStorageProvider } from './storage.js'
import type { HookFiringEmitter } from './audit-emitter.js'

/**
 * Closed union of v1 hook phases.
 *
 * Naming: `before*` (mutating, can cancel), `after*` (observational).
 *
 * Cut 8 will extend this union with the 10 review-lifecycle phases
 * forward-locked in design-review-workflow.md (`beforeSubmitForReview`,
 * `afterSubmitForReview`, `beforeApprove`, `afterApprove`,
 * `beforeReject`, `afterReject`, `beforePublishRequest`,
 * `afterPublishRequest`, `beforePublishApprove`,
 * `afterPublishApprove`).
 *
 * Render-lifecycle hooks (`beforeRender`, `afterRender`) reserved
 * per design-rendering.md; not in v1.
 */
export type HookPhase =
  // Content lifecycle
  | 'beforeSave'
  | 'afterSave'
  | 'afterLoad'
  // Publish lifecycle
  | 'beforePublish'
  | 'afterPublish'
  // Asset lifecycle
  | 'beforeUpload'
  | 'afterUpload'
  // Review lifecycle (forward-compat per design-review-workflow.md;
  // the state machine that fires these ships in Phase 2 — see
  // design-review-workflow-implementation.md Cut 14)
  | 'beforeSubmitForReview'
  | 'afterSubmitForReview'
  | 'beforeApprove'
  | 'afterApprove'
  | 'beforeReject'
  | 'afterReject'
  | 'beforePublishRequest'
  | 'afterPublishRequest'
  | 'beforePublishApprove'
  | 'afterPublishApprove'

/**
 * Scope of the operation that fired the hook. Mirrors
 * `design-audit.md`'s `AuditScope` shape so hooks and audit events
 * speak the same vocabulary.
 */
export interface HookScope {
  kind: 'page' | 'fragment' | 'asset' | 'site'
  /** Item name when applicable. */
  name?: string
  /** Active locale when known (per design-i18n.md). */
  locale?: string
  /** Active theme when known (per design-themes.md). */
  theme?: string
}

/**
 * Read-only, opaque request context propagated to every hook.
 *
 * Locked per design-hooks.md "HookContext shape":
 *
 *   - Carries Principal so hooks can branch on actor identity
 *   - Carries `requestId` for audit + log correlation
 *   - Carries `now` so hooks see a deterministic timestamp shared
 *     by all hooks in the request (hooks don't read `Date.now()`
 *     directly — eliminates "did beforeSave and afterSave see the
 *     same wall clock?" ambiguity)
 *   - Carries `target` (active target name) so hooks can branch on
 *     the destination
 *   - Carries `site` config (read-only) for hooks that need to
 *     consult target / locale / theme settings
 *   - Carries `storage` as a `ReadOnlyStorageProvider` (writes go
 *     through the operation; hooks can't escape the op's atomicity
 *     by writing through ctx.storage — see design-hooks.md
 *     "Mutation rules" #6)
 *   - Carries `log` scoped to this hook firing for structured
 *     correlation with the audit log per design-logging.md
 */
export interface HookContext {
  /** Auth/RBAC principal that triggered this operation. */
  readonly principal: Principal
  /** Active target name (when relevant). */
  readonly target?: string
  /** Per-request correlation ID. Matches audit + log ids. */
  readonly requestId: string
  /** Request timestamp; deterministic across all hooks in this request. */
  readonly now: Date
  /** Logger scoped to this hook firing. */
  readonly log: HookLogger
  /** Read-only access to site configuration. */
  readonly site: ReadOnlySiteConfig
  /** Read-only access to storage. Hooks cannot write through ctx; writes go through the operation. */
  readonly storage: ReadOnlyStorageProvider
  /**
   * Optional audit emitter — when set, dispatch records one
   * `action: 'hook-fired'` audit event per hook firing.
   * Production wires this to the audit recorder; tests + the
   * dispatch unit tests omit it for silent firing.
   *
   * Per design-hooks.md "Audit events" + design-audit.md's
   * locked enum extensions.
   */
  readonly auditEmit?: HookFiringEmitter
}

/**
 * Minimal logger interface scoped to a hook firing. Mirrors the
 * shape from design-logging.md. Concrete logger implementation
 * lives in the logging foundation (Tier 3); v1 hooks dispatch
 * supplies a no-op logger or pino child as available.
 */
export interface HookLogger {
  debug(obj: object | string, msg?: string): void
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

/**
 * Read-only view of the site config every hook receives.
 * Intentionally narrow — hooks shouldn't reach into the full
 * SiteManifest (couples hooks to manifest shape changes) but DO
 * legitimately need locale + theme + target metadata.
 *
 * Concrete shape filled in by Cut 2's dispatcher when it constructs
 * HookContext.
 */
export interface ReadOnlySiteConfig {
  /** Site display name. */
  readonly name?: string
  /** Configured locale defaults + supported list (when locales enabled). */
  readonly locales?: { default?: string; supported?: ReadonlyArray<string> }
  /** Configured theme defaults + supported list (when themes enabled). */
  readonly themes?: { default?: string; supported?: ReadonlyArray<string> }
  /** Currently-active target's metadata (name + environment + editable). */
  readonly activeTarget?: { name: string; environment?: string; editable?: boolean }
}

/**
 * Per-phase typed handler signatures. Each `before*` returns the
 * (possibly mutated) payload; each `after*` returns void.
 *
 * Generic parameter `T` ties the payload type to the operation's
 * shape — `BeforeSaveHook<PageManifest>` and
 * `BeforeSaveHook<FragmentManifest>` are different specializations
 * of the same shape.
 */
export type BeforeSaveHook<T = unknown> = (scope: HookScope, payload: T, ctx: HookContext) => T | Promise<T>

export type AfterSaveHook<T = unknown> = (
  scope: HookScope,
  result: SaveResult<T>,
  ctx: HookContext,
) => void | Promise<void>

export type AfterLoadHook<T = unknown> = (scope: HookScope, result: T, ctx: HookContext) => T | Promise<T>

/** Result of a save operation visible to `afterSave` hooks. */
export interface SaveResult<T> {
  /** The persisted payload (post-validation, post-`beforeSave`). */
  readonly payload: T
  /** Etag/hash of the persisted manifest (when computed). */
  readonly etag?: string
}

export type BeforePublishHook = (
  target: string,
  items: ReadonlyArray<PublishItem>,
  ctx: HookContext,
) => ReadonlyArray<PublishItem> | Promise<ReadonlyArray<PublishItem>>

export type AfterPublishHook = (target: string, result: PublishHookResult, ctx: HookContext) => void | Promise<void>

/**
 * Item visible to publish hooks. Narrow shape — hooks see what's
 * being published (kind + name + path) without coupling to internal
 * publish-pipeline structures.
 */
export interface PublishItem {
  readonly kind: 'page' | 'fragment' | 'asset'
  readonly name: string
  readonly path: string
}

/**
 * Result of a publish operation visible to `afterPublish` hooks.
 * Carries the outcome (which items succeeded / failed) without
 * coupling hooks to the internal publish-pipeline shapes.
 */
export interface PublishHookResult {
  readonly target: string
  readonly itemsPublished: ReadonlyArray<PublishItem>
  readonly itemsFailed: ReadonlyArray<{ item: PublishItem; reason: string }>
}

export type BeforeUploadHook = (
  asset: UploadHookAsset,
  bytes: Uint8Array,
  ctx: HookContext,
) => UploadHookPayload | Promise<UploadHookPayload>

export type AfterUploadHook = (
  asset: UploadHookAsset,
  result: UploadHookResult,
  ctx: HookContext,
) => void | Promise<void>

/**
 * Asset metadata visible to upload hooks. Narrow — hooks see name
 * + mime + dimensions without coupling to the full media manifest.
 */
export interface UploadHookAsset {
  readonly name: string
  readonly mime: string
  readonly size: number
  readonly width?: number
  readonly height?: number
  readonly alt?: string
}

/** Mutated upload payload returned by `beforeUpload` hooks. */
export interface UploadHookPayload {
  readonly asset: UploadHookAsset
  readonly bytes: Uint8Array
}

/** Result visible to `afterUpload` hooks. */
export interface UploadHookResult {
  readonly asset: UploadHookAsset
  readonly hash: string
}

/**
 * Review-lifecycle hook payload. Forward-compat per
 * `design-review-workflow.md` Cut 14. The state machine carries
 * (scope, actor, optional comment for reject); hook handlers see
 * the same.
 *
 * v1 ships the types only. The state machine that fires these
 * transitions hasn't been implemented yet — site-local hooks
 * registered for review phases sit dormant until the state
 * machine ships.
 */
export interface ReviewTransition {
  /** Scope of the transition (page/fragment/asset). */
  readonly scope: HookScope
  /** Reason / comment for reject + publish-reject; required by
   *  state machine on those transitions, undefined elsewhere. */
  readonly comment?: string
  /** For publish-request / publish-approve: the destination target. */
  readonly target?: string
}

export type BeforeReviewTransitionHook = (
  transition: ReviewTransition,
  ctx: HookContext,
) => ReviewTransition | Promise<ReviewTransition>

export type AfterReviewTransitionHook = (transition: ReviewTransition, ctx: HookContext) => void | Promise<void>

/**
 * Erased-type union of all v1 handler signatures. The registry
 * stores `HookHandler<P>` keyed by `HookPhase`; dispatch reads them
 * back and re-narrows via the phase-specific signature types.
 *
 * Review-lifecycle phases all share the same signature shape per
 * design-review-workflow.md — the transition object carries the
 * per-phase semantic via its fields (`comment` for reject,
 * `target` for publish-request). Phase identity in the registration
 * tells dispatch + audit which hook fired.
 */
export type HookHandler<P extends HookPhase = HookPhase> = P extends 'beforeSave'
  ? BeforeSaveHook
  : P extends 'afterSave'
    ? AfterSaveHook
    : P extends 'afterLoad'
      ? AfterLoadHook
      : P extends 'beforePublish'
        ? BeforePublishHook
        : P extends 'afterPublish'
          ? AfterPublishHook
          : P extends 'beforeUpload'
            ? BeforeUploadHook
            : P extends 'afterUpload'
              ? AfterUploadHook
              : P extends
                    | 'beforeSubmitForReview'
                    | 'beforeApprove'
                    | 'beforeReject'
                    | 'beforePublishRequest'
                    | 'beforePublishApprove'
                ? BeforeReviewTransitionHook
                : P extends
                      | 'afterSubmitForReview'
                      | 'afterApprove'
                      | 'afterReject'
                      | 'afterPublishRequest'
                      | 'afterPublishApprove'
                  ? AfterReviewTransitionHook
                  : never

/**
 * Optional per-registration metadata. Operators / plugin authors
 * declare priority + name + timeout when registering a handler;
 * defaults applied by the registry when omitted.
 */
export interface HookOptions {
  /**
   * Lower runs earlier. Default 100.
   *
   * Priority bands (convention, not enforced):
   *   - 0-99: built-in Gazetta hooks
   *   - 100-999: plugin-supplied hooks
   *   - 1000+: site-local hooks
   *
   * Site hooks run last so they see the result of plugin hooks.
   * Operators violate the convention with explicit intent.
   */
  readonly priority?: number
  /** Human-readable name for diagnostics + audit. */
  readonly name?: string
  /** Per-hook timeout (ms). Default 5000. */
  readonly timeout?: number
}

/**
 * Concrete registration record — handler + phase + resolved
 * metadata. The registry stores these; dispatch reads them in
 * priority order.
 */
export interface HookRegistration<P extends HookPhase = HookPhase> {
  readonly phase: P
  readonly handler: HookHandler<P>
  readonly priority: number
  readonly name: string
  readonly timeout: number
  /**
   * Stable insertion sequence — used as the tie-breaker for stable
   * priority sort (handlers with the same priority run in
   * registration order).
   */
  readonly sequence: number
  /**
   * Source identity for diagnostics. `'site-local'` for hooks
   * discovered from `admin/hooks/*.ts`; plugin name (e.g.,
   * `'@gazetta/slack-notify'`) for plugin-registered hooks.
   * `'built-in'` reserved for Gazetta's own internal hooks.
   */
  readonly source: string
}
