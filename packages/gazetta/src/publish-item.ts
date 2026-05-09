/**
 * Publish pipeline (per-item) — orchestrator for one Page or Fragment
 * write to one Target.
 *
 * Today's `publish-rendered.ts` has 5 publish-* exports
 * (`publishPageRendered`, `publishPageStatic`, `publishFragmentRendered`,
 * `publishArchiveMarker`, `publishSiteManifest`) each repeating the same
 * 13-step sequence: archive precheck → resolve → render → assemble →
 * list-old-files → write-new → cleanup → write hash sidecar → write
 * publish-state sidecar. Adding the soft-delete archive marker (Cut 3)
 * had to land in three places. Adding scheduled-publish or review-state
 * gates would too.
 *
 * `publishItemCore` is the seam that hides the orchestration. Per-kind
 * wrappers (`publishPage`, `publishFragment` in pages/publish.ts +
 * fragments/publish.ts — Cut 4) own kind-specific dispatch:
 * page resolves render-mode from target.type (static vs esi vs dynamic);
 * fragment has only one mode; archive short-circuit applies to both.
 *
 * Pipeline order is locked semantics, not configuration. Per-item:
 *
 *   1. (RESERVED) review-state precheck — Review Cut 5 (pending-review
 *      behavior at publish time)
 *   2. archive precheck (isArchived → route to archive-marker renderer)
 *   3. resolve item from preloadedSite (locale variant if applicable)
 *   4. (RESERVED) dispatchBeforePublishItem hooks
 *   5. invoke renderer (page-rendered / page-static / fragment-rendered /
 *      archive-marker)
 *   6. assemble HTML + CSS + JS (per renderer's output)
 *   7. list old hashed files at item dir
 *   8. write new hashed files (per-file atomic via storage.writeFile;
 *      transient failures retry inline 3x with backoff)
 *   9. write item HTML + content-hash sidecar (.{8hex}.hash)
 *  10. cleanup oldFiles − newFiles
 *  11. write publish-state sidecar (.pub-{ts}, includes noindex flag)
 *  12. (RESERVED) dispatchAfterPublishItem hooks
 *  13. return PublishItemResult
 *
 * Throws are reserved for storage transport failures after retries
 * exhausted, AND for prerequisite breaches (caller must supply a
 * preloadedSite and target init must have completed). Expected
 * outcomes — NOT_FOUND / RENDER_FAILED / TEMPLATE_INVALID /
 * VALIDATION_FAILED — are typed `PublishItemResult` variants.
 */

import type { StorageProvider } from './types.js'
import type { Site } from './site-loader.js'
import type { ContentRoot } from './content-root.js'
import type { Issue } from './validation/types.js'

/**
 * Discriminator for the kind of item being published. Spine is the
 * same per kind; per-kind wrappers in `pages/publish.ts` and
 * `fragments/publish.ts` carry the kind through to dispatch +
 * sidecar + audit calls.
 */
export type PublishItemKind = 'page' | 'fragment'

/**
 * Render mode the item is being published with. Resolved by
 * per-kind wrappers from target.type + archive state:
 *   - `'page-rendered'` — ESI placeholders for `@fragment` refs;
 *     fragments composed at request time. Used for `esi` targets.
 *   - `'page-static'` — full-bake; fragments inlined into page HTML.
 *     Used for `static` targets and as the static fallback for
 *     `dynamic` targets.
 *   - `'fragment-rendered'` — fragment rendered standalone for ESI
 *     composition. Used for ALL fragment publishes regardless of
 *     target type.
 *   - `'archive-marker'` — body-skip; emit ONLY the HTML comment
 *     marker line so the worker reads first 200 bytes and
 *     short-circuits to 301/410 per design-soft-delete.md Q10.
 */
export type PublishRenderMode = 'page-rendered' | 'page-static' | 'fragment-rendered' | 'archive-marker'

/**
 * Successful publish outcome. `files` and `removed` mirror today's
 * publish-rendered return shape so consumers (CLI progress, admin
 * SSE) need no projection.
 */
export interface PublishItemOk {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: true
  readonly mode: PublishRenderMode
  readonly files: number
  readonly removed: number
}

/**
 * Item not found at the source — caller passed a name that
 * doesn't exist in the preloaded site. Routes/CLI project to a
 * 404 / non-zero exit; orchestrator continues to next item per
 * Q4 fail-soft.
 */
export interface PublishItemNotFound {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'NOT_FOUND'
  readonly reason: string
}

/**
 * Renderer threw OR returned malformed output (non-string html,
 * missing required field). Per design-rendering.md the renderer
 * is best-effort; one bad page doesn't abort the run.
 */
export interface PublishItemRenderFailed {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'RENDER_FAILED'
  readonly reason: string
}

/**
 * Template the item references is invalid (didn't pass scan).
 * Run-level template scan happens once at boot per Q5 step 3;
 * surface here for items that reference a scan-failed template.
 */
export interface PublishItemTemplateInvalid {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'TEMPLATE_INVALID'
  readonly reason: string
}

/**
 * Pre-publish validators (per validation Cut 4) emitted blocking
 * issues for this item. Caller (orchestrator) decides whether to
 * include validators in the per-item run; today admin's POST
 * /api/publish/audit gates separately.
 */
export interface PublishItemValidationFailed {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'VALIDATION_FAILED'
  readonly issues: readonly Issue[]
}

/**
 * Storage write retries exhausted (transport blip). Item-level
 * fail-soft per Q4; run continues with next item.
 */
export interface PublishItemStorageWriteFailed {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  readonly ok: false
  readonly code: 'STORAGE_WRITE_FAILED'
  readonly reason: string
}

/**
 * Typed union of expected per-item publish outcomes. Routes/CLI
 * `switch` exhaustively to project to wire shape (HTTP / SSE /
 * stdout). Adding a variant produces a TS error at every
 * consumer — intentional, per Q1 lock.
 */
export type PublishItemResult =
  | PublishItemOk
  | PublishItemNotFound
  | PublishItemRenderFailed
  | PublishItemTemplateInvalid
  | PublishItemValidationFailed
  | PublishItemStorageWriteFailed

/**
 * Inputs to `publishItemCore`. Carries the resolved render-mode
 * decision (per-kind wrappers compute it from target.type +
 * archive state) plus the renderer strategy that owns mode-specific
 * assembly.
 */
export interface PublishItemInput {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
  /** Render mode resolved by per-kind wrapper before calling core. */
  readonly mode: PublishRenderMode
  /** Loaded site, shared across the publish run (loaded ONCE in publishRun). */
  readonly site: Site
  /** Source content tree the item is read from. */
  readonly sourceRoot: ContentRoot
  /** Target storage being published TO. */
  readonly target: PublishTarget
}

/**
 * Per-target context. Mirrors the relevant subset of `TargetConfig`
 * + provider handle without importing the admin-api boundary type.
 * `publishRun` builds this once per target during boot phase 6
 * (init target storage); per-item core consumes it.
 */
export interface PublishTarget {
  readonly name: string
  readonly storage: StorageProvider
  /** Target type resolved per design-rendering.md (static / esi / dynamic). */
  readonly type: 'static' | 'esi' | 'dynamic'
  /**
   * Optional per-target manifest content hash for the item being
   * published. publishRun precomputes via hashManifest so per-item
   * core doesn't recompute.
   */
  readonly manifestHash?: string
  /** Optional SEO context for fallback-chain rendering. */
  readonly seo?: import('./seo.js').SeoContext
}

/**
 * Publish pipeline orchestrator (per-item) — Cut 1 shell.
 *
 * Cut 3 ports the 13-step spine. Until then this throws so any
 * accidental wiring surfaces immediately rather than silently
 * no-op'ing.
 */
export async function publishItemCore(_input: PublishItemInput): Promise<PublishItemResult> {
  throw new Error('publishItemCore: not implemented (Cut 1 shell; Cut 3 ports the spine)')
}
