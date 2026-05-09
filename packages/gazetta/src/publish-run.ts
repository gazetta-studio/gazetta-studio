/**
 * Publish pipeline (per-run) — orchestrator for one publish operation
 * (N items × M targets × locale variants).
 *
 * Today admin's POST `/api/publish` and CLI's `runPublish` each inline
 * the same fan-out: validate → scan templates → loadSite → expand
 * dependencies → init targets → loop (target × item) → write dep
 * indices → write site manifest → cache purge → record history →
 * audit. Two callers, ~1500 lines of duplicated orchestration.
 *
 * `publishRun` is the seam both callers route through. Per-item core
 * (`publishItemCore` in publish-item.ts) handles single-item rendering;
 * this orchestrator owns cross-item concerns: dependency expansion via
 * `findDependentsFromSidecars`, shared template-scan, shared loadSite,
 * per-target init, fan-out fail-soft, progress emission, aggregate
 * result.
 *
 * Pipeline order is locked semantics, not configuration. Per-run:
 *
 *   1. validate input (items + targets non-empty, names known)
 *   2. capability gate per target (publish:non-production /
 *      publish:production via Principal)
 *   3. boot: scan + hash templates ONCE
 *   4. boot: loadSite ONCE per source
 *   5. expand items via findDependentsFromSidecars (transitive —
 *      publishing @header pulls dependent pages)
 *   6. boot: init target storage (registry connect, per-target type
 *      resolution per design-rendering.md)
 *   7. (RESERVED) per-target review-publish-approval gate — Review
 *      Cut 9: targets w/ requiresPublishApproval create request,
 *      don't deploy
 *   8. (RESERVED) dispatchBeforePublishRun hooks
 *   9. for each target: { for each item: per-item pipeline }
 *  10. for each target: publishDepIndices (asset-refs, fragment-deps,
 *      archive-aliases sidecars)
 *  11. for each target: publishSiteManifest (site.json snapshot)
 *  12. for each target: cache-purge dispatch (cloudflare/configured
 *      strategy, fire-and-forget)
 *  13. record history revision per target
 *  14. (RESERVED) dispatchAfterPublishRun hooks
 *  15. audit success per (item, target, outcome)
 *  16. (RESERVED) cascades — Soft-Delete Q6 auto-cancel scheduled
 *      actions on publish-of-archived
 *  17. aggregate PublishRunResult, return
 *
 * Boot fail-fast (steps 1-6), per-item/per-target fail-soft (Q4 lock).
 */

import type { Principal } from './auth/types.js'
import type { ContentRoot } from './content-root.js'
import type { HistoryProvider } from './history.js'
import type { StorageProvider, SiteManifest, PurgeStrategy } from './types.js'
import type { PublishItemResult, PublishItemKind, PublishRenderMode } from './publish-item.js'

/**
 * Reference to one item being published. Locale undefined =
 * default locale variant only; locale set = explicit variant
 * (caller can split a single page name into multiple ItemRefs
 * for per-locale fan-out).
 */
export interface PublishItemRef {
  readonly kind: PublishItemKind
  readonly name: string
  readonly locale?: string
}

/**
 * Per-target outcome. Fan-out fail-soft (Q4): one target's failure
 * doesn't block others. `failed: true` when target init failed OR
 * when ALL items for this target failed; otherwise `false` even
 * when some items failed (per-item failures live in items[]).
 */
export interface PublishTargetResult {
  readonly name: string
  readonly failed: boolean
  readonly failureReason?: string
  /** Files written across this target (sum of item.files). */
  readonly filesWritten: number
  /** Files removed across this target (sum of item.removed). */
  readonly filesRemoved: number
}

/**
 * Aggregate result of one publish run. `ok` derived: every item
 * succeeded AND every target succeeded. Caller (CLI exit code,
 * admin response status) reads this directly.
 */
export interface PublishRunResult {
  readonly ok: boolean
  readonly items: readonly PublishItemResult[]
  readonly targets: readonly PublishTargetResult[]
}

/**
 * Streaming progress event. Emitted via `onProgress` callback in
 * input. Admin route forwards to SSE; CLI writes to stdout.
 */
export type PublishProgressEvent =
  | { readonly kind: 'run-start'; readonly totalItems: number; readonly totalTargets: number }
  | { readonly kind: 'target-start'; readonly target: string }
  | {
      readonly kind: 'item-start'
      readonly item: PublishItemRef
      readonly target: string
      readonly mode: PublishRenderMode
    }
  | { readonly kind: 'item-done'; readonly result: PublishItemResult; readonly target: string }
  | { readonly kind: 'target-done'; readonly result: PublishTargetResult }
  | { readonly kind: 'run-done'; readonly result: PublishRunResult }

/**
 * Inputs to `publishRun`. Caller assembles items + targets + source
 * wiring; orchestrator does the rest.
 */
export interface PublishRunInput {
  /**
   * Items to publish. Orchestrator expands transitively via
   * `findDependentsFromSidecars` (publishing `@header` pulls every
   * page that references it).
   */
  readonly items: readonly PublishItemRef[]
  /** Target names to publish to. Resolved against the target registry. */
  readonly targets: readonly string[]
  /** Source content tree — caller's already loaded. */
  readonly sourceRoot: ContentRoot
  /** Project-level site manifest, passed through to loadSite. */
  readonly siteManifest: SiteManifest
  /** Templates dir; passed through to template scan + loadSite. */
  readonly templatesDir?: string
  /** Per-target storage providers (registry-resolved). */
  readonly targetStorages: ReadonlyMap<string, StorageProvider>
  /** Authenticated principal driving this publish (capability gates + audit). */
  readonly principal?: Principal
  /** History provider per source (for revision recording). */
  readonly history?: HistoryProvider
  /** Cache purge strategy (cloudflare etc., fire-and-forget per Q5 step 12). */
  readonly purgeStrategy?: PurgeStrategy
  /**
   * `--force`: skip incremental publish optimization (publish all
   * items even when content-hash sidecar matches). Mirrors today's
   * CLI flag.
   */
  readonly force?: boolean
  /**
   * Streaming callback. Emitted at boundaries listed in
   * `PublishProgressEvent`. Admin route → SSE; CLI → stdout.
   */
  readonly onProgress?: (event: PublishProgressEvent) => void
}

/**
 * Publish pipeline orchestrator (per-run) — Cut 1 shell.
 *
 * Cut 5 ports the 17-step spine. Until then this throws so any
 * accidental wiring surfaces immediately rather than silently
 * no-op'ing.
 */
export async function publishRun(_input: PublishRunInput): Promise<PublishRunResult> {
  throw new Error('publishRun: not implemented (Cut 1 shell; Cut 5 ports the spine)')
}
