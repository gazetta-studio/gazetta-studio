/**
 * Asset path enumeration — "given a manifest, what on-storage paths make
 * up this asset?"
 *
 * Single responsibility: translate a manifest + its assetsRoot into the
 * concrete storage paths that physically exist for this asset (bytes,
 * variants, future locale-bytes overrides). Callers that want to move,
 * copy, or remove an asset ask this module for the path set and then
 * act on it — they don't compute paths themselves.
 *
 * Why a separate module:
 * - Delete, rename, replace, and GC all need "which files exist for
 *   asset X?" Expressing that in each operation would fork — a new
 *   manifest field (variants, locale bytes, posters) would require a
 *   fix in every operation. Here it's one edit.
 * - Keeps `delete.ts` free of MIME switches and path arithmetic. That
 *   module's single concern is the refs-then-remove policy; it delegates
 *   "what do I remove?" to this one.
 *
 * v1 scope: returns only the default-bytes path when the MIME is in the
 * known-extension set. Variants, locale bytes, and posters land here as
 * those capabilities are added to the manifest.
 */
import type { AssetManifest } from '../schema/types.js'
import { assetBytesPath } from './manifest.js'
import { extFromMime } from './url.js'

/**
 * Every on-storage path associated with an asset. `bytes` is the default
 * file that serves the asset's canonical URL. `variants` is reserved for
 * responsive-image derivatives; empty in v1. Future fields (localeBytes,
 * posters, etc.) append to the shape without breaking callers — enumeration
 * is additive.
 */
export interface AssetStoragePaths {
  /** Primary bytes. `null` when the MIME has no known extension mapping
   *  and the bytes path can't be reconstructed — tolerated gracefully by
   *  callers rather than propagated as an error. */
  readonly bytes: string | null
  /** Responsive-image variants. Empty until variant generation lands. */
  readonly variants: readonly string[]
}

/**
 * Enumerate every storage path associated with the asset described by
 * `manifest`, rooted under `assetsRoot`. Paths are relative to the storage
 * provider's root — callers prepend their own site prefix if needed.
 */
export function assetStoragePaths(assetsRoot: string, manifest: AssetManifest): AssetStoragePaths {
  const ext = extFromMime(manifest.mime)
  const bytes = ext ? `${assetsRoot}/${assetBytesPath(manifest.name, manifest.hash, ext)}` : null
  return { bytes, variants: [] }
}

/**
 * Flatten the storage-paths set into the list of every removable path.
 * Used by delete / GC callers that just want to iterate "files to unlink"
 * without pattern-matching on the shape. Null bytes are filtered out —
 * the caller can't remove what we couldn't locate.
 */
export function allAssetPaths(paths: AssetStoragePaths): string[] {
  const out: string[] = []
  if (paths.bytes) out.push(paths.bytes)
  out.push(...paths.variants)
  return out
}
