/**
 * Page Publish — kind-specific wrapper around `publishItemCore`.
 *
 * Owns the bits unique to Page publishes:
 *   - Render-mode resolution from target.type + archive state:
 *     - archived → 'archive-marker' regardless of target type
 *     - target.type === 'esi' → 'page-rendered' (ESI placeholders)
 *     - target.type === 'static' → 'page-static' (full-bake)
 *     - target.type === 'dynamic' → 'page-static' (static fallback;
 *       dynamic origin handles per-request render)
 *   - Page-cache config flow-through (target → page → spine renderer
 *     reads it for the cache-control comment)
 *
 * Everything downstream — archive precheck, render dispatch, storage
 * I/O, sidecar writes, cleanup — is `publishItemCore`'s spine.
 *
 * Per Q3 lock: two fns + shared core. The 5 page-vs-fragment diffs
 * (mode resolution, page-cache, sidecar pub-state, etc.) live here in
 * one file the reader can scan top-to-bottom.
 */

import { isArchived } from '../archive-helpers.js'
import { publishItemCore, type PublishItemResult, type PublishRenderMode, type PublishTarget } from '../publish-item.js'
import type { ContentRoot } from '../content-root.js'
import type { Site } from '../site-loader.js'

/**
 * Inputs to `publishPage`. Routes / CLI / orchestrator destructure
 * their context and pass the parts the pipeline needs.
 */
export interface PublishPageInput {
  /** Page name (folder name under `pages/`). */
  readonly name: string
  /** Locale variant being published; undefined = default locale. */
  readonly locale?: string
  /** Loaded site (caller does `loadSite()` once for the publish run). */
  readonly site: Site
  /** Source content root (typically not used by core today; reserved for hooks). */
  readonly sourceRoot: ContentRoot
  /** Target context (storage, type, optional manifestHash, seo, cache). */
  readonly target: PublishTarget
}

/**
 * Resolve the render mode for a page on a target. Pure dispatch
 * function — exported for tests + per-kind reuse.
 */
export function resolvePageRenderMode(
  page: { archived?: boolean },
  targetType: PublishTarget['type'],
): PublishRenderMode {
  // Archive precheck wins regardless of target type. The spine's
  // archive-marker renderer body-skips and emits the marker line so
  // the worker reads first 200 bytes and short-circuits to 301/410
  // per design-soft-delete.md Q10.
  if (isArchived(page)) return 'archive-marker'
  // ESI mode: pages compose ESI placeholders for `@fragment` refs
  // at request time on a worker-served target.
  if (targetType === 'esi') return 'page-rendered'
  // Static + dynamic targets bake the full page. Dynamic targets'
  // origin handles per-request rendering for dynamic FRAGMENTS only;
  // pages themselves still get a static fallback (per
  // design-rendering.md compatibility matrix).
  return 'page-static'
}

/**
 * Publish a page to a target. Wraps `publishItemCore` with the
 * page-specific mode resolution. Returns one of `PublishItemResult`'s
 * typed variants — caller projects to wire shape (HTTP / SSE / CLI
 * stdout / aggregate result).
 *
 * Caller responsibilities (handled by per-run orchestrator in Cut 5):
 *   - Capability check (`requireCapability('publish:...')`)
 *   - Template scan + loadSite (shared across run)
 *   - Per-target init + capability gates
 */
export async function publishPage(input: PublishPageInput): Promise<PublishItemResult> {
  const page = input.site.pages.get(input.name)
  if (!page) {
    return {
      kind: 'page',
      name: input.name,
      locale: input.locale,
      ok: false,
      code: 'NOT_FOUND',
      reason: `Page "${input.name}" not found in source`,
    }
  }
  const mode = resolvePageRenderMode(page, input.target.type)
  return publishItemCore({
    kind: 'page',
    name: input.name,
    locale: input.locale,
    mode,
    site: input.site,
    sourceRoot: input.sourceRoot,
    target: input.target,
  })
}
