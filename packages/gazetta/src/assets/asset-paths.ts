/**
 * Asset path enumeration — "given a manifest, what on-storage paths make
 * up this asset?"
 *
 * Single responsibility: translate a manifest + its assetsRoot into the
 * concrete storage paths that physically exist for this asset (default
 * bytes, default variants, plus per-locale and per-theme overrides).
 * Callers that want to move, copy, or remove an asset ask this module
 * for the path set and act on it — they don't compute paths themselves.
 *
 * Completeness contract:
 *   Either return a fully-populated path set, or throw
 *   `AssetMimeUnsupportedError`. No null-bytes escape hatch — the original
 *   design tolerated it with a "filter on the way out" pattern, which
 *   meant a new asset kind added without extending `extFromMime` silently
 *   skipped byte deletion in every consumer. Forcing the error here keeps
 *   the MIME map honest: add a kind, extend the map, or fail loud.
 *
 * Override slices:
 *   Each `OverrideSlice` represents one (locale, theme, ...) variant of
 *   the asset. The selector is part of the slice — slices are
 *   self-describing so iteration over `overrides` doesn't need to
 *   recompute selectors from filenames. Slices with `bytes: null` are
 *   metadata-only locale overrides (no byte file, just a manifest).
 *
 * v1 scope reads `overrides` as an empty array because no callers write
 * locale variants yet. Step 24 (locale-bytes ingest) will populate it.
 * Delete, rename, GC iterate `overrides` from day one — adding the data
 * later doesn't require touching consumers.
 */
import type { AssetManifest } from '../schema/types.js'
import type { Selector } from '../schema/dimensions.js'
import { AssetMimeUnsupportedError } from './errors.js'
import { assetBytesPath, manifestPath } from './manifest.js'
import { extFromMime } from './url.js'

/**
 * One override variant of an asset (a specific (locale, theme, ...)
 * combination). Self-describing — carries its selector so iteration
 * doesn't need to re-derive it from filename parsing.
 */
export interface OverrideSlice {
  /** Selector identifying this override (locale and/or theme). Never null. */
  readonly selector: Selector
  /** Locale-variant manifest path: `{name}.asset.{...selectors}.json`. */
  readonly manifest: string
  /**
   * Locale-bytes path. Null when this override is metadata-only
   * (no `hash` on the locale manifest); non-null when this locale has
   * its own bytes.
   */
  readonly bytes: string | null
  /**
   * Variant ladder for THIS locale's bytes. Empty when `bytes` is null
   * (no bytes → no variants) or when this locale's bytes are too small
   * to need a ladder.
   */
  readonly variants: readonly string[]
}

/**
 * Every on-storage path associated with an asset — default manifest,
 * default bytes, default variants, plus zero or more locale/theme
 * overrides. If this struct is returned, every field points at a real
 * candidate path; if any field would be uncomputable (unknown MIME),
 * the function throws instead.
 */
export interface AssetStoragePaths {
  /** The `{name}.asset.json` default manifest. Always the last path to
   *  remove (if a crash leaves a manifest pointing at missing bytes, the
   *  resolver degrades gracefully; the reverse creates an orphan). */
  readonly defaultManifest: string
  /** Primary default bytes. */
  readonly defaultBytes: string
  /** Default-variant ladder. Empty until variant generation runs. */
  readonly defaultVariants: readonly string[]
  /**
   * Per-(locale, theme) overrides. Sorted by selector for deterministic
   * iteration. Empty when this asset has no overrides — the typical
   * case for assets that aren't localized or themed.
   */
  readonly overrides: readonly OverrideSlice[]
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
 *
 * `overrides` is empty in v1's pre-locale-bytes state. When step 24
 * lands locale-bytes ingest, this function will accept (or be paired
 * with a sibling function that accepts) the locale variants and
 * populate `overrides`. Today's callers iterate the empty array as a
 * no-op; tomorrow's callers iterate populated overrides without code
 * change.
 */
export function assetStoragePaths(assetsRoot: string, manifest: AssetManifest): AssetStoragePaths {
  const ext = extFromMime(manifest.mime)
  if (!ext) {
    throw new AssetMimeUnsupportedError(manifest.mime, manifest.name)
  }
  return {
    defaultManifest: `${assetsRoot}/${manifestPath(manifest.name)}`,
    defaultBytes: `${assetsRoot}/${assetBytesPath(manifest.name, manifest.hash, ext)}`,
    defaultVariants: manifest.variants.map(v => `${assetsRoot}/${v.path}`),
    overrides: [],
  }
}

/**
 * Flatten the storage-paths set into a removal-safe order. Three rules:
 *
 *   1. Override bytes + variants first (each override is independently
 *      removable; orphan default-manifest is fine if an override removal
 *      is interrupted, since the resolver degrades gracefully).
 *   2. Override manifests after their bytes/variants (same atomicity
 *      rationale per-override).
 *   3. Default bytes + variants, then default manifest LAST. The default
 *      manifest is the canonical "this asset exists" record — losing it
 *      mid-removal leaves orphan bytes the resolver can't reach, which
 *      the future GC will reclaim.
 */
export function assetPathsInRemovalOrder(paths: AssetStoragePaths): string[] {
  const order: string[] = []
  // Override bytes + variants, override manifests
  for (const slice of paths.overrides) {
    if (slice.bytes !== null) order.push(slice.bytes)
    order.push(...slice.variants)
  }
  for (const slice of paths.overrides) {
    order.push(slice.manifest)
  }
  // Default bytes + variants, then default manifest last
  order.push(paths.defaultBytes, ...paths.defaultVariants, paths.defaultManifest)
  return order
}

/**
 * Flat list of every byte path (default + per-override) across the asset.
 * Use case: future GC walks this set across all assets to identify
 * unreferenced byte files. No manifest paths included — those are the
 * "what bytes should exist" record, not bytes themselves.
 */
export function assetBytePaths(paths: AssetStoragePaths): string[] {
  const out: string[] = [paths.defaultBytes, ...paths.defaultVariants]
  for (const slice of paths.overrides) {
    if (slice.bytes !== null) out.push(slice.bytes)
    out.push(...slice.variants)
  }
  return out
}

/**
 * Flat list of every manifest path (default + per-override). Use case:
 * history captures every manifest file in a revision; restore writes
 * them back. Manifests are the canonical "this asset exists" records,
 * separately enumerable from the bytes they describe.
 */
export function assetManifestPaths(paths: AssetStoragePaths): string[] {
  return [paths.defaultManifest, ...paths.overrides.map(s => s.manifest)]
}
