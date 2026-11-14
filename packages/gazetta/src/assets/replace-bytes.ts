/**
 * Replace an asset's file in place (design-media.md M3).
 *
 * A new file of the same kind goes into the same asset: same name, new
 * hash. Everything that describes the asset rather than its bytes
 * (alt, focal point, tags, title, uploadedAt, ...) is kept, language and
 * theme versions are left alone, and no page or fragment manifest
 * changes: references name the asset, so they resolve to the new bytes.
 * Different from `replace.ts`, which points every reference at another
 * asset and deletes this one.
 *
 * Order: a revision holding the asset as it is now, when history lacks
 * it (so undo brings it back); new byte files, then the history revision,
 * then the manifest, then the old byte files. If writing the new files or recording the
 * revision fails, the new files are removed and the asset is as it was.
 * If the manifest write itself fails, the new files are removed too, but
 * the revision already recorded stays in history.
 */
import type { ContentRoot } from '../content-root.js'
import { createContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { ensureHistoryBaseline, recordWrite, type WrittenItem } from '../history-recorder.js'
import type { AssetManifest } from '../schema/types.js'
import { allFragmentEntries, allPageEntries, loadSite, type Site } from '../site-loader.js'
import type { SiteManifest, StorageProvider } from '../types.js'
import type { UploadAnalyzer } from './analyze.js'
import { assetStoragePaths } from './asset-paths.js'
import { AssetKindMismatchError, AssetStorageError } from './errors.js'
import { checkKindCompat } from './kind-compat.js'
import { manifestPath, readManifest, writeManifest } from './manifest.js'
import type { UploadPreprocessor } from './preprocess.js'
import { type ByteFields, byteStreamFrom, processUploadBytes } from './process-bytes.js'
import { rollback } from './rollback.js'
import { findAssetRefObjects } from './scan-manifest-for-asset.js'
import type { UploadPolicy } from './validate.js'

export interface ReplaceAssetBytesInput {
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
  /** Path prefix for site content, for counting the asset's uses. */
  siteDir: string
  assetName: string
  bytes: ReadableStream<Uint8Array>
  policy?: UploadPolicy
  /** Project-level manifest passed to `loadSite`. */
  manifest?: SiteManifest
  /** Already-loaded site for counting uses; loaded here when omitted. */
  site?: Site
  /** When set, the replace records one revision. */
  history?: HistoryProvider
  /** Content root history paths are relative to; built from `storage` + `siteDir` when omitted. */
  contentRoot?: ContentRoot
  author?: string
  preprocessors?: readonly UploadPreprocessor[]
  analyzers?: readonly UploadAnalyzer[]
}

export interface ReplaceAssetBytesResult {
  manifest: AssetManifest
  /** Page and fragment references to the asset that carry their own alt. */
  perUseAltCount: number
}

/**
 * Throws `AssetManifestNotFoundError` (404) when the asset doesn't exist,
 * `AssetKindMismatchError` (409) when the file is another kind, the
 * upload-validation errors (400), and `AssetStorageError` (500).
 */
export async function replaceAssetBytes(input: ReplaceAssetBytesInput): Promise<ReplaceAssetBytesResult> {
  const existing = await readManifest(input.storage, input.assetsRoot, input.assetName)

  const processed = await processUploadBytes({
    bytes: input.bytes,
    requestedName: input.assetName,
    assetName: input.assetName,
    policy: input.policy,
    preprocessors: input.preprocessors,
    analyzers: input.analyzers,
  })

  const updated: AssetManifest = withByteFields(existing, processed.fields)
  const compat = checkKindCompat(existing, { ...updated, kind: processed.kind })
  if (!compat.compatible) {
    throw new AssetKindMismatchError(compat.oldKind, compat.oldMimeCategory, compat.newKind, compat.newMimeCategory)
  }

  // Counted before any write: references don't change, and a site that
  // fails to load must not fail a replace that already happened.
  const contentRoot = input.contentRoot ?? createContentRoot(input.storage, input.siteDir)
  const site = input.site ?? (await loadSite({ contentRoot, manifest: input.manifest ?? { name: '(replace-file)' } }))
  const perUseAltCount = countPerUseAlt(site, input.assetName)

  const root = input.assetsRoot
  const newFiles = [processed.primary, ...processed.extras].map(f => ({ abs: `${root}/${f.path}`, bytes: f.bytes }))
  const newPaths = new Set(newFiles.map(f => f.abs))
  // Same bytes again give the same paths; those must survive the cleanup.
  const oldPaths = oldBytePaths(root, existing).filter(p => !newPaths.has(p))

  const manifestAbs = `${root}/${manifestPath(input.assetName)}`
  if (input.history) {
    await recordStateBeforeReplace(input.history, contentRoot, input.storage, input.assetName, [
      manifestAbs,
      ...oldBytePaths(root, existing),
    ])
  }

  // Only files this replace created are rolled back: the same bytes give
  // the same hashed paths, which the unchanged manifest still points at.
  const written: string[] = []
  for (const f of newFiles) {
    try {
      const existed = await input.storage.exists(f.abs)
      await input.storage.writeStream(f.abs, byteStreamFrom(f.bytes))
      if (!existed) written.push(f.abs)
    } catch (err) {
      await rollback(input.storage, written)
      throw new AssetStorageError('write', f.abs, err)
    }
  }

  try {
    if (input.history) {
      const items: WrittenItem[] = [
        { path: manifestAbs, content: `${JSON.stringify(updated, null, 2)}\n` },
        ...newFiles.map(f => ({ path: f.abs, content: f.bytes })),
        ...oldPaths.map(p => ({ path: p, content: null })),
      ]
      await recordWrite({
        history: input.history,
        contentRoot,
        operation: 'save',
        author: input.author,
        items,
        message: `Replace the file of ${input.assetName}`,
      })
    }
    await writeManifest(input.storage, root, updated)
  } catch (err) {
    await rollback(input.storage, written)
    throw err
  }

  // The manifest no longer points at the old files; a file left behind
  // is an orphan for GC, not a broken asset, so the replace stands.
  await rollback(input.storage, oldPaths)

  return { manifest: updated, perUseAltCount }
}

/**
 * The existing manifest with only the fields that describe the bytes
 * replaced. Optional byte fields the new file lacks (an animated GIF
 * replaced by a still) are dropped, not carried over.
 */
function withByteFields(existing: AssetManifest, fields: ByteFields): AssetManifest {
  const { animated: _a, frames: _f, duration: _d, poster: _p, ...rest } = existing
  return { ...rest, ...fields }
}

/**
 * Undo restores the revision before the replace, so that revision must
 * hold the asset as it is now. An asset uploaded before history was on,
 * or edited without a revision, isn't in it: record its current manifest
 * and byte files first, as their own revision.
 */
async function recordStateBeforeReplace(
  history: HistoryProvider,
  contentRoot: ContentRoot,
  storage: StorageProvider,
  assetName: string,
  paths: readonly string[],
): Promise<void> {
  await ensureHistoryBaseline({ history, contentRoot })
  const [head] = await history.listRevisions(1)
  const snapshot = head ? (await history.readRevision(head.id)).snapshot : {}
  const items: WrittenItem[] = []
  for (const path of paths) {
    if (!(await storage.exists(path))) continue
    const current = await storage.readBytes(path)
    const hash = snapshot[path]
    if (hash !== undefined && sameBytes(await history.readBlob(hash), current)) continue
    items.push({ path, content: current })
  }
  if (items.length === 0) return
  await recordWrite({
    history,
    contentRoot,
    operation: 'save',
    items,
    message: `Before replacing the file of ${assetName}`,
  })
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function oldBytePaths(root: string, manifest: AssetManifest): string[] {
  const paths = assetStoragePaths(root, manifest)
  const out = [paths.defaultBytes, ...paths.defaultVariants]
  if (typeof manifest.poster === 'string') out.push(`${root}/${manifest.poster}`)
  return out
}

function countPerUseAlt(site: Site, assetName: string): number {
  const manifests = [...allPageEntries(site).map(e => e.page), ...allFragmentEntries(site).map(e => e.fragment)]
  let count = 0
  for (const m of manifests) {
    for (const ref of findAssetRefObjects(m, assetName)) {
      if (typeof ref.alt === 'string') count++
    }
  }
  return count
}
