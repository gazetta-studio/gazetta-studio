/**
 * Locale-bytes override ingest — write per-locale (or per-theme) bytes
 * for an existing asset.
 *
 * Author-facing semantics (design-media.md → locale-specific bytes):
 *   "When the active locale is not the default and the author is
 *    uploading a file that matches an existing asset's name, the dialog
 *    asks: Replace default bytes / Add {locale} bytes override / Cancel."
 *
 * The "Add override" branch lands here. Result on disk:
 *   - `{name}.asset.{selector}.json` — locale-bytes manifest with own hash
 *   - `{name}-{hash}.{selector}.{ext}` — primary bytes for this locale
 *   - `{name}-{hash}.{selector}-{w}w.{ext}` — variant ladder for this locale
 *
 * The default manifest at `{name}.asset.json` is unchanged.
 *
 * Single responsibility: validate the override candidate, hash + extract
 * dimensions + generate variants, write the locale manifest + bytes.
 * Does NOT own:
 *   - the route adapter (HTTP layer)
 *   - the "default vs override" decision UX (the route knows whether the
 *     active locale is non-default)
 *   - per-reference content rewrites (locale-bytes don't affect refs)
 *
 * Compatibility rules per design-media.md:
 *   - Same kind as default (image override of image, etc.)
 *   - `animated` flag must match (out of v1 scope: animated detection
 *     deferred — today both default and override are static images)
 *   - MIME may differ within the kind category (jpeg default + webp
 *     override is allowed; image → video is not)
 *   - Dimensions may differ (warning at upload time is a UX concern)
 *
 * History recording mirrors `ingest.ts`: one revision per upload,
 * recorded BEFORE any writes so the recorder's first-time baseline
 * captures pre-op state.
 */
import type { ContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import type { AssetManifest, AssetVariant, LocaleBytesOverrideManifest } from '../schema/types.js'
import type { Selector } from '../schema/dimensions.js'
import { selectorSuffix } from '../schema/dimensions.js'
import type { StorageProvider } from '../types.js'
import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import {
  AssetKindMismatchError,
  AssetMimeMismatchError,
  AssetStorageError,
  AssetVariantGenerationError,
} from './errors.js'
import { ASSET_HASH_LENGTH, hashBytes } from './hash.js'
import { extractImageDimensions } from './image-metadata.js'
import { mimeCategory } from './kind-compat.js'
import { assetBytesPath, assetVariantBytesPath, readManifest, writeLocaleManifest } from './manifest.js'
import { sniffMimeFromStream } from './mime-sniff.js'
import { type UploadPolicy, validateUpload } from './validate.js'
import { generateVariants, type GeneratedVariant } from './variants.js'

/** Ext-from-MIME for the v1 allowlist (JPEG, PNG). */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

export interface IngestLocaleBytesInput {
  /** Storage provider. */
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
  /** Existing asset's name. The default manifest must already exist. */
  assetName: string
  /**
   * Selector for the override (locale + optional theme). Must be
   * non-null — caller decides which dimension(s) to write. The default
   * asset's bytes correspond to selector === null and are untouched.
   */
  selector: Selector
  /** The incoming byte stream for the override bytes. */
  bytes: ReadableStream<Uint8Array>
  /** Per-target upload policy (size cap). */
  policy?: UploadPolicy
  /** Optional history. When set, one revision is recorded for this upload. */
  history?: HistoryProvider
  /** Required when `history` is set. */
  contentRoot?: ContentRoot
  /** Author identifier. */
  author?: string
}

export interface IngestLocaleBytesResult {
  /** The new locale-bytes manifest as written. */
  manifest: LocaleBytesOverrideManifest
  /** Path to the override's primary bytes (for caller logging). */
  bytesPath: string
}

/**
 * Ingest a locale-bytes override for an existing asset. Throws:
 *   - `AssetManifestNotFoundError` — default manifest doesn't exist
 *   - `AssetValidationError` (subclass) — name/size/MIME failed policy
 *   - `AssetKindMismatchError` — MIME category differs from default
 *     (image override of pdf is rejected, jpeg override of png is fine)
 *   - `AssetVariantGenerationError` — sharp couldn't process the bytes
 *   - `AssetStorageError` — underlying storage failed
 */
export async function ingestLocaleBytes(input: IngestLocaleBytesInput): Promise<IngestLocaleBytesResult> {
  // Step 1 — read the default manifest. Throws AssetManifestNotFoundError
  // when the asset doesn't exist; you can't override bytes for an asset
  // that isn't there.
  const defaultManifest = await readManifest(input.storage, input.assetsRoot, input.assetName)

  // Step 2 — collect bytes once.
  const buffer = await collectBytes(input.bytes)
  const size = buffer.byteLength

  // Step 3 — sniff MIME and validate.
  const { mime, ext } = await sniffMimeFromStream(byteStreamFrom(buffer))
  validateUpload({ name: input.assetName, claimedSize: size, sniffedMime: mime }, input.policy)

  const bytesExt = ext ?? EXT_BY_MIME[mime ?? ''] ?? ''
  if (!bytesExt) {
    throw new AssetMimeMismatchError(mime, [])
  }

  // Step 4 — kind/MIME-category compatibility with default. Per design,
  // jpeg → webp is allowed (same `image` category); image → pdf is not.
  // We don't compare `kind` directly because the override doesn't carry
  // its own kind — it inherits from the default.
  const overrideMime = mime ?? 'application/octet-stream'
  const defaultCategory = mimeCategory(defaultManifest.mime)
  const overrideCategory = mimeCategory(overrideMime)
  if (defaultCategory !== overrideCategory) {
    throw new AssetKindMismatchError(defaultManifest.kind, defaultCategory, defaultManifest.kind, overrideCategory)
  }

  const hash = hashBytes(buffer)
  if (hash.length !== ASSET_HASH_LENGTH) {
    throw new AssetStorageError('write', input.assetName, new Error('unexpected hash length'))
  }

  // Step 5 — image dimensions (per-locale: override may differ from default).
  const dims = overrideMime.startsWith('image/') ? await extractImageDimensions(buffer) : null

  // Step 6 — generate variants in memory.
  const generatedVariants: GeneratedVariant[] = []
  if (overrideMime.startsWith('image/')) {
    try {
      const generated = await generateVariants(buffer)
      generatedVariants.push(...generated)
    } catch (err) {
      throw new AssetVariantGenerationError(input.assetName, err)
    }
  }

  // Step 7 — compose paths + manifest in memory.
  const variantManifestEntries: AssetVariant[] = generatedVariants.map(v => ({
    width: v.width,
    path: assetVariantBytesPath(input.assetName, hash, bytesExt, v.width, input.selector),
    size: v.bytes.byteLength,
  }))
  const bytesRel = assetBytesPath(input.assetName, hash, bytesExt, input.selector)
  const bytesAbs = `${input.assetsRoot}/${bytesRel}`
  const localeManifest: LocaleBytesOverrideManifest = {
    version: 1,
    name: input.assetName,
    hash,
    size,
    mime: overrideMime,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    variants: variantManifestEntries,
  }
  const localeManifestPath = `${input.assetsRoot}/${input.assetName}.asset${selectorSuffix(input.selector)}.json`

  // Step 8 — record history BEFORE any writes. Mirrors ingest.ts /
  // replace.ts pattern.
  if (input.history) {
    if (!input.contentRoot) {
      throw new Error('ingestLocaleBytes: history requires contentRoot')
    }
    const items: WrittenItem[] = [
      { path: localeManifestPath, content: `${JSON.stringify(localeManifest, null, 2)}\n` },
      { path: bytesAbs, content: buffer },
      ...generatedVariants.map(v => ({
        path: `${input.assetsRoot}/${assetVariantBytesPath(input.assetName, hash, bytesExt, v.width, input.selector)}`,
        content: v.bytes,
      })),
    ]
    await recordWrite({
      history: input.history,
      contentRoot: input.contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Upload ${input.assetName} override (${selectorSuffix(input.selector).slice(1)})`,
    })
  }

  // Step 9 — write primary bytes.
  try {
    await input.storage.writeStream(bytesAbs, byteStreamFrom(buffer))
  } catch (err) {
    throw new AssetStorageError('write', bytesAbs, err)
  }

  // Step 10 — write variants with rollback on failure.
  const writtenVariantPaths: string[] = []
  for (const v of generatedVariants) {
    const variantAbs = `${input.assetsRoot}/${assetVariantBytesPath(input.assetName, hash, bytesExt, v.width, input.selector)}`
    try {
      await input.storage.writeStream(variantAbs, byteStreamFrom(v.bytes))
    } catch (err) {
      await rollback(input.storage, [bytesAbs, ...writtenVariantPaths])
      throw new AssetStorageError('write', variantAbs, err)
    }
    writtenVariantPaths.push(variantAbs)
  }

  // Step 11 — write the locale manifest last (the visible "this
  // override exists" record).
  try {
    await writeLocaleManifest(input.storage, input.assetsRoot, input.assetName, input.selector, localeManifest)
  } catch (err) {
    await rollback(input.storage, [bytesAbs, ...writtenVariantPaths])
    throw err
  }

  return { manifest: localeManifest, bytesPath: bytesAbs }
}

async function rollback(storage: StorageProvider, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rmIgnoreMissing(storage, path)
    } catch {
      /* best-effort */
    }
  }
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

function byteStreamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
