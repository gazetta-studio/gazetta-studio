/**
 * Asset ingest pipeline — the single entry point for "bytes in → persisted
 * asset out." Composes validation, hashing, MIME sniffing, dimension
 * extraction, byte persistence, and manifest writing.
 *
 * Callers (HTTP upload route, future CLI import, future paste-URL handler):
 *   const result = await ingestAsset({ storage, assetsRoot, bytes, requestedName, ... })
 *
 * Inside, the stream is collected into a buffer first — for the v1 slice's
 * 50 MB limit this is the pragmatic choice (validation wants to see all the
 * bytes; hashing + sniffing + dimensions all need to touch them). A future
 * large-video path would need true streaming; calling sites that need that
 * can compose the lower-level primitives (sniffMimeFromStream, hashStream,
 * atomicWriteStream) directly.
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
import type { AssetManifest, AssetVariant } from '../schema/types.js'
import type { StorageProvider } from '../types.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import { runAnalyzers, type UploadAnalyzer } from './analyze.js'
import { AssetMimeMismatchError, AssetStorageError, AssetVariantGenerationError } from './errors.js'
import { ASSET_HASH_LENGTH, hashBytes } from './hash.js'
import { extractImageDimensions } from './image-metadata.js'
import { assetBytesPath, assetVariantBytesPath, manifestPath, writeManifest } from './manifest.js'
import { sniffMimeFromStream } from './mime-sniff.js'
import { type UploadPolicy, validateUpload } from './validate.js'
import { runPreprocessors, type UploadPreprocessor } from './preprocess.js'
import { generateVariants, type GeneratedVariant } from './variants.js'

/** Ext-from-MIME for the v1 allowlist (JPEG, PNG, SVG, GIF). */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
}

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
  // Collect bytes once so we can sniff, hash, measure, and persist from the
  // same buffer without re-consuming the source stream.
  const initialBuffer = await collectBytes(input.bytes)

  // Sniff MIME. file-type needs a web stream; build one from the buffer.
  const { mime, ext } = await sniffMimeFromStream(byteStreamFrom(initialBuffer))

  // Validate name + size + MIME against the per-target policy. Size
  // is checked pre-preprocess: the cap protects against worker body
  // limits + storage exhaustion at the request boundary, before any
  // transformation happens. SVG sanitization can shrink the bytes,
  // but a 100 MB SVG-of-doom should be rejected at the door, not
  // after we've parsed it.
  validateUpload({ name: input.requestedName, claimedSize: initialBuffer.byteLength, sniffedMime: mime }, input.policy)

  // Format-specific preprocessing — SVG sanitization today; HEIC
  // transcode, EXIF orientation, animated-GIF poster extraction,
  // etc. plug in via the `UploadPreprocessor` interface. Ingest
  // doesn't know which preprocessors are registered or what they do
  // (DIP / OCP — adding a format = new module + register, no edits
  // here). Failures throw `AssetPreprocessError` (HTTP 400).
  const { bytes: buffer } = await runPreprocessors(initialBuffer, mime, input.preprocessors)
  const size = buffer.byteLength

  // Extension is derived from the sniffed MIME (we ignore the client-sent
  // extension in the requested name — the validator already stripped it).
  const bytesExt = ext ?? EXT_BY_MIME[mime ?? ''] ?? ''
  if (!bytesExt) {
    throw new AssetMimeMismatchError(mime, [])
  }

  const hash = hashBytes(buffer)
  if (hash.length !== ASSET_HASH_LENGTH) {
    throw new AssetStorageError('write', input.requestedName, new Error('unexpected hash length'))
  }

  const canonicalName = baseName(input.requestedName)

  // Format-specific analysis — width/height for static images, plus
  // animated detection + first-frame poster extraction for animated.
  // Analyzers contribute manifest fields (`width`, `height`,
  // `animated`, `frames`, `duration`, `poster`) and optional
  // supplementary byte files (animated images add a `-poster.png`).
  // Pluggable via `input.analyzers`; defaults handle JPEG / PNG /
  // GIF / animated WebP / animated AVIF.
  const analysis =
    (mime ?? '').startsWith('image/') && mime !== 'image/svg+xml'
      ? await runAnalyzers(
          { bytes: buffer, assetName: canonicalName, hash, ext: bytesExt, mime: mime ?? '' },
          input.analyzers,
        )
      : {
          manifestPatch: undefined,
          supplementaryFiles: undefined as readonly { path: string; bytes: Uint8Array }[] | undefined,
        }

  // SVG dims still come from the legacy inline path — sharp handles
  // SVG via libvips but the post-sanitize bytes need their own pass
  // and analyzers skip SVG by design (`staticImageAnalyzer.matches`
  // excludes it). One day SVG dims could move into a dedicated SVG
  // analyzer; not today.
  const svgDims = mime === 'image/svg+xml' ? await extractImageDimensions(buffer) : null

  // Generate variants in memory before we touch storage. Vector
  // formats (SVG) and animated images skip variants — they don't
  // ladder-resize correctly. The rule lives in `shouldGenerateVariants`
  // for testability + extension.
  const generatedVariants: GeneratedVariant[] = []
  if (shouldGenerateVariants(mime, analysis.manifestPatch?.animated)) {
    try {
      const generated = await generateVariants(buffer)
      generatedVariants.push(...generated)
    } catch (err) {
      throw new AssetVariantGenerationError(canonicalName, err)
    }
  }

  // Compose the manifest in memory. Variant paths come from the same
  // `assetVariantBytesPath` helper used at write time — single source of
  // truth so the manifest's `variants[i].path` always matches the
  // on-disk filename.
  const manifestVariants: AssetVariant[] = generatedVariants.map(v => ({
    width: v.width,
    path: assetVariantBytesPath(canonicalName, hash, bytesExt, v.width),
    size: v.bytes.byteLength,
  }))
  const bytesRel = assetBytesPath(canonicalName, hash, bytesExt)
  const bytesPath = `${input.assetsRoot}/${bytesRel}`
  const manifest: AssetManifest = {
    version: 1,
    name: canonicalName,
    kind: 'embedded',
    source: 'internal',
    mime: mime ?? 'application/octet-stream',
    size,
    hash,
    // Width/height come from analyzer for non-SVG, from the legacy
    // inline path for SVG. Analyzer takes precedence when present.
    width: analysis.manifestPatch?.width ?? svgDims?.width ?? null,
    height: analysis.manifestPatch?.height ?? svgDims?.height ?? null,
    variants: manifestVariants,
    alt: input.alt,
    // Spread analyzer-contributed enrichment fields (animated, frames,
    // duration, poster). Only present when the analyzer set them, so
    // the manifest doesn't carry undefined values for static assets.
    ...(analysis.manifestPatch?.animated !== undefined ? { animated: analysis.manifestPatch.animated } : {}),
    ...(analysis.manifestPatch?.frames !== undefined ? { frames: analysis.manifestPatch.frames } : {}),
    ...(analysis.manifestPatch?.duration !== undefined ? { duration: analysis.manifestPatch.duration } : {}),
    ...(analysis.manifestPatch?.poster !== undefined ? { poster: analysis.manifestPatch.poster } : {}),
    uploadedAt: new Date().toISOString(),
    uploadedBy: input.uploadedBy,
  }
  const manifestRelPath = manifestPath(canonicalName)
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`

  // Resolve absolute paths for the supplementary files contributed by
  // the analyzer (animated poster today). Used in both the history
  // items list and the write loop.
  const supplementaryFiles = (analysis.supplementaryFiles ?? []).map(f => ({
    abs: `${input.assetsRoot}/${f.path}`,
    bytes: f.bytes,
  }))

  // Record history BEFORE any writes. Mirrors the replace.ts pattern:
  // recorder's first-time baseline scan must see pre-op state. Items
  // include the manifest (text), primary bytes (binary), every variant
  // (binary), and any analyzer-contributed supplementary files (e.g.
  // animated-image posters) — the snapshot covers the full asset.
  if (input.history) {
    if (!input.contentRoot) {
      throw new Error('ingestAsset: history requires contentRoot')
    }
    const items: WrittenItem[] = [
      { path: `${input.assetsRoot}/${manifestRelPath}`, content: manifestSerialized },
      { path: bytesPath, content: buffer },
      ...generatedVariants.map(v => ({
        path: `${input.assetsRoot}/${assetVariantBytesPath(canonicalName, hash, bytesExt, v.width)}`,
        content: v.bytes,
      })),
      ...supplementaryFiles.map(f => ({ path: f.abs, content: f.bytes })),
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

  // Persist primary bytes.
  try {
    await input.storage.writeStream(bytesPath, byteStreamFrom(buffer))
  } catch (err) {
    throw new AssetStorageError('write', bytesPath, err)
  }

  // Persist variants. Failures roll back primary bytes + previously
  // written variants so partial uploads don't leak orphans on disk.
  const writtenPaths: string[] = [bytesPath]
  for (const v of generatedVariants) {
    const relPath = assetVariantBytesPath(canonicalName, hash, bytesExt, v.width)
    const absPath = `${input.assetsRoot}/${relPath}`
    try {
      await input.storage.writeStream(absPath, byteStreamFrom(v.bytes))
    } catch (err) {
      await rollback(input.storage, writtenPaths)
      throw new AssetStorageError('write', absPath, err)
    }
    writtenPaths.push(absPath)
  }

  // Persist supplementary files (e.g. animated poster). Same rollback
  // discipline — failures unwind every byte file written so far.
  for (const f of supplementaryFiles) {
    try {
      await input.storage.writeStream(f.abs, byteStreamFrom(f.bytes))
    } catch (err) {
      await rollback(input.storage, writtenPaths)
      throw new AssetStorageError('write', f.abs, err)
    }
    writtenPaths.push(f.abs)
  }

  // Write manifest last — it's the visible "asset exists" record.
  try {
    await writeManifest(input.storage, input.assetsRoot, manifest)
  } catch (err) {
    await rollback(input.storage, writtenPaths)
    throw err
  }

  return { manifest, bytesPath }
}

/**
 * Roll back a partially-committed upload by removing every path we
 * committed before the failure. Best-effort; each `rm` is idempotent
 * (`rmIgnoreMissing`) so a subsequent retry won't be confused by
 * leftovers. Rollback errors are swallowed — the caller's original
 * error is what matters; a rollback failure becomes an orphan byte
 * file that GC will reclaim later.
 *
 * Takes an absolute-path list rather than composing paths itself —
 * caller (who already has the pieces) knows; this helper stays a
 * dumb loop of `rmIgnoreMissing`.
 */
async function rollback(storage: StorageProvider, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rmIgnoreMissing(storage, path)
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Whether to generate responsive variants for this asset. Three rules:
 *
 *   1. Non-image MIMEs don't get variants (no ladder concept)
 *   2. SVG is vector — scales on the browser
 *   3. Animated images can't be ladder-resized correctly without
 *      full transcoding (sharp's resize on a multi-frame source
 *      flattens to the first frame)
 *
 * Pure function — the rules live in one place for testability +
 * single-source-of-truth as new format-specific opt-outs land.
 */
function shouldGenerateVariants(mime: string | null | undefined, animated: boolean | undefined): boolean {
  if (!mime || !mime.startsWith('image/')) return false
  if (mime === 'image/svg+xml') return false
  if (animated === true) return false
  return true
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

/** Collect a byte stream into a single Uint8Array. */
async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      parts.push(value)
      total += value.byteLength
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** Wrap a Uint8Array as a one-shot ReadableStream. */
function byteStreamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
