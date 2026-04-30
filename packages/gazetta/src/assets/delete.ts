/**
 * Delete an asset — the blocked-by-refs flow.
 *
 * Contract:
 * 1. Read the manifest (404-equivalent if missing).
 * 2. Scan site content for references to this asset.
 * 3. If any refs exist, throw `AssetInUseError` with the usage list.
 *    The admin surfaces the list so the author can rewrite refs or pick
 *    a replacement.
 * 4. If no refs, remove every storage path associated with the asset in
 *    removal-safe order (bytes + variants first, manifest last). If a
 *    crash lands between any two steps, at worst the manifest points at
 *    missing bytes — a state the resolver already degrades gracefully.
 *
 * Single responsibility: policy — "either delete cleanly or refuse with a
 * reason." Owns the three-step flow and nothing else:
 *   - reads manifest (via `manifest.ts`)
 *   - scans refs (via `find-refs.ts`)
 *   - enumerates paths (via `asset-paths.ts`) and removes them
 *     idempotently (via `providers/_rm-ignore-missing.ts`)
 *
 * Adding a new manifest dimension (variants, locale bytes, posters)
 * means extending `asset-paths.ts`. This module stays unchanged — the
 * enumeration loop picks up the new paths automatically.
 */
import type { StorageProvider, SiteManifest } from '../types.js'
import { createContentRoot } from '../content-root.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { assetPathsInRemovalOrder, assetStoragePaths } from './asset-paths.js'
import { AssetInUseError, AssetStorageError } from './errors.js'
import { findAssetRefs } from './find-refs.js'
import { readManifest } from './manifest.js'
import { itemRefToAssetRef, readRefsForAsset } from './asset-deps.js'

export interface DeleteAssetInput {
  /** Storage holding both the asset and the content tree. */
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
  /**
   * Path prefix for site content (where `pages/` and `fragments/` live).
   * Required — refs are scanned from here.
   */
  siteDir: string
  /** The asset name to delete. */
  assetName: string
  /** Project-level manifest passed to the ref-scanner's `loadSite`. */
  manifest?: SiteManifest
}

/**
 * Delete an asset after verifying no references exist. Returns on
 * success; throws `AssetInUseError` (with the usage list),
 * `AssetManifestNotFoundError`, `AssetMimeUnsupportedError`, or
 * `AssetStorageError` otherwise.
 */
export async function deleteAsset(input: DeleteAssetInput): Promise<void> {
  // Step 1 — read manifest. Throws AssetManifestNotFoundError when missing.
  const manifest = await readManifest(input.storage, input.assetsRoot, input.assetName)

  // Step 2 — scan for refs.
  //
  // Fast path: read the per-edge asset-refs sidecars. O(1) directory
  // listing under the asset's `.gazetta/asset-refs/{name}/` dir.
  // Sidecars are populated by save handlers + publish + reindex CLI.
  //
  // Fallback: if the sidecar dir is empty AND we suspect drift (e.g.,
  // freshly-cloned source where backfill hasn't run), fall through to
  // the manifest walk for safety. The walk catches refs that the
  // sidecar index would have missed for any reason — high-stakes
  // operation (delete loses data), worth the extra ~30s on cloud at
  // N=1000.
  const contentRoot = createContentRoot(input.storage, input.siteDir)
  const sidecarRefs = await readRefsForAsset(contentRoot, input.assetName)
  let refs
  if (sidecarRefs.length > 0) {
    refs = sidecarRefs.map(itemRefToAssetRef)
  } else {
    // Sidecar dir empty or missing — could mean truly zero refs OR
    // index drift / not-yet-backfilled. Walk to confirm; safe-on-doubt.
    refs = await findAssetRefs({
      storage: input.storage,
      siteDir: input.siteDir,
      assetName: input.assetName,
      manifest: input.manifest,
    })
  }

  // Step 3 — refuse if in use.
  if (refs.length > 0) {
    throw new AssetInUseError(input.assetName, refs)
  }

  // Step 4 — remove every enumerated path in removal-safe order.
  // `assetStoragePaths` throws `AssetMimeUnsupportedError` when the
  // manifest's MIME has no extension mapping (misconfiguration — surface
  // as-is rather than silently skipping bytes).
  const paths = assetStoragePaths(input.assetsRoot, manifest)
  for (const path of assetPathsInRemovalOrder(paths)) {
    try {
      await rmIgnoreMissing(input.storage, path)
    } catch (err) {
      throw new AssetStorageError('delete', path, err)
    }
  }
}
