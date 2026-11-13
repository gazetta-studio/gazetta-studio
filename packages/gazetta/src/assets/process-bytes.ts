/**
 * The byte half of an upload: bytes in, everything an asset's default
 * manifest says about those bytes out, with the files to write. No
 * storage I/O. Upload (`ingest.ts`) and in-place replace
 * (`replace-bytes.ts`) both run it, so a file replaced in place is
 * processed exactly as if it had been uploaded.
 */
import type { AssetKind, AssetVariant } from '../schema/types.js'
import { runAnalyzers, type UploadAnalyzer } from './analyze.js'
import { AssetMimeMismatchError, AssetStorageError, AssetVariantGenerationError } from './errors.js'
import { ASSET_HASH_LENGTH, hashBytes } from './hash.js'
import { extractImageDimensions } from './image-metadata.js'
import { assetBytesPath, assetVariantBytesPath } from './manifest.js'
import { sniffMimeFromStream } from './mime-sniff.js'
import { runPreprocessors, type UploadPreprocessor } from './preprocess.js'
import { type UploadPolicy, validateUpload } from './validate.js'
import { generateVariants } from './variants.js'

/**
 * Ext-from-MIME for the upload allowlist. Wide rollout extends this map
 * and the parallel `extFromMime` in `url.ts`.
 */
const EXT_BY_MIME: Record<string, string> = {
  // Images
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  // Audio
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
}

export interface ProcessUploadInput {
  bytes: ReadableStream<Uint8Array>
  /** The name the upload policy checks: the requested name for an upload, the asset's name for a replace. */
  requestedName: string
  /** Canonical asset name the byte filenames are built from. */
  assetName: string
  policy?: UploadPolicy
  preprocessors?: readonly UploadPreprocessor[]
  analyzers?: readonly UploadAnalyzer[]
}

/** One file to write, path relative to the assets root. */
export interface ProcessedFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** The manifest fields that describe the bytes (everything else describes the asset). */
export interface ByteFields {
  mime: string
  size: number
  hash: string
  width: number | null
  height: number | null
  variants: AssetVariant[]
  animated?: boolean
  frames?: number
  duration?: number | null
  poster?: string | null
}

export interface ProcessedUpload {
  /** The kind an upload of these bytes gets. */
  readonly kind: AssetKind
  readonly fields: ByteFields
  /** The primary bytes. */
  readonly primary: ProcessedFile
  /** Variants, then analyzer files such as an animated image's poster. */
  readonly extras: readonly ProcessedFile[]
}

/**
 * Throws `AssetValidationError` subclasses (400) when the bytes fail the
 * upload policy, a preprocessor or variant generation.
 */
export async function processUploadBytes(input: ProcessUploadInput): Promise<ProcessedUpload> {
  const initialBuffer = await collectBytes(input.bytes)
  const { mime, ext } = await sniffMimeFromStream(byteStreamFrom(initialBuffer))

  // Size is checked before preprocessing: the cap protects the request
  // boundary, before any parse of what might be a hostile file.
  validateUpload({ name: input.requestedName, claimedSize: initialBuffer.byteLength, sniffedMime: mime }, input.policy)

  const { bytes: buffer } = await runPreprocessors(initialBuffer, mime, input.preprocessors)

  const bytesExt = ext ?? EXT_BY_MIME[mime ?? ''] ?? ''
  if (!bytesExt) {
    throw new AssetMimeMismatchError(mime, [])
  }

  const hash = hashBytes(buffer)
  if (hash.length !== ASSET_HASH_LENGTH) {
    throw new AssetStorageError('write', input.assetName, new Error('unexpected hash length'))
  }

  // Analyzers skip SVG by design; its dimensions come from the sanitized bytes.
  const analysis =
    (mime ?? '').startsWith('image/') && mime !== 'image/svg+xml'
      ? await runAnalyzers(
          { bytes: buffer, assetName: input.assetName, hash, ext: bytesExt, mime: mime ?? '' },
          input.analyzers,
        )
      : { manifestPatch: undefined, supplementaryFiles: undefined }
  const svgDims = mime === 'image/svg+xml' ? await extractImageDimensions(buffer) : null
  const patch = analysis.manifestPatch

  const variantFiles: ProcessedFile[] = []
  const variants: AssetVariant[] = []
  if (shouldGenerateVariants(mime, patch?.animated)) {
    let generated: Awaited<ReturnType<typeof generateVariants>>
    try {
      generated = await generateVariants(buffer)
    } catch (err) {
      throw new AssetVariantGenerationError(input.assetName, err)
    }
    for (const v of generated) {
      const path = assetVariantBytesPath(input.assetName, hash, bytesExt, v.width)
      variantFiles.push({ path, bytes: v.bytes })
      variants.push({ width: v.width, path, size: v.bytes.byteLength })
    }
  }

  const fields: ByteFields = {
    mime: mime ?? 'application/octet-stream',
    size: buffer.byteLength,
    hash,
    width: patch?.width ?? svgDims?.width ?? null,
    height: patch?.height ?? svgDims?.height ?? null,
    variants,
    // Present only when the analyzer set them, so static assets carry no undefined keys.
    ...(patch?.animated !== undefined ? { animated: patch.animated } : {}),
    ...(patch?.frames !== undefined ? { frames: patch.frames } : {}),
    ...(patch?.duration !== undefined ? { duration: patch.duration } : {}),
    ...(patch?.poster !== undefined ? { poster: patch.poster } : {}),
  }

  return {
    kind: 'embedded',
    fields,
    primary: { path: assetBytesPath(input.assetName, hash, bytesExt), bytes: buffer },
    extras: [...variantFiles, ...(analysis.supplementaryFiles ?? [])],
  }
}

/**
 * Responsive variants only make sense for raster stills: SVG scales in
 * the browser, and resizing a multi-frame image flattens it to one frame.
 */
function shouldGenerateVariants(mime: string | null | undefined, animated: boolean | undefined): boolean {
  if (!mime || !mime.startsWith('image/')) return false
  if (mime === 'image/svg+xml') return false
  if (animated === true) return false
  return true
}

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
export function byteStreamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
