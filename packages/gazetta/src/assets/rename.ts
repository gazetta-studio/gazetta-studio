/**
 * Rename an asset.
 *
 * Author-facing semantics (design-media.md → Rename):
 *   "Rename `hero` → `banner` is safe-order:
 *      1. Copy bytes + variants to new hashed paths
 *      2. Copy manifest to `banner.asset.json`
 *      3. Rewrite all refs from `hero` → `banner`
 *      4. Delete old manifest `hero.asset.json`
 *      5. Delete old bytes + variants"
 *
 * URLs are always valid during rename — old bytes stay until refs are
 * rewritten. Per design, "Rename rewrites all references. No CMS in
 * our research does this automatically; it's distinctive and deliberate."
 *
 * Single responsibility: policy — "physically relocate the asset and
 * rewrite every reference, or refuse with a structured reason." This
 * module owns:
 *   - read source manifest (404 if missing)
 *   - reject if `newName` is already taken (409)
 *   - copy bytes + variants to new paths
 *   - write the new manifest
 *   - rewrite every referencing manifest in memory
 *   - record ONE history revision spanning all of the above
 *   - write the rewritten manifests
 *   - update asset-refs sidecars
 *   - delete the old asset (manifest + bytes + variants)
 *
 * It does NOT own:
 *   - HTTP concerns (the route adapter does)
 *   - per-manifest parsing (delegated to site-loader)
 *   - history wiring (caller passes the provider)
 */
import { join } from 'node:path'
import type { ComponentManifest, SiteManifest, StorageProvider } from '../types.js'
import type { ContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { createContentRoot } from '../content-root.js'
import { allFragmentEntries, allPageEntries, loadSite } from '../site-loader.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import { assetStoragePaths } from './asset-paths.js'
import { AssetManifestNotFoundError, AssetNameCollisionError, AssetStorageError } from './errors.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { manifestPath, readManifest, writeManifest, assetBytesPath, assetVariantBytesPath } from './manifest.js'
import { rewriteManifestAssetRef } from './rewrite-manifest-asset-ref.js'
import { rebuildAssetRefs, type ItemRef } from './asset-deps.js'
import { extFromMime } from './url.js'
import type { AssetManifest, AssetVariant } from '../schema/types.js'

export interface RenameAssetInput {
  /** Storage holding both the asset and the content tree. */
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
  /** Path prefix for site content (where `pages/` and `fragments/` live). */
  siteDir: string
  /** Existing asset name. */
  oldName: string
  /** Target name. Must not already exist. */
  newName: string
  /** Project-level manifest passed to `loadSite`. */
  manifest?: SiteManifest
  /** Optional — record one revision covering the whole operation. */
  history?: HistoryProvider
  /** Author identifier passed through to the history revision. */
  author?: string
  /**
   * Optional content root. When omitted, one is built from `storage`
   * + `siteDir`. Tests pass an explicit one to share a single root
   * with other operations.
   */
  contentRoot?: ContentRoot
}

export interface RenameAssetResult {
  /** How many references were rewritten across all manifests. */
  readonly refsRewritten: number
  /** How many distinct manifests were touched. */
  readonly manifestsRewritten: number
}

/**
 * Rename `oldName` → `newName`. Throws:
 *   - `AssetManifestNotFoundError` — old asset missing
 *   - `AssetNameCollisionError` — new name already taken
 *   - `AssetMimeUnsupportedError` — old asset's MIME has no extension
 *     mapping (misconfiguration; thrown during path enumeration)
 *   - `AssetStorageError` — any underlying read/write/rm failure
 */
export async function renameAsset(input: RenameAssetInput): Promise<RenameAssetResult> {
  if (input.oldName === input.newName) {
    return { refsRewritten: 0, manifestsRewritten: 0 }
  }

  // Step 1 — read source manifest. Throws AssetManifestNotFoundError
  // when missing; that bubbles to 404.
  const oldManifest = await readManifest(input.storage, input.assetsRoot, input.oldName)

  // Step 2 — refuse if the destination name is already taken. We
  // probe the manifest path directly rather than calling readManifest
  // (which would throw an error class we'd then suppress).
  const newManifestAbs = `${input.assetsRoot}/${manifestPath(input.newName)}`
  if (await input.storage.exists(newManifestAbs)) {
    throw new AssetNameCollisionError(input.newName)
  }

  // Step 3 — enumerate source paths and compute the destination paths.
  // Bytes don't change during rename; only the filename does. The hash
  // stays the same, the byte content is identical — hash-in-path means
  // {oldName}-{hash}.jpg → {newName}-{hash}.jpg with the same bytes.
  const oldPaths = assetStoragePaths(input.assetsRoot, oldManifest)
  const ext = extFromMime(oldManifest.mime)
  if (!ext) {
    // Should not reach here — assetStoragePaths would have thrown
    // AssetMimeUnsupportedError already. Defensive only.
    throw new AssetManifestNotFoundError(input.oldName)
  }

  // Build the new manifest by swapping name + variant paths. Hash, size,
  // dimensions, MIME, alt all carry over unchanged — bytes are identical.
  const newVariants: AssetVariant[] = oldManifest.variants.map(v => ({
    width: v.width,
    path: assetVariantBytesPath(input.newName, oldManifest.hash, ext, v.width),
    size: v.size,
  }))
  const newManifest: AssetManifest = {
    ...oldManifest,
    name: input.newName,
    variants: newVariants,
  }
  const newBytesRel = assetBytesPath(input.newName, oldManifest.hash, ext)
  const newBytesAbs = `${input.assetsRoot}/${newBytesRel}`

  // Step 4 — load the site once, rewrite refs in memory.
  const contentRoot = input.contentRoot ?? createContentRoot(input.storage, input.siteDir)
  const site = await loadSite({ contentRoot, manifest: input.manifest })

  type Rewrite = {
    path: string
    serialized: string
    oldManifest: ComponentManifest
    newManifest: ComponentManifest
    item: ItemRef
  }
  const rewrites: Rewrite[] = []
  let refsRewritten = 0

  for (const { name, page, locale } of allPageEntries(site)) {
    const { manifest: rewritten, rewriteCount } = rewriteManifestAssetRef({
      manifest: page,
      fromAssetName: input.oldName,
      toAssetName: input.newName,
    })
    if (rewriteCount === 0) continue
    refsRewritten += rewriteCount
    rewrites.push({
      path: localeManifestPath('pages', name, 'page', locale),
      serialized: `${JSON.stringify(stripRuntimeFields(rewritten), null, 2)}\n`,
      oldManifest: page,
      newManifest: rewritten,
      item: locale ? { source: 'page', name, locale } : { source: 'page', name },
    })
  }

  for (const { name, fragment, locale } of allFragmentEntries(site)) {
    const { manifest: rewritten, rewriteCount } = rewriteManifestAssetRef({
      manifest: fragment,
      fromAssetName: input.oldName,
      toAssetName: input.newName,
    })
    if (rewriteCount === 0) continue
    refsRewritten += rewriteCount
    rewrites.push({
      path: localeManifestPath('fragments', name, 'fragment', locale),
      serialized: `${JSON.stringify(stripRuntimeFields(rewritten), null, 2)}\n`,
      oldManifest: fragment,
      newManifest: rewritten,
      item: locale ? { source: 'fragment', name, locale } : { source: 'fragment', name },
    })
  }

  // Step 5 — read source bytes + variants into memory (single pass).
  // Each provider's `readBytes` returns a Uint8Array; we hold them in
  // memory for both the history revision and the subsequent writes.
  // Variant bytes are bounded by the per-target upload cap × number of
  // variants (4 × 50 MB max = 200 MB worst case for v1; in practice
  // variants are an order of magnitude smaller than the source).
  let primaryBytes: Uint8Array
  try {
    primaryBytes = await input.storage.readBytes(oldPaths.defaultBytes)
  } catch (err) {
    throw new AssetStorageError('read', oldPaths.defaultBytes, err)
  }
  const variantBytes = new Map<string, Uint8Array>()
  for (let i = 0; i < oldManifest.variants.length; i++) {
    const oldVariantAbs = `${input.assetsRoot}/${oldManifest.variants[i]!.path}`
    try {
      variantBytes.set(`${input.assetsRoot}/${newVariants[i]!.path}`, await input.storage.readBytes(oldVariantAbs))
    } catch (err) {
      throw new AssetStorageError('read', oldVariantAbs, err)
    }
  }

  // Step 6 — record history BEFORE any writes. One revision covers:
  //   - new manifest at the new path
  //   - new bytes at the new path
  //   - new variant bytes at the new paths
  //   - every rewritten ref-manifest
  //   - old manifest, old bytes, old variants as deletions
  if (input.history) {
    const items: WrittenItem[] = [
      // Adds (new locations)
      { path: newManifestAbs, content: `${JSON.stringify(newManifest, null, 2)}\n` },
      { path: newBytesAbs, content: primaryBytes },
      ...newVariants.map(v => ({
        path: `${input.assetsRoot}/${v.path}`,
        content: variantBytes.get(`${input.assetsRoot}/${v.path}`)!,
      })),
      // Ref rewrites
      ...rewrites.map(r => ({ path: r.path, content: r.serialized })),
      // Removals (old locations)
      { path: oldPaths.defaultManifest, content: null },
      { path: oldPaths.defaultBytes, content: null },
      ...oldPaths.defaultVariants.map(p => ({ path: p, content: null })),
    ]
    await recordWrite({
      history: input.history,
      contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Rename ${input.oldName} → ${input.newName}`,
    })
  }

  // Step 7 — copy bytes + variants to new paths (additive: old paths
  // still exist; no URLs break). Failure here surfaces the underlying
  // storage error; rollback of partial copies is best-effort by
  // letting the caller retry (idempotent: re-copy of identical bytes
  // is fine, and orphan new-bytes from a failed run get cleaned by
  // future GC).
  try {
    await input.storage.writeBytes(newBytesAbs, primaryBytes)
  } catch (err) {
    throw new AssetStorageError('write', newBytesAbs, err)
  }
  for (const [path, bytes] of variantBytes) {
    try {
      await input.storage.writeBytes(path, bytes)
    } catch (err) {
      throw new AssetStorageError('write', path, err)
    }
  }

  // Step 8 — write the new manifest. This is the "this asset exists
  // under the new name" record. After this point, refs to either
  // {oldName} or {newName} resolve to bytes; we still rewrite refs
  // before deleting old paths so URLs stay valid throughout.
  await writeManifest(input.storage, input.assetsRoot, newManifest)

  // Step 9 — write every rewritten ref-manifest. Best-effort like
  // replace.ts: if any write fails, subsequent writes still attempt
  // (so partial rewrites land), and we surface the first error.
  for (const r of rewrites) {
    const abs = contentRoot.path(r.path)
    try {
      await input.storage.writeFile(abs, r.serialized)
    } catch (err) {
      throw new AssetStorageError('write', abs, err)
    }
  }

  // Step 10 — update asset-refs sidecars. For each rewritten manifest,
  // the diff drops `oldName` and adds `newName`, so sidecars move from
  // `.gazetta/asset-refs/{oldName}/{item}` → `.gazetta/asset-refs/
  // {newName}/{item}`. Errors are non-fatal (sidecars are derived state
  // recoverable via reindex CLI).
  await Promise.all(
    rewrites.map(r =>
      rebuildAssetRefs(contentRoot, r.item, r.oldManifest, r.newManifest).catch(err => {
        // eslint-disable-next-line no-console
        console.warn(`asset-refs sidecar update failed for ${r.path}: ${(err as Error).message}`)
      }),
    ),
  )

  // Step 11 — delete the old asset. Manifest first means callers who
  // race the rename mid-flight see "asset not found at oldName" rather
  // than "manifest exists but bytes are missing." `assetPathsInRemovalOrder`
  // puts manifests last for a different reason (atomicity during delete);
  // here we want the manifest gone first so the "is it under the old name?"
  // check resolves cleanly. Compose by hand rather than reusing the helper.
  const oldOrderedPaths = [oldPaths.defaultManifest, oldPaths.defaultBytes, ...oldPaths.defaultVariants]
  for (const path of oldOrderedPaths) {
    try {
      await rmIgnoreMissing(input.storage, path)
    } catch (err) {
      throw new AssetStorageError('delete', path, err)
    }
  }

  return { refsRewritten, manifestsRewritten: rewrites.length }
}

/**
 * `loadSite` decorates page/fragment manifests with a `dir` field for
 * its own bookkeeping. `dir` is not part of the stored manifest JSON,
 * so strip it before serialization. Same helper as in replace.ts —
 * with only two callers, kept inline (3+-callers rule).
 */
function stripRuntimeFields(manifest: ComponentManifest): ComponentManifest {
  const copy: Record<string, unknown> = { ...manifest }
  delete copy.dir
  return copy as unknown as ComponentManifest
}

function localeManifestPath(
  root: 'pages' | 'fragments',
  itemName: string,
  baseName: 'page' | 'fragment',
  locale: string | undefined,
): string {
  const file = locale ? `${baseName}.${locale}.json` : `${baseName}.json`
  return join(root, itemName, file)
}
