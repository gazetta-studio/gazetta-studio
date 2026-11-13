/**
 * Asset ingest — "bytes in → new asset out." The bytes go through
 * `processUploadBytes` (validation, sniffing, hashing, analysis, variants);
 * this module persists the files and writes the new asset's manifest.
 *
 * The stream is collected into memory first: validation, hashing and
 * analysis all need every byte, which is fine within the upload size cap.
 * A future large-video path would need true streaming.
 *
 * History atomicity:
 *   When `history` is provided, ingest records ONE revision covering the
 *   manifest + primary bytes + every variant. Recording happens BEFORE any
 *   writes so the recorder's first-time baseline scan captures pre-op
 *   state — same pattern as `replace.ts`. If recording succeeds but a
 *   subsequent write fails, the revision references blobs we never
 *   persisted; that's recoverable (history-restorer degrades gracefully
 *   on missing blobs) and rare (writes after a successful record fail
 *   only on transient storage errors), and far better than the inverse
 *   (writes succeed, recorder captures post-op state, undo is a no-op).
 */
import type { ContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import type { AssetManifest } from '../schema/types.js'
import type { StorageProvider } from '../types.js'
import type { UploadAnalyzer } from './analyze.js'
import { AssetStorageError } from './errors.js'
import { manifestPath, writeManifest } from './manifest.js'
import type { UploadPolicy } from './validate.js'
import type { UploadPreprocessor } from './preprocess.js'
import { byteStreamFrom, processUploadBytes } from './process-bytes.js'
import { rollback } from './rollback.js'

export interface IngestInput {
  /** The target's storage provider. */
  storage: StorageProvider
  /** The assets directory prefix (e.g., `"assets"`) relative to storage root. */
  assetsRoot: string
  /** The incoming byte stream (multipart file body). */
  bytes: ReadableStream<Uint8Array>
  /** Author-chosen asset name (pre-validation; policy may reject). */
  requestedName: string
  /** Optional author-supplied alt text. Null means "not set" (warns in the library). */
  alt: string | null
  /** Author identifier, if available. Empty string when RBAC isn't configured. */
  uploadedBy: string
  /**
   * Per-target upload policy. When omitted, the default size cap
   * (`DEFAULT_ASSET_MAX_BYTES` from validate.ts) applies. The HTTP
   * route should pass `target.assets` through here so per-target
   * limits are honored.
   */
  policy?: UploadPolicy
  /**
   * Optional history provider. When set, ingest records ONE revision
   * covering manifest + primary bytes + variants. Caller must also pass
   * `contentRoot` so the recorder can scan the pre-op baseline on its
   * first call.
   */
  history?: HistoryProvider
  /** Required when `history` is set — content root for the baseline scan. */
  contentRoot?: ContentRoot
  /** Author identifier passed through to the history revision. */
  author?: string
  /**
   * Format-specific preprocessors to run on the byte buffer before
   * hashing. Defaults to `defaultPreprocessors` (today: SVG
   * sanitization). Tests pass an empty array to bypass; future
   * deployments can register custom preprocessors (HEIC transcode,
   * etc.) without editing this module.
   */
  preprocessors?: readonly UploadPreprocessor[]
  /**
   * Format-specific analyzers to run on the post-preprocess bytes.
   * Defaults to `defaultAnalyzers` (today: width/height + animated
   * detection + poster extraction for images). Empty array bypasses
   * analysis; custom registries plug in audio metadata, EXIF,
   * PDF page count, etc. without editing this module.
   */
  analyzers?: readonly UploadAnalyzer[]
}

export interface IngestResult {
  manifest: AssetManifest
  bytesPath: string
}

/**
 * Ingest an asset. On success, bytes are persisted at
 * `{assetsRoot}/{name}-{hash}.{ext}` and the manifest at
 * `{assetsRoot}/{name}.asset.json`.
 *
 * Throws:
 * - `AssetValidationError` — name, size, or MIME failed policy
 * - `AssetStorageError` — storage write failed
 */
export async function ingestAsset(input: IngestInput): Promise<IngestResult> {
  const canonicalName = baseName(input.requestedName)
  const processed = await processUploadBytes({
    bytes: input.bytes,
    requestedName: input.requestedName,
    assetName: canonicalName,
    policy: input.policy,
    preprocessors: input.preprocessors,
    analyzers: input.analyzers,
  })
  const { fields } = processed

  const bytesPath = `${input.assetsRoot}/${processed.primary.path}`
  const manifest: AssetManifest = {
    version: 1,
    name: canonicalName,
    kind: processed.kind,
    source: 'internal',
    mime: fields.mime,
    size: fields.size,
    hash: fields.hash,
    width: fields.width,
    height: fields.height,
    variants: fields.variants,
    alt: input.alt,
    ...(fields.animated !== undefined ? { animated: fields.animated } : {}),
    ...(fields.frames !== undefined ? { frames: fields.frames } : {}),
    ...(fields.duration !== undefined ? { duration: fields.duration } : {}),
    ...(fields.poster !== undefined ? { poster: fields.poster } : {}),
    uploadedAt: new Date().toISOString(),
    uploadedBy: input.uploadedBy,
  }
  const manifestRelPath = manifestPath(canonicalName)
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`
  const extras = processed.extras.map(f => ({ abs: `${input.assetsRoot}/${f.path}`, bytes: f.bytes }))

  // Record history BEFORE any writes: the recorder's first-time baseline
  // scan must see pre-op state.
  if (input.history) {
    if (!input.contentRoot) {
      throw new Error('ingestAsset: history requires contentRoot')
    }
    const items: WrittenItem[] = [
      { path: `${input.assetsRoot}/${manifestRelPath}`, content: manifestSerialized },
      { path: bytesPath, content: processed.primary.bytes },
      ...extras.map(f => ({ path: f.abs, content: f.bytes })),
    ]
    await recordWrite({
      history: input.history,
      contentRoot: input.contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Upload ${canonicalName}`,
    })
  }

  // Byte files first; a failure unwinds every file written so far so a
  // partial upload leaves no orphans.
  const writtenPaths: string[] = []
  for (const f of [{ abs: bytesPath, bytes: processed.primary.bytes }, ...extras]) {
    try {
      await input.storage.writeStream(f.abs, byteStreamFrom(f.bytes))
    } catch (err) {
      await rollback(input.storage, writtenPaths)
      throw new AssetStorageError('write', f.abs, err)
    }
    writtenPaths.push(f.abs)
  }

  // Manifest last: it's the visible "asset exists" record.
  try {
    await writeManifest(input.storage, input.assetsRoot, manifest)
  } catch (err) {
    await rollback(input.storage, writtenPaths)
    throw err
  }

  return { manifest, bytesPath }
}

/**
 * Strip any trailing extension from a user-supplied name. The canonical
 * asset name is extension-free; extensions live on the byte filename
 * (`{name}-{hash}.{ext}`). Derives the same base name regardless of what
 * the client sent.
 */
function baseName(requested: string): string {
  const dot = requested.lastIndexOf('.')
  return dot > 0 ? requested.slice(0, dot) : requested
}
