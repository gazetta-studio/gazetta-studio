/**
 * Publish-plan — figures out *what* to publish before any bytes move.
 *
 * Single responsibility: turn a set of items being published into either
 * a `Plan` (the asset names to copy + the items that referenced them) or
 * a structured failure (`missing-on-source` / `target-incapable`). No
 * I/O on the destination beyond capability inspection — actually copying
 * bytes is `publish.ts`'s job.
 *
 * Splitting the planner from the executor lets the two failure modes
 * (missing source, incapable target) short-circuit before a single
 * stream is opened. It also lets the orchestrator wire publish-assets
 * into the broader publish flow with full knowledge of what's about to
 * happen — useful for ordering writes (assets before pages) and for
 * surfacing per-asset progress.
 */
import type { ContentRoot } from '../content-root.js'
import { isBinaryCapable } from '../types.js'
import { manifestPath } from './manifest.js'
import { collectAssetRefs } from './scan-manifest-for-asset.js'

export interface PlanInput {
  /** Source content root (where pages/, fragments/, and assets/ live on the source side). */
  readonly sourceRoot: ContentRoot
  /** Target content root (where pages/, fragments/, and assets/ will land on the target side). */
  readonly targetRoot: ContentRoot
  /** Items being published — e.g., `['pages/home', 'fragments/header']`. */
  readonly itemNames: readonly string[]
}

export type Plan =
  | { readonly ok: true; readonly assets: readonly string[]; readonly itemsWithRefs: readonly string[] }
  | { readonly ok: false; readonly reason: 'missing-on-source'; readonly missing: readonly string[] }
  | {
      readonly ok: false
      readonly reason: 'target-incapable'
      readonly assets: readonly string[]
      readonly affectedItems: readonly string[]
    }

/**
 * Compute the set of assets to publish given the items being published,
 * after running the two pre-flight checks (capability + source-existence).
 *
 * The order is intentional:
 *   1. Collect refs — cheap, all-source reads
 *   2. Capability gate — only matters if there are refs to copy
 *   3. Source-existence — only run after capability passes, since both
 *      provider sides need binary streaming for the executor to use the
 *      manifests we'd validate here
 *
 * Empty refs short-circuit to `ok: true` with no assets — sites without
 * media publish to text-only providers fine.
 */
export async function planAssetCopy(input: PlanInput): Promise<Plan> {
  const { refs, itemsWithRefs } = await collectRefsAcrossItems(input)

  if (refs.size === 0) return { ok: true, assets: [], itemsWithRefs: [] }

  if (!isBinaryCapable(input.sourceRoot.storage) || !isBinaryCapable(input.targetRoot.storage)) {
    return {
      ok: false,
      reason: 'target-incapable',
      assets: [...refs],
      affectedItems: itemsWithRefs,
    }
  }

  const missing: string[] = []
  for (const name of refs) {
    const exists = await input.sourceRoot.storage.exists(input.sourceRoot.path('assets', manifestPath(name)))
    if (!exists) missing.push(name)
  }
  if (missing.length > 0) {
    return { ok: false, reason: 'missing-on-source', missing }
  }

  return { ok: true, assets: [...refs], itemsWithRefs }
}

interface CollectedRefs {
  readonly refs: Set<string>
  readonly itemsWithRefs: string[]
}

async function collectRefsAcrossItems(input: PlanInput): Promise<CollectedRefs> {
  const refs = new Set<string>()
  const itemsWithRefs: string[] = []
  for (const item of input.itemNames) {
    const path = input.sourceRoot.path(item, manifestFilenameFor(item))
    const raw = await input.sourceRoot.storage.readFile(path).catch(() => null)
    if (raw === null) continue
    // Page/fragment manifests have the same `Walkable` shape that
    // `collectAssetRefs` accepts; cast here rather than parse-and-validate
    // since the planner's job is ref discovery, not manifest validation.
    const manifest = JSON.parse(raw) as Parameters<typeof collectAssetRefs>[0]
    const itemRefs = collectAssetRefs(manifest)
    if (itemRefs.size === 0) continue
    itemsWithRefs.push(item)
    for (const name of itemRefs) refs.add(name)
  }
  return { refs, itemsWithRefs }
}

function manifestFilenameFor(itemName: string): string {
  return itemName.startsWith('fragments/') ? 'fragment.json' : 'page.json'
}
