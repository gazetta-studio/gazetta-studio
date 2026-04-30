/**
 * Asset-refs sidecars — per-edge zero-byte index for "which items reference
 * this asset?" queries.
 *
 * Shape (mirrors `.uses-{frag}` and `.tpl-{template}` sidecars in spirit):
 *   `{root}/.gazetta/asset-refs/{asset}/{encoded-item-path}`
 *
 * Where:
 *   - `{asset}` is the asset name (slashes encoded via `encodeRefName`)
 *   - `{encoded-item-path}` is `pages.{name}` or `fragments.{name}`,
 *      with `/` → `.` (matching existing sidecar encoding), plus an
 *      optional `:locale` suffix for locale variants
 *
 * Files are zero bytes. Existence is the index.
 *
 * Why per-edge sidecars instead of an aggregate JSON file:
 *   - Multi-instance correctness: two admin instances saving different
 *     items both adding refs to `hero` write to *different paths*. No
 *     race, no optimistic concurrency, no retry. Granularity solves the
 *     write-contention problem that an aggregate JSON would face.
 *   - Pattern consistency: matches the existing `.uses-*` / `.tpl-*`
 *     filename-encoded sidecar approach.
 *   - Self-sufficient targets: same shape on source AND target so any
 *     target promoted to source is immediately usable.
 *
 * See `design-media-implementation.md` → "Asset refs — per-edge sidecar
 * index (v1)" for the full rationale and bench data.
 *
 * Single responsibility: filename encoding + per-asset directory I/O.
 * Save handlers, publish flow, and reindex CLI compose this with their
 * own walks.
 */
import type { ContentRoot } from '../content-root.js'
import type { StorageProvider } from '../types.js'
import { encodeRefName } from '../hash.js'
import type { AssetRef } from './refs.js'
import { collectAssetRefs } from './scan-manifest-for-asset.js'

/**
 * Where the asset-refs index lives, relative to the content root. Same
 * `.gazetta/` namespace as history — the runtime never serves it.
 */
export const ASSET_REFS_ROOT = '.gazetta/asset-refs'

/**
 * Identity of a referencing item. Distinct entries for each locale
 * variant (per design-media.md → i18n: "Each referencing manifest
 * (including locale variants) is a separate entry").
 */
export interface ItemRef {
  source: 'page' | 'fragment'
  /** Bare item name, e.g. `home` or `blog/[slug]`. */
  name: string
  /** Locale code for locale variants; absent for the default-locale manifest. */
  locale?: string
}

/**
 * Encode an `ItemRef` into a sidecar filename.
 *   { source: 'page', name: 'home' } → 'pages.home'
 *   { source: 'page', name: 'blog/[slug]' } → 'pages.blog.[slug]'
 *   { source: 'fragment', name: 'header', locale: 'fr' } → 'fragments.header:fr'
 */
export function itemRefToFilename(ref: ItemRef): string {
  const prefix = ref.source === 'page' ? 'pages' : 'fragments'
  const encodedName = encodeRefName(ref.name)
  const base = `${prefix}.${encodedName}`
  return ref.locale ? `${base}:${ref.locale}` : base
}

const FILENAME_RE = /^(pages|fragments)\.(.+?)(?::([a-z]{2}(?:-[a-z]+)?))?$/

/**
 * Parse a sidecar filename back to an `ItemRef`. Returns null for any
 * filename that doesn't match the encoding shape (so unrelated files
 * accidentally placed in the directory don't poison reads).
 */
export function filenameToItemRef(filename: string): ItemRef | null {
  const m = FILENAME_RE.exec(filename)
  if (!m) return null
  const source = m[1] === 'pages' ? 'page' : 'fragment'
  // Decode `.` → `/` to recover the original name. encodeRefName rejects
  // dots in input, so this is unambiguous: every `.` came from a slash.
  const name = m[2]!.replace(/\./g, '/')
  const locale = m[3]
  return locale ? { source, name, locale } : { source, name }
}

/** Path of the per-asset directory: `{root}/.gazetta/asset-refs/{asset}/`. */
export function assetRefsDir(contentRoot: ContentRoot, assetName: string): string {
  return contentRoot.path(ASSET_REFS_ROOT, encodeRefName(assetName))
}

/** Path of one sidecar file inside its asset's directory. */
export function refSidecarPath(contentRoot: ContentRoot, assetName: string, item: ItemRef): string {
  return contentRoot.path(ASSET_REFS_ROOT, encodeRefName(assetName), itemRefToFilename(item))
}

/**
 * Read all `ItemRef`s currently sidecar-indexed for `assetName`. Returns
 * empty when the directory is missing (no refs, or freshly-created
 * site).
 */
export async function readRefsForAsset(contentRoot: ContentRoot, assetName: string): Promise<ItemRef[]> {
  const dir = assetRefsDir(contentRoot, assetName)
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await contentRoot.storage.readDir(dir)
  } catch {
    // Missing directory — treat as no refs. Storage providers vary in
    // exact error shape, so we accept any read failure here.
    return []
  }
  const refs: ItemRef[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const ref = filenameToItemRef(entry.name)
    if (ref) refs.push(ref)
  }
  return refs
}

/** Convert an `ItemRef` to the `AssetRef` shape used by callers like delete.ts. */
export function itemRefToAssetRef(item: ItemRef): AssetRef {
  // The sidecar doesn't carry componentPath — it answers "is this asset
  // referenced by this item?" but not "where exactly in the manifest."
  // For breadcrumb display, callers re-read the manifest on demand.
  const filename = item.source === 'page' ? 'page' : 'fragment'
  const localePart = item.locale ? `.${item.locale}` : ''
  const folder = item.source === 'page' ? 'pages' : 'fragments'
  return {
    source: item.source,
    path: `${folder}/${item.name}/${filename}${localePart}.json`,
    componentPath: null,
  }
}

/**
 * Apply the diff for one item's asset refs.
 *
 * For each asset in `oldAssets ∪ newAssets`:
 *   - If new and not old → write the sidecar file (creating the asset dir)
 *   - If old and not new → remove the sidecar file
 *   - If both or neither → no I/O
 *
 * Sidecar writes are idempotent (zero-byte files at fixed paths), so
 * concurrent writes from multiple admin instances converge to the same
 * final state. The diff is **per item × per asset**: each instance's
 * save updates only the sidecars for the item it just wrote, leaving
 * other items' sidecars to their own save handlers.
 */
export async function applyItemRefsDiff(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldAssets: ReadonlySet<string>,
  newAssets: ReadonlySet<string>,
): Promise<void> {
  const added: string[] = []
  const removed: string[] = []
  for (const a of newAssets) if (!oldAssets.has(a)) added.push(a)
  for (const a of oldAssets) if (!newAssets.has(a)) removed.push(a)

  // Adds first — order doesn't affect correctness, but adds-before-removes
  // means a transient observer mid-update sees a superset of refs (safe
  // for delete-blocking) rather than a subset.
  await Promise.all(added.map(asset => writeSidecar(contentRoot, asset, item)))
  await Promise.all(removed.map(asset => removeSidecar(contentRoot, asset, item)))
}

async function writeSidecar(contentRoot: ContentRoot, assetName: string, item: ItemRef): Promise<void> {
  const dir = assetRefsDir(contentRoot, assetName)
  await contentRoot.storage.mkdir(dir).catch(() => {
    // Already exists — fine.
  })
  await contentRoot.storage.writeFile(refSidecarPath(contentRoot, assetName, item), '')
}

async function removeSidecar(contentRoot: ContentRoot, assetName: string, item: ItemRef): Promise<void> {
  await contentRoot.storage.rm(refSidecarPath(contentRoot, assetName, item)).catch(() => {
    // Already gone — fine. rm is idempotent for our purposes.
  })
}

/**
 * Rebuild the asset-refs sidecars for one item from its current manifest.
 * Equivalent to `applyItemRefsDiff(item, walked-from-disk, walked-from-current-manifest)`
 * but skips the "old" walk when the caller already has the previous
 * manifest. Use cases:
 *   - Save handler: pass `oldManifest` (loaded for history-recording);
 *     module re-extracts both old and new refs.
 *   - Reindex CLI: pass `oldManifest = null` to write fresh sidecars
 *     for every asset the item references (the old set comes from disk).
 */
export async function rebuildItemRefs(
  contentRoot: ContentRoot,
  item: ItemRef,
  oldManifest: Parameters<typeof collectAssetRefs>[0] | null,
  newManifest: Parameters<typeof collectAssetRefs>[0] | null,
): Promise<void> {
  const oldAssets = oldManifest ? collectAssetRefs(oldManifest) : new Set<string>()
  const newAssets = newManifest ? collectAssetRefs(newManifest) : new Set<string>()
  await applyItemRefsDiff(contentRoot, item, oldAssets, newAssets)
}

/**
 * Storage-direct helpers for callers that have a `StorageProvider` but
 * don't want to construct a `ContentRoot` (legacy callers, tests). Same
 * semantics as the ContentRoot variants.
 */
export function refSidecarPathRaw(rootPath: string, assetName: string, item: ItemRef): string {
  const prefix = rootPath ? `${rootPath}/` : ''
  return `${prefix}${ASSET_REFS_ROOT}/${encodeRefName(assetName)}/${itemRefToFilename(item)}`
}

export async function readRefsForAssetRaw(
  storage: StorageProvider,
  rootPath: string,
  assetName: string,
): Promise<ItemRef[]> {
  const prefix = rootPath ? `${rootPath}/` : ''
  const dir = `${prefix}${ASSET_REFS_ROOT}/${encodeRefName(assetName)}`
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await storage.readDir(dir)
  } catch {
    return []
  }
  const refs: ItemRef[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const ref = filenameToItemRef(entry.name)
    if (ref) refs.push(ref)
  }
  return refs
}
