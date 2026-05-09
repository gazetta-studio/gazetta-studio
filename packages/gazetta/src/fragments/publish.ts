/**
 * Fragment Publish — kind-specific wrapper around `publishItemCore`.
 *
 * Peer of `pages/publish.ts`. Differs from Page Publish in two places:
 *
 *   1. Mode resolution simpler: fragments have ONE rendering mode
 *      (`fragment-rendered`) regardless of target type. Archive
 *      short-circuit applies; otherwise always rendered.
 *   2. No page-cache flow-through (fragments don't carry pub-state
 *      sidecars; spine handles).
 *
 * Everything downstream is the spine.
 */

import { isArchived } from '../archive-helpers.js'
import { publishItemCore, type PublishItemResult, type PublishRenderMode, type PublishTarget } from '../publish-item.js'
import type { ContentRoot } from '../content-root.js'
import type { Site } from '../site-loader.js'

/** Inputs to `publishFragment`. Same shape as `PublishPageInput`. */
export interface PublishFragmentInput {
  readonly name: string
  readonly locale?: string
  readonly site: Site
  readonly sourceRoot: ContentRoot
  readonly target: PublishTarget
}

/**
 * Resolve the render mode for a fragment on a target. Pure dispatch
 * fn. Always either 'archive-marker' or 'fragment-rendered'.
 */
export function resolveFragmentRenderMode(fragment: { archived?: boolean }): PublishRenderMode {
  if (isArchived(fragment)) return 'archive-marker'
  return 'fragment-rendered'
}

/**
 * Publish a fragment to a target. Wraps `publishItemCore` with the
 * fragment-specific mode resolution.
 */
export async function publishFragment(input: PublishFragmentInput): Promise<PublishItemResult> {
  const fragment = input.site.fragments.get(input.name)
  if (!fragment) {
    return {
      kind: 'fragment',
      name: input.name,
      locale: input.locale,
      ok: false,
      code: 'NOT_FOUND',
      reason: `Fragment "${input.name}" not found in source`,
    }
  }
  const mode = resolveFragmentRenderMode(fragment)
  return publishItemCore({
    kind: 'fragment',
    name: input.name,
    locale: input.locale,
    mode,
    site: input.site,
    sourceRoot: input.sourceRoot,
    target: input.target,
  })
}
