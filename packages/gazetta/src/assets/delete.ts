/**
 * Delete an asset — the blocked-by-refs flow.
 *
 * Contract:
 * 1. Read the manifest (404-equivalent if missing).
 * 2. Scan site content for references to this asset.
 * 3. If any refs exist, throw `AssetInUseError` with the usage list.
 *    The admin surface the list so the author can rewrite refs or pick
 *    a replacement.
 * 4. If no refs, delete the bytes then the manifest. Bytes first so a
 *    reader racing between the two can never see a manifest pointing at
 *    missing bytes (graceful degradation already handles "manifest gone"
 *    via the resolver's fall-through).
 *
 * Out of scope for this module:
 * - replace-and-delete (rewriting refs to a new asset before deleting) — a
 *   separate orchestration, landed in Step 8
 * - locale-specific byte overrides — not in the v1 slice manifest yet
 * - variants cleanup — variants aren't generated in the v1 slice
 *
 * Single responsibility: "given an asset, either delete it cleanly or
 * refuse with the reason." No HTTP concerns, no scan logic (delegated to
 * find-refs.ts), no byte-layout decisions (delegated to url.ts /
 * manifest.ts).
 */
import type { StorageProvider, SiteManifest } from '../types.js'
import { AssetInUseError, AssetStorageError } from './errors.js'
import { findAssetRefs } from './find-refs.js'
import { assetBytesPath, manifestPath, readManifest } from './manifest.js'
import { extFromMime } from './url.js'

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
 * `AssetManifestNotFoundError` / `AssetStorageError` otherwise.
 */
export async function deleteAsset(input: DeleteAssetInput): Promise<void> {
  // Step 1 — read manifest. Throws AssetManifestNotFoundError when missing,
  // which bubbles out to a clean 404 at the HTTP layer.
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

  // Step 4 — delete bytes first (if we know the path), then manifest.
  const ext = extFromMime(manifest.mime)
  if (ext) {
    const bytesRel = assetBytesPath(manifest.name, manifest.hash, ext)
    const bytesPath = `${input.assetsRoot}/${bytesRel}`
    try {
      await input.storage.rm(bytesPath)
    } catch (err) {
      // If bytes already vanished (e.g. manual cleanup), that's fine —
      // we still want the manifest gone. Anything else is a real failure.
      if (!isFileMissing(err)) throw new AssetStorageError('delete', bytesPath, err)
    }
  }

  const manifestRel = manifestPath(input.assetName)
  const manifestFullPath = `${input.assetsRoot}/${manifestRel}`
  try {
    await input.storage.rm(manifestFullPath)
  } catch (err) {
    throw new AssetStorageError('delete', manifestFullPath, err)
  }
}

function isFileMissing(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  return msg.includes('ENOENT') || msg.includes('not found') || msg.includes('NoSuchKey')
}
