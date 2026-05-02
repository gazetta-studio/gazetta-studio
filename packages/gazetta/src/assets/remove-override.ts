/**
 * Remove a single locale/theme override from an asset.
 *
 * Author-facing semantics (design-media.md → "Remove French bytes
 * override"):
 *   "Always allowed; locale bytes overrides don't own refs independently.
 *    Effect: deletes locale bytes + variants + manifest. The locale
 *    falls back to default bytes — no broken refs, no code changes in
 *    referring pages."
 *
 * Single responsibility: delete the override slice cleanly. Owns:
 *   - resolve the override slice from `enumerateAssetStoragePaths`
 *   - rm the slice's manifest + bytes + variants in safe order
 *   - record one history revision
 *
 * Does NOT own: HTTP, default-asset operations, ref scanning (overrides
 * carry no refs of their own).
 */
import type { ContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import { selectorsEqual, selectorSuffix, type Selector } from '../schema/dimensions.js'
import type { StorageProvider } from '../types.js'
import { createContentRoot } from '../content-root.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { enumerateAssetStoragePaths } from './asset-paths.js'
import { AssetManifestNotFoundError, AssetStorageError } from './errors.js'
import { readManifest } from './manifest.js'

export interface RemoveOverrideInput {
  storage: StorageProvider
  assetsRoot: string
  /** Path prefix for site content (used for content-root construction). */
  siteDir: string
  assetName: string
  /** Selector identifying which override to remove. Must be non-null. */
  selector: Selector
  history?: HistoryProvider
  author?: string
  contentRoot?: ContentRoot
}

/**
 * Remove the override slice identified by `selector`. Throws:
 *   - `AssetManifestNotFoundError` — the asset doesn't exist OR the
 *     specific override doesn't exist on this asset
 *   - `AssetStorageError` — underlying rm failed
 */
export async function removeOverride(input: RemoveOverrideInput): Promise<void> {
  const defaultManifest = await readManifest(input.storage, input.assetsRoot, input.assetName)

  const paths = await enumerateAssetStoragePaths(input.storage, input.assetsRoot, defaultManifest)
  const slice = paths.overrides.find(s => selectorsEqual(s.selector, input.selector))
  if (!slice) {
    // Reuse the existing 404 — the override is, from the API's view,
    // a separate addressable resource that doesn't exist.
    throw new AssetManifestNotFoundError(`${input.assetName}${selectorSuffix(input.selector)}`)
  }

  // Removal-safe order for ONE slice: bytes + variants first, manifest
  // last. If interrupted mid-rm, an orphan manifest pointing at missing
  // bytes is the resolver-degrades-gracefully case; the reverse leaves
  // bytes the resolver can never reach (future GC reclaims).
  const orderedPaths: string[] = []
  if (slice.bytes !== null) orderedPaths.push(slice.bytes)
  orderedPaths.push(...slice.variants)
  orderedPaths.push(slice.manifest)

  const contentRoot = input.contentRoot ?? createContentRoot(input.storage, input.siteDir)

  if (input.history) {
    const items: WrittenItem[] = orderedPaths.map(path => ({ path, content: null }))
    await recordWrite({
      history: input.history,
      contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Remove ${input.assetName} override (${selectorSuffix(input.selector).slice(1)})`,
    })
  }

  for (const path of orderedPaths) {
    try {
      await rmIgnoreMissing(input.storage, path)
    } catch (err) {
      throw new AssetStorageError('delete', path, err)
    }
  }
}
