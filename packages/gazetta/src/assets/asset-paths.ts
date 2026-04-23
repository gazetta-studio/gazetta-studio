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
import { assetBytesPath, manifestPath } from './manifest.js'
import { extFromMime } from './url.js'

/**
 * Every on-storage path associated with an asset — manifest, bytes,
 * variants. Complete enumeration: if this struct is returned, every
 * field points at a real candidate path. If any field would be
 * uncomputable (unknown MIME), the function throws instead.
 */
export interface AssetStoragePaths {
  /** The `{name}.asset.json` manifest. Always the last path to remove
   *  (if a crash leaves a manifest pointing at missing bytes, the
   *  resolver degrades gracefully; the reverse creates an orphan). */
  readonly manifest: string
  /** Primary bytes. */
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
 *
 * Variant paths come straight from the manifest's `variants` list —
 * each variant already knows its own on-disk filename (populated by
 * the ingest pipeline; see `assets/ingest.ts`). No recomputation here,
 * so a future variant-naming scheme change needs zero updates to this
 * module.
 */
export function assetStoragePaths(assetsRoot: string, manifest: AssetManifest): AssetStoragePaths {
  const ext = extFromMime(manifest.mime)
  if (!ext) {
    throw new AssetMimeUnsupportedError(manifest.mime, manifest.name)
  }
  return {
    manifest: `${assetsRoot}/${manifestPath(manifest.name)}`,
    bytes: `${assetsRoot}/${assetBytesPath(manifest.name, manifest.hash, ext)}`,
    variants: manifest.variants.map(v => `${assetsRoot}/${v.path}`),
  }
}

/**
 * Flatten the storage-paths set into a removal-safe order: bytes and
 * variants first, manifest last. This is the order delete should use —
 * a crash between steps leaves a manifest pointing at missing bytes
 * (which the resolver already handles) rather than an orphan byte file
 * no manifest references.
 */
export function assetPathsInRemovalOrder(paths: AssetStoragePaths): string[] {
  return [paths.bytes, ...paths.variants, paths.manifest]
}
