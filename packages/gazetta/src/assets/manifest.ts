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
import { AssetManifestCorruptError, AssetManifestNotFoundError, AssetStorageError } from './errors.js'

/** Where asset manifests live, relative to an `assets/` root. */
export function manifestPath(assetName: string): string {
  return `${assetName}.asset.json`
}

/** Where internal asset bytes live, given a name + 8-char hash + extension. */
export function assetBytesPath(assetName: string, hash: string, ext: string): string {
  const extPart = ext.startsWith('.') ? ext : `.${ext}`
  return `${assetName}-${hash}${extPart}`
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
    (m.alt === null || typeof m.alt === 'string') &&
    typeof m.uploadedAt === 'string' &&
    typeof m.uploadedBy === 'string'
  )
}
