/**
 * Asset path enumeration — "given a manifest, what on-storage paths make
 * up this asset?"
 *
 * Single responsibility: translate a manifest + its assetsRoot into the
 * concrete storage paths that physically exist for this asset (bytes,
 * variants, future locale-bytes overrides). Callers that want to move,
 * copy, or remove an asset ask this module for the path set and act on
 * it — they don't compute paths themselves.
 *
 * Completeness contract:
 *   Either return a fully-populated path set, or throw
 *   `AssetMimeUnsupportedError`. No null-bytes escape hatch — the original
 *   design tolerated it with a "filter on the way out" pattern, which
 *   meant a new asset kind added without extending `extFromMime` silently
 *   skipped byte deletion in every consumer. Forcing the error here keeps
 *   the MIME map honest: add a kind, extend the map, or fail loud.
 *
 * v1 scope: default-bytes path only. Variants, locale bytes, and posters
 * land here as those capabilities are added to the manifest. Each
 * addition is an append to `AssetStoragePaths` — enumeration stays
 * additive; delete, rename, GC inherit the new paths automatically.
 */
import type { AssetManifest } from '../schema/types.js'
import { AssetMimeUnsupportedError } from './errors.js'
import { assetBytesPath } from './manifest.js'
import { extFromMime } from './url.js'

/**
 * Every on-storage path associated with an asset. Each field is either a
 * non-empty list or a single non-null path. Callers can iterate
 * confidently; the enumeration is complete or the function threw.
 */
export interface AssetStoragePaths {
  /** Primary bytes. Always present when this struct is returned. */
  readonly bytes: string
  /** Responsive-image variants. Empty until variant generation lands. */
  readonly variants: readonly string[]
}

/**
 * Enumerate every storage path associated with the asset described by
 * `manifest`, rooted under `assetsRoot`. Throws
 * `AssetMimeUnsupportedError` when the manifest's MIME has no extension
 * mapping — that's a misconfiguration, not a runtime condition to
 * tolerate.
 */
export function assetStoragePaths(assetsRoot: string, manifest: AssetManifest): AssetStoragePaths {
  const ext = extFromMime(manifest.mime)
  if (!ext) {
    throw new AssetMimeUnsupportedError(manifest.mime, manifest.name)
  }
  const bytes = `${assetsRoot}/${assetBytesPath(manifest.name, manifest.hash, ext)}`
  return { bytes, variants: [] }
}

/**
 * Flatten the storage-paths set into the list of every removable path.
 * Used by delete / GC callers that want to iterate "files to unlink"
 * without pattern-matching on the shape. The primary bytes path always
 * comes first; variants follow in their stored order.
 */
export function allAssetPaths(paths: AssetStoragePaths): string[] {
  return [paths.bytes, ...paths.variants]
}
