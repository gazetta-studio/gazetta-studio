/**
 * Publish assets — copy referenced assets from a source target's storage
 * to a destination target's storage during publish.
 *
 * This module is the orchestrator: it asks `publish-plan.ts` what to copy
 * (and stops on a structured failure), then performs the actual byte
 * moves. The two concerns split because validation must complete before
 * any bytes are written — so a missing-on-source asset never produces a
 * half-copied target — and the executor wants nothing to do with the
 * walk that produced the asset list.
 *
 * Dedupe is a runtime check on the destination, not a planner output:
 * the planner can't know whether an asset is *already on target* without
 * the same `exists()` call we'd make at copy time, so checking once at
 * the copy site is cheaper.
 */
import { isBinaryCapable, type StorageProvider } from '../types.js'
import { assetPathsInRemovalOrder, assetStoragePaths } from './asset-paths.js'
import { readManifest, writeManifest } from './manifest.js'
import { planAssetCopy } from './publish-plan.js'

export interface PublishAssetsInput {
  readonly sourceStorage: StorageProvider
  readonly targetStorage: StorageProvider
  /** Path prefix for source content (where pages/, fragments/ live). */
  readonly sourceSiteDir: string
  /** Where assets live, relative to storage root (typically `"assets"`). */
  readonly assetsRoot: string
  /** Items being published — e.g., `['pages/home', 'fragments/header']`. */
  readonly itemNames: readonly string[]
}

export type PublishAssetsResult =
  | { readonly ok: true; readonly copiedAssets: number; readonly copiedFiles: number }
  | { readonly ok: false; readonly reason: 'missing-on-source'; readonly missing: readonly string[] }
  | {
      readonly ok: false
      readonly reason: 'target-incapable'
      readonly assets: readonly string[]
      readonly affectedItems: readonly string[]
    }

/**
 * Copy every asset referenced by `itemNames` from source to target.
 *
 * Returns a discriminated-union result. On any failure variant, no
 * writes have happened — validation is complete before any copy starts.
 */
export async function publishAssets(input: PublishAssetsInput): Promise<PublishAssetsResult> {
  const plan = await planAssetCopy(input)
  if (!plan.ok) return plan
  if (plan.assets.length === 0) return { ok: true, copiedAssets: 0, copiedFiles: 0 }

  // Planner returns ok only when both providers are binary-capable.
  // Re-assert for the type checker so `readStream`/`writeStream` are visible.
  if (!isBinaryCapable(input.sourceStorage) || !isBinaryCapable(input.targetStorage)) {
    throw new Error('publishAssets: planner returned ok with non-binary providers')
  }
  const source = input.sourceStorage
  const target = input.targetStorage

  let copiedAssets = 0
  let copiedFiles = 0
  for (const name of plan.assets) {
    const sourceManifest = await readManifest(source, input.assetsRoot, name)
    const paths = assetStoragePaths(input.assetsRoot, sourceManifest)

    // Content-addressed dedupe: the hash is in the bytes path, so its
    // presence on the target proves byte-equivalence. Skip the whole
    // asset (manifest + bytes + variants).
    if (await target.exists(paths.bytes)) continue

    await writeManifest(target, input.assetsRoot, sourceManifest)
    copiedFiles++

    const bytePaths = assetPathsInRemovalOrder(paths).filter(p => p !== paths.manifest)
    for (const path of bytePaths) {
      const stream = await source.readStream(path)
      await target.writeStream(path, stream)
      copiedFiles++
    }
    copiedAssets++
  }
  return { ok: true, copiedAssets, copiedFiles }
}
