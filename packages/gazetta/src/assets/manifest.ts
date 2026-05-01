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
import { AssetStorageError } from './errors.js'
import { readDefaultManifest } from './manifest-default.js'

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
 * Read an asset's default manifest. Thin alias for `readDefaultManifest`
 * — kept for callers that haven't migrated yet. New code should prefer
 * `readDefaultManifest` from `manifest-default.ts` directly so the
 * default-vs-locale distinction is explicit at the call site.
 */
export const readManifest = readDefaultManifest

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
