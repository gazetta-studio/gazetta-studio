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
import { AssetMimeMismatchError, AssetStorageError, AssetVariantGenerationError } from './errors.js'
import { ASSET_HASH_LENGTH, hashBytes } from './hash.js'
import { extractImageDimensions } from './image-metadata.js'
import { assetBytesPath, assetVariantBytesPath, manifestPath, writeManifest } from './manifest.js'
import { sniffMimeFromStream } from './mime-sniff.js'
import { type UploadPolicy, validateUpload } from './validate.js'
import { generateVariants, type GeneratedVariant } from './variants.js'

/** Ext-from-MIME for the v1 allowlist (JPEG, PNG). */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
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
  const buffer = await collectBytes(input.bytes)
  const size = buffer.byteLength

  // Sniff MIME. file-type needs a web stream; build one from the buffer.
  const { mime, ext } = await sniffMimeFromStream(byteStreamFrom(buffer))

  // Validate name + size + MIME against the per-target policy. Throws
  // AssetValidationError on the first policy violation.
  validateUpload({ name: input.requestedName, claimedSize: size, sniffedMime: mime }, input.policy)

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

  // Image dimensions: null when the MIME isn't an image sharp can parse.
  // v1 slice is JPEG + PNG only, so sharp can always parse here, but the
  // helper returns null safely if it can't — we propagate that.
  const dims = (mime ?? '').startsWith('image/') ? await extractImageDimensions(buffer) : null

  const canonicalName = baseName(input.requestedName)

  // Generate variants in memory before we touch storage. We need them
  // both for the manifest's `variants` field and (when history is set)
  // for the WrittenItem list passed to the recorder. Variant generation
  // can fail (sharp rejects malformed input); failing here means nothing
  // has been persisted yet so there's no rollback to do.
  const generatedVariants: GeneratedVariant[] = []
  if ((mime ?? '').startsWith('image/')) {
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
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    variants: manifestVariants,
    alt: input.alt,
    uploadedAt: new Date().toISOString(),
    uploadedBy: input.uploadedBy,
  }
  const manifestRelPath = manifestPath(canonicalName)
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`

  // Record history BEFORE any writes. Mirrors the replace.ts pattern:
  // recorder's first-time baseline scan must see pre-op state. Items
  // include the manifest (text), primary bytes (binary), and every
  // variant (binary) — the snapshot covers the full asset.
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
  // The manifest is the only "this asset exists" record; we only write
  // it after every byte file has landed.
  const writtenVariantPaths: string[] = []
  for (const v of generatedVariants) {
    const relPath = assetVariantBytesPath(canonicalName, hash, bytesExt, v.width)
    const absPath = `${input.assetsRoot}/${relPath}`
    try {
      await input.storage.writeStream(absPath, byteStreamFrom(v.bytes))
    } catch (err) {
      await rollback(input.storage, [bytesPath, ...writtenVariantPaths])
      throw new AssetStorageError('write', absPath, err)
    }
    writtenVariantPaths.push(absPath)
  }

  // Write manifest last — it's the visible "asset exists" record.
  try {
    await writeManifest(input.storage, input.assetsRoot, manifest)
  } catch (err) {
    await rollback(input.storage, [bytesPath, ...writtenVariantPaths])
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
