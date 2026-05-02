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
import type { AssetManifest, LocaleOverrideManifest } from '../schema/types.js'
import { selectorsEqual, type Selector } from '../schema/dimensions.js'
import type { StorageProvider } from '../types.js'
import { AssetMimeUnsupportedError } from './errors.js'
import { assetBytesPath, manifestPath } from './manifest.js'
import { localeManifestVariantFor } from './manifest-locale.js'
import { parseManifestFilename } from './manifest-filename.js'
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
 * Pure — no I/O. Override slices come from the caller (typically built
 * via `enumerateOverrideSlices` after a disk scan, or supplied by an
 * in-memory write planner). Defaults to an empty `overrides` so callers
 * that don't deal with locale/theme variants don't pay the I/O cost.
 */
export function assetStoragePaths(
  assetsRoot: string,
  manifest: AssetManifest,
  overrides: readonly OverrideSlice[] = [],
): AssetStoragePaths {
  const ext = extFromMime(manifest.mime)
  if (!ext) {
    throw new AssetMimeUnsupportedError(manifest.mime, manifest.name)
  }
  return {
    defaultManifest: `${assetsRoot}/${manifestPath(manifest.name)}`,
    defaultBytes: `${assetsRoot}/${assetBytesPath(manifest.name, manifest.hash, ext)}`,
    defaultVariants: manifest.variants.map(v => `${assetsRoot}/${v.path}`),
    overrides: [...overrides].sort(compareOverrideSlices),
  }
}

/**
 * Async wrapper around `assetStoragePaths` that scans `assetsRoot/` for
 * existing locale/theme override manifests and reads them so the result
 * is fully populated with `OverrideSlice[]`.
 *
 * Used by callers that need every-path-for-this-asset (delete, rename,
 * future GC). Pure consumers (compose paths from a known override set)
 * keep using `assetStoragePaths` directly with overrides they already
 * have.
 *
 * Path-style names (`products/shot`): scan happens under the asset's
 * parent directory (`assetsRoot/products/`) and matches
 * `shot.asset.*.json` siblings.
 *
 * Embedded + downloadable kinds use `LocaleOverrideManifest`. Font is
 * out-of-scope here for v1 — fonts are additive, not override, so
 * delete/rename for fonts already pick up additive variants by listing
 * all sibling manifest files. Today the same scanner reads them as
 * locale-override-shaped slices for path enumeration — the bytes path
 * comes from the manifest's `hash` either way.
 */
export async function enumerateAssetStoragePaths(
  storage: StorageProvider,
  assetsRoot: string,
  manifest: AssetManifest,
): Promise<AssetStoragePaths> {
  const overrides = await enumerateOverrideSlices(storage, assetsRoot, manifest)
  return assetStoragePaths(assetsRoot, manifest, overrides)
}

/**
 * Scan disk for locale/theme override manifests of `manifest`'s asset
 * and return the parsed slices. Pure I/O; pairs with the pure
 * `assetStoragePaths` to compose the full path set.
 */
export async function enumerateOverrideSlices(
  storage: StorageProvider,
  assetsRoot: string,
  manifest: AssetManifest,
): Promise<OverrideSlice[]> {
  // Asset name can be path-style (`products/shot`). Scan happens in the
  // immediate parent directory; sibling matching uses the leaf name.
  const slashIdx = manifest.name.lastIndexOf('/')
  const parentDir = slashIdx >= 0 ? `${assetsRoot}/${manifest.name.slice(0, slashIdx)}` : assetsRoot
  const leafName = slashIdx >= 0 ? manifest.name.slice(slashIdx + 1) : manifest.name

  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await storage.readDir(parentDir)
  } catch {
    return []
  }

  const variant = localeManifestVariantFor(manifest.kind)
  const slices: OverrideSlice[] = []

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const parsed = parseManifestFilename(entry.name)
    // Skip non-manifests, default manifest, and manifests for OTHER
    // assets (path-style siblings can sit in the same directory).
    if (!parsed) continue
    if (parsed.assetName !== leafName) continue
    if (parsed.selector === null) continue

    const localeManifest = await variant.read(storage, assetsRoot, manifest.name, parsed.selector)
    if (localeManifest === null) continue

    slices.push(buildOverrideSlice(assetsRoot, manifest, parsed.selector, localeManifest))
  }

  return slices
}

function buildOverrideSlice(
  assetsRoot: string,
  defaultManifest: AssetManifest,
  selector: Selector,
  localeManifest: LocaleOverrideManifest | { hash?: string; mime?: string; variants?: readonly { path: string }[] },
): OverrideSlice {
  const manifestRel = manifestPath(defaultManifest.name, selector)
  const manifestAbs = `${assetsRoot}/${manifestRel}`

  // Bytes-override slice has its own hash + mime (mime can differ per
  // locale: jpeg default, webp override). Metadata-only slice has no
  // bytes; the resolver falls back to default bytes at render time.
  const localeHash = localeManifest.hash
  if (localeHash === undefined) {
    return { selector, manifest: manifestAbs, bytes: null, variants: [] }
  }

  const localeMime = localeManifest.mime ?? defaultManifest.mime
  const localeExt = extFromMime(localeMime)
  if (!localeExt) {
    // Should never reach here — the locale manifest validator already
    // requires a known MIME when `hash` is set. Defensive path: surface
    // as no-bytes slice rather than throwing, since path enumeration
    // should be lossy-tolerant (the manifest itself reports the
    // problem on read).
    return { selector, manifest: manifestAbs, bytes: null, variants: [] }
  }

  const bytesAbs = `${assetsRoot}/${assetBytesPath(defaultManifest.name, localeHash, localeExt, selector)}`
  // Variant paths come from the locale manifest's own `variants` list
  // (per-locale ladder, generated when the override bytes were
  // ingested). No recomputation — single source of truth on the disk.
  const variantAbs = (localeManifest.variants ?? []).map(v => `${assetsRoot}/${v.path}`)
  return { selector, manifest: manifestAbs, bytes: bytesAbs, variants: variantAbs }
}

/**
 * Total order on override slices for deterministic iteration. Sorts by
 * the dimension values in `DIMENSION_ORDER` order. Two selectors with
 * the same values are considered equal (selector identity is set-like).
 */
function compareOverrideSlices(a: OverrideSlice, b: OverrideSlice): number {
  if (selectorsEqual(a.selector, b.selector)) return 0
  // Compare locale first, then theme, missing dimensions sort before set ones.
  const aLoc = a.selector.get('locale') ?? ''
  const bLoc = b.selector.get('locale') ?? ''
  if (aLoc !== bLoc) return aLoc < bLoc ? -1 : 1
  const aTheme = a.selector.get('theme') ?? ''
  const bTheme = b.selector.get('theme') ?? ''
  return aTheme < bTheme ? -1 : aTheme > bTheme ? 1 : 0
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
