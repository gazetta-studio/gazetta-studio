/**
 * Asset manifest I/O — reading and writing `{name}.asset.json` via a
 * `StorageProvider`. Pure delegation to the storage layer plus JSON
 * (de)serialization; no validation of the manifest itself (that's the
 * writer's job at creation time) and no dependency on the upload pipeline.
 *
 * Separation from the type:
 * - `schema/types.ts` owns the `AssetManifest` type (data shape)
 * - this file owns the I/O primitives (behavior)
 *
 * Separation from `ingest.ts`:
 * - ingest composes hash + manifest + storage during upload
 * - this module is used by ingest, the resolver, the library-list endpoint,
 *   and future delete/rename operations. It sits below all of them.
 */
import type { StorageProvider } from '../types.js'
import type { AssetManifest } from '../schema/types.js'
import { type Selector, selectorSuffix } from '../schema/dimensions.js'
import { AssetManifestCorruptError, AssetManifestNotFoundError, AssetStorageError } from './errors.js'

/**
 * Where asset manifests live, relative to an `assets/` root.
 *
 * Default manifest:    `{name}.asset.json`
 * Locale variant:       `{name}.asset.{locale}.json`
 * Theme variant:        `{name}.asset.{theme}.json`
 * Locale + theme:       `{name}.asset.{locale}.{theme}.json`
 *
 * Selector ordering follows `DIMENSION_ORDER` from `schema/dimensions.ts`.
 * Pass `null` (or omit) for the default manifest.
 */
export function manifestPath(assetName: string, selector?: Selector | null): string {
  return `${assetName}.asset${selectorSuffix(selector ?? null)}.json`
}

/**
 * Where internal asset bytes live, given a name + 8-char hash + extension.
 *
 * Default bytes:        `{name}-{hash}.{ext}`
 * Locale bytes:          `{name}-{hash}.{locale}.{ext}`
 * Locale + theme bytes:  `{name}-{hash}.{locale}.{theme}.{ext}`
 *
 * The hash always describes the bytes at THIS path — locale-bytes overrides
 * have their own hash, distinct from the default's hash.
 */
export function assetBytesPath(assetName: string, hash: string, ext: string, selector?: Selector | null): string {
  const extPart = ext.startsWith('.') ? ext : `.${ext}`
  return `${assetName}-${hash}${selectorSuffix(selector ?? null)}${extPart}`
}

/**
 * Where a variant's bytes live, given name + hash + ext + target width
 * (and optional selector for locale/theme variants).
 *
 * Default variant:        `{name}-{hash}-{width}w.{ext}`
 * Locale variant:          `{name}-{hash}.{locale}-{width}w.{ext}`
 * Locale + theme variant:  `{name}-{hash}.{locale}.{theme}-{width}w.{ext}`
 *
 * Width suffix comes AFTER the selector suffix — the selector segments are
 * part of the file's identity (which override is this), the width is part
 * of the variant ladder for THAT identity. Owned here so the write side
 * (ingest) and read side (asset-paths, URL construction) can't drift —
 * change the scheme in one place.
 */
export function assetVariantBytesPath(
  assetName: string,
  hash: string,
  ext: string,
  width: number,
  selector?: Selector | null,
): string {
  const extPart = ext.startsWith('.') ? ext : `.${ext}`
  return `${assetName}-${hash}${selectorSuffix(selector ?? null)}-${width}w${extPart}`
}

/**
 * Read an asset manifest from storage. Throws:
 * - `AssetManifestNotFoundError` when the manifest file doesn't exist
 * - `AssetManifestCorruptError` when it exists but isn't valid JSON / shape
 * - `AssetStorageError` on any other storage failure
 */
export async function readManifest(
  storage: StorageProvider,
  assetsRoot: string,
  assetName: string,
): Promise<AssetManifest> {
  const path = `${assetsRoot}/${manifestPath(assetName)}`

  const exists = await storage.exists(path).catch(err => {
    throw new AssetStorageError('stat', path, err)
  })
  if (!exists) throw new AssetManifestNotFoundError(assetName)

  let raw: string
  try {
    raw = await storage.readFile(path)
  } catch (err) {
    throw new AssetStorageError('read', path, err)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new AssetManifestCorruptError(path, err)
  }

  if (!isAssetManifest(parsed)) {
    throw new AssetManifestCorruptError(path, new Error('manifest shape mismatch'))
  }

  return parsed
}

/**
 * Write an asset manifest to storage. The storage provider's `writeFile` is
 * already atomic (see providers/_atomic-write.ts) — this function adds no
 * atomicity of its own, just serialization.
 */
export async function writeManifest(
  storage: StorageProvider,
  assetsRoot: string,
  manifest: AssetManifest,
): Promise<void> {
  const path = `${assetsRoot}/${manifestPath(manifest.name)}`
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  try {
    await storage.writeFile(path, serialized)
  } catch (err) {
    throw new AssetStorageError('write', path, err)
  }
}

/** Narrow a parsed-JSON value to `AssetManifest`. Shape-only; doesn't re-validate. */
function isAssetManifest(candidate: unknown): candidate is AssetManifest {
  if (!candidate || typeof candidate !== 'object') return false
  const m = candidate as Record<string, unknown>
  return (
    m.version === 1 &&
    typeof m.name === 'string' &&
    (m.kind === 'embedded' || m.kind === 'downloadable' || m.kind === 'font') &&
    m.source === 'internal' &&
    typeof m.mime === 'string' &&
    typeof m.size === 'number' &&
    typeof m.hash === 'string' &&
    (m.width === null || typeof m.width === 'number') &&
    (m.height === null || typeof m.height === 'number') &&
    Array.isArray(m.variants) &&
    m.variants.every(isAssetVariant) &&
    (m.alt === null || typeof m.alt === 'string') &&
    typeof m.uploadedAt === 'string' &&
    typeof m.uploadedBy === 'string'
  )
}

function isAssetVariant(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false
  const v = candidate as Record<string, unknown>
  return typeof v.width === 'number' && typeof v.path === 'string' && typeof v.size === 'number'
}
