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
import { mapLimit } from '../concurrency.js'
import type { ContentRoot } from '../content-root.js'
import type { StorageProvider } from '../types.js'
import { assetBytePaths, assetStoragePaths } from './asset-paths.js'
import { readManifest, writeManifest } from './manifest.js'
import { planAssetCopy } from './publish-plan.js'

export interface PublishAssetsInput {
  /** Source content root (assets live at `sourceRoot.path('assets')`). */
  readonly sourceRoot: ContentRoot
  /** Target content root (assets land at `targetRoot.path('assets')`). */
  readonly targetRoot: ContentRoot
  /** Items being published — e.g., `['pages/home', 'fragments/header']`. */
  readonly itemNames: readonly string[]
}

export type PublishAssetsResult =
  | { readonly ok: true; readonly copiedAssets: number; readonly copiedFiles: number }
  | { readonly ok: false; readonly reason: 'missing-on-source'; readonly missing: readonly string[] }

/**
 * Copy every asset referenced by `itemNames` from source to target.
 *
 * Returns a discriminated-union result. On the failure variant, no
 * writes have happened — validation is complete before any copy starts.
 *
 * Asset copies run in bounded parallel — assets are independent (no
 * cross-asset shared state) and each one's stream-bridge spends most of
 * its time waiting on cloud I/O. Sequential copy serializes those waits;
 * parallel copy lets them overlap. Concurrency is bounded by `mapLimit`'s
 * default to avoid running out of file handles or saturating the SDK's
 * connection pool.
 */
export async function publishAssets(input: PublishAssetsInput): Promise<PublishAssetsResult> {
  const plan = await planAssetCopy(input)
  if (!plan.ok) return plan
  if (plan.assets.length === 0) return { ok: true, copiedAssets: 0, copiedFiles: 0 }

  const ctx: CopyContext = {
    source: input.sourceRoot.storage,
    target: input.targetRoot.storage,
    sourceAssets: input.sourceRoot.path('assets'),
    targetAssets: input.targetRoot.path('assets'),
  }

  const perAsset = await mapLimit(plan.assets, name => copyOneAsset(ctx, name))
  let copiedAssets = 0
  let copiedFiles = 0
  for (const r of perAsset) {
    if (r.copied) copiedAssets++
    copiedFiles += r.files
  }
  return { ok: true, copiedAssets, copiedFiles }
}

interface CopyContext {
  readonly source: StorageProvider
  readonly target: StorageProvider
  readonly sourceAssets: string
  readonly targetAssets: string
}

interface CopyResult {
  /** True when the asset's bytes were written. False on dedupe-skip. */
  readonly copied: boolean
  /** Files written for this asset (manifest + primary + variants). 0 on skip. */
  readonly files: number
}

async function copyOneAsset(ctx: CopyContext, name: string): Promise<CopyResult> {
  const sourceManifest = await readManifest(ctx.source, ctx.sourceAssets, name)
  const sourcePaths = assetStoragePaths(ctx.sourceAssets, sourceManifest)
  const targetPaths = assetStoragePaths(ctx.targetAssets, sourceManifest)

  // Content-addressed dedupe: the hash is in the bytes path, so its
  // presence on the target proves byte-equivalence. Skip the whole
  // asset (manifest + bytes + variants).
  if (await ctx.target.exists(targetPaths.defaultBytes)) return { copied: false, files: 0 }

  await writeManifest(ctx.target, ctx.targetAssets, sourceManifest)
  let files = 1

  // Copy every byte path (default + per-override) preserving structure.
  // `assetBytePaths` returns default bytes/variants first, then each
  // override's bytes/variants — both source and target produce the same
  // ordered list because they're built from the same manifest, so we
  // can iterate in lockstep.
  const sourceBytePaths = assetBytePaths(sourcePaths)
  const targetBytePaths = assetBytePaths(targetPaths)
  for (let i = 0; i < sourceBytePaths.length; i++) {
    const stream = await ctx.source.readStream(sourceBytePaths[i]!)
    await ctx.target.writeStream(targetBytePaths[i]!, stream)
    files++
  }
  return { copied: true, files }
}
