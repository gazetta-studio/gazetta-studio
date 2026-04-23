/**
 * Delete an asset — the blocked-by-refs flow.
 *
 * Contract:
 * 1. Read the manifest (404-equivalent if missing).
 * 2. Scan site content for references to this asset.
 * 3. If any refs exist, throw `AssetInUseError` with the usage list.
 *    The admin surfaces the list so the author can rewrite refs or pick
 *    a replacement.
 * 4. If no refs, remove every enumerated byte path (bytes + variants),
 *    then the manifest. Bytes first so the last thing removed is the
 *    manifest — if a crash interrupts us, the manifest points at missing
 *    bytes, which the resolver already degrades gracefully (placeholder).
 *
 * Single responsibility: policy — "either delete cleanly or refuse with a
 * reason." This module owns:
 *   - read-manifest
 *   - scan-for-refs
 *   - refuse-or-remove
 * It does NOT own:
 *   - HTTP concerns (the route adapter does)
 *   - scan logic (`find-refs.ts` does)
 *   - which paths exist for an asset (`asset-paths.ts` does)
 *   - MIME/extension mapping (`url.ts` does, via `asset-paths.ts`)
 *   - "rm if exists" idempotency (`providers/_rm-ignore-missing.ts` does)
 *
 * Adding a new manifest dimension (variants, locale bytes, posters) means
 * extending `asset-paths.ts`. This module stays unchanged — the path set
 * grows, the enumeration loop here picks it up automatically.
 */
import type { StorageProvider, SiteManifest } from '../types.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { allAssetPaths, assetStoragePaths } from './asset-paths.js'
import { AssetInUseError, AssetStorageError } from './errors.js'
import { findAssetRefs } from './find-refs.js'
import { manifestPath, readManifest } from './manifest.js'

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
 * Delete an asset after verifying no references exist. Returns on success;
 * throws `AssetInUseError` (with the usage list attached) or
 * `AssetManifestNotFoundError` / `AssetStorageError` /
 * `AssetMimeUnsupportedError` otherwise.
 */
export async function deleteAsset(input: DeleteAssetInput): Promise<void> {
  // Step 1 — read manifest. Throws AssetManifestNotFoundError when missing.
  const manifest = await readManifest(input.storage, input.assetsRoot, input.assetName)

  // Step 2 — scan for refs.
  const refs = await findAssetRefs({
    storage: input.storage,
    siteDir: input.siteDir,
    assetName: input.assetName,
    manifest: input.manifest,
  })

  // Step 3 — refuse if in use.
  if (refs.length > 0) {
    throw new AssetInUseError(input.assetName, refs)
  }

  // Step 4 — remove every byte path, then the manifest. `assetStoragePaths`
  // throws `AssetMimeUnsupportedError` when the manifest's MIME has no
  // extension mapping — that's a misconfiguration caller surfaces as-is.
  const paths = assetStoragePaths(input.assetsRoot, manifest)
  for (const path of allAssetPaths(paths)) {
    // Tolerate "already gone" for byte paths: a prior partial delete or
    // manual cleanup is a realistic state that shouldn't block the
    // manifest removal. The storage-layer idempotency lives in
    // `rmIgnoreMissing` — here we just use it.
    try {
      await rmIgnoreMissing(input.storage, path)
    } catch (err) {
      throw new AssetStorageError('delete', path, err)
    }
  }

  // The manifest itself. Unlike bytes, an already-missing manifest here
  // would be surprising (we just read it successfully a moment ago) —
  // so we don't tolerate missing here. Race-with-concurrent-deletion
  // isn't a scenario we protect against in v1.
  const manifestFullPath = `${input.assetsRoot}/${manifestPath(input.assetName)}`
  try {
    await input.storage.rm(manifestFullPath)
  } catch (err) {
    throw new AssetStorageError('delete', manifestFullPath, err)
  }
}
