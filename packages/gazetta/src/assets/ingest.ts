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
 * Gate on capability: the target storage provider must implement
 * `BinaryStorage`. The pipeline throws `AssetProviderNotCapableError` when
 * it doesn't — the HTTP route turns that into a 501.
 */
import type { AssetManifest, AssetVariant } from '../schema/types.js'
import { isBinaryCapable, type StorageProvider } from '../types.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import {
  AssetMimeMismatchError,
  AssetProviderNotCapableError,
  AssetStorageError,
  AssetVariantGenerationError,
} from './errors.js'
import { ASSET_HASH_LENGTH, hashBytes } from './hash.js'
import { extractImageDimensions } from './image-metadata.js'
import { assetBytesPath, assetVariantBytesPath, writeManifest } from './manifest.js'
import { sniffMimeFromStream } from './mime-sniff.js'
import { validateUpload } from './validate.js'
import { generateVariants } from './variants.js'

/** Ext-from-MIME for the v1 allowlist (JPEG, PNG). */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

export interface IngestInput {
  /** The target's storage provider. Must implement `BinaryStorage`. */
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
 * - `AssetProviderNotCapableError` — storage doesn't support binary streaming
 * - `AssetValidationError` — name, size, or MIME failed policy
 * - `AssetStorageError` — storage write failed
 */
export async function ingestAsset(input: IngestInput): Promise<IngestResult> {
  if (!isBinaryCapable(input.storage)) {
    throw new AssetProviderNotCapableError('target does not support writing binary assets')
  }

  // Collect bytes once so we can sniff, hash, measure, and persist from the
  // same buffer without re-consuming the source stream.
  const buffer = await collectBytes(input.bytes)
  const size = buffer.byteLength

  // Sniff MIME. file-type needs a web stream; build one from the buffer.
  const { mime, ext } = await sniffMimeFromStream(byteStreamFrom(buffer))

  // Validate name + size + MIME. Throws AssetValidationError on the first
  // policy violation.
  validateUpload({ name: input.requestedName, claimedSize: size, sniffedMime: mime })

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

  // Persist primary bytes.
  const bytesPath = `${input.assetsRoot}/${assetBytesPath(canonicalName, hash, bytesExt)}`
  try {
    await input.storage.writeStream(bytesPath, byteStreamFrom(buffer))
  } catch (err) {
    throw new AssetStorageError('write', bytesPath, err)
  }

  // Generate + persist responsive variants. Failures here roll back
  // everything we've written so the upload fails atomically — the
  // manifest is the one visible "this asset exists" record and we
  // only write it when primary bytes + variants are all on disk.
  //
  // v1: images only (JPEG + PNG, per the allowlist above). Non-images
  // yield no variants; the generator returns [] and we move on.
  const writtenVariants: AssetVariant[] = []
  if ((mime ?? '').startsWith('image/')) {
    try {
      const generated = await generateVariants(buffer)
      for (const v of generated) {
        const relPath = assetVariantBytesPath(canonicalName, hash, bytesExt, v.width)
        const absPath = `${input.assetsRoot}/${relPath}`
        try {
          await input.storage.writeStream(absPath, byteStreamFrom(v.bytes))
        } catch (err) {
          await rollback(input.storage, writtenPathsSoFar(bytesPath, writtenVariants, input.assetsRoot))
          throw new AssetStorageError('write', absPath, err)
        }
        writtenVariants.push({ width: v.width, path: relPath, size: v.bytes.byteLength })
      }
    } catch (err) {
      // Variant generation itself failed (sharp rejected the input).
      // Roll back primary bytes so no orphan survives. AssetStorageError
      // from the inner loop has already rolled back and we re-throw;
      // any other error here is from generateVariants.
      if (err instanceof AssetStorageError) throw err
      await rollback(input.storage, writtenPathsSoFar(bytesPath, writtenVariants, input.assetsRoot))
      throw new AssetVariantGenerationError(canonicalName, err)
    }
  }

  // Build + write manifest.
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
    variants: writtenVariants,
    alt: input.alt,
    uploadedAt: new Date().toISOString(),
    uploadedBy: input.uploadedBy,
  }
  await writeManifest(input.storage, input.assetsRoot, manifest)

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
 * Collect every absolute path that's been written so far in the ingest
 * pipeline — primary bytes + any variants that landed before the
 * failure. Pulled out to keep the rollback call sites readable and
 * to centralize the `{assetsRoot}/{variant.path}` path composition
 * that two call sites would otherwise duplicate.
 */
function writtenPathsSoFar(primaryBytesPath: string, variants: readonly AssetVariant[], assetsRoot: string): string[] {
  return [primaryBytesPath, ...variants.map(v => `${assetsRoot}/${v.path}`)]
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
