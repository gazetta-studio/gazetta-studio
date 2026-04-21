/**
 * List operation — enumerate assets on a target.
 *
 * Reads every `*.asset.json` manifest in the `assets/` directory and returns
 * a summary of each. Summary shape is the minimum the library UI needs —
 * full manifests are fetched on-demand by the detail pane.
 *
 * Separate from `manifest.ts` because:
 * - manifest.ts owns read/write of a single manifest
 * - list.ts owns enumeration (which is directory-scan, corrupt-manifest
 *   handling, and summary projection — not shared with single-manifest I/O)
 *
 * Corrupt-manifest resilience: one bad manifest doesn't break the whole
 * listing. Corrupt entries are logged and omitted. The UI showing an
 * "assets: 42" badge shouldn't fail because one JSON file has a stray
 * comma — that's a bug-in-authoring, not a bug in the CMS.
 */
import type { StorageProvider } from '../types.js'
import type { AssetManifest } from '../schema/types.js'
import { AssetStorageError } from './errors.js'
import { readManifest } from './manifest.js'

/** Compact per-asset summary for library listings. */
export interface AssetSummary {
  name: string
  kind: AssetManifest['kind']
  mime: string
  size: number
  hash: string
  width: number | null
  height: number | null
  alt: string | null
  uploadedAt: string
}

export interface ListAssetsInput {
  storage: StorageProvider
  /** Path prefix for assets (typically `"assets"`). */
  assetsRoot: string
}

/**
 * List every asset on the target. Returns an empty array when the `assets/`
 * directory doesn't exist — this is valid for a target that's never received
 * any assets (same "empty is fine" policy as pages/fragments).
 */
export async function listAssets(input: ListAssetsInput): Promise<AssetSummary[]> {
  let entries: Array<{ name: string; isDirectory: boolean }>
  try {
    entries = await input.storage.readDir(input.assetsRoot)
  } catch (err) {
    // Missing directory — valid state (no assets yet). Any other error is real.
    if (isDirectoryMissing(err)) return []
    throw new AssetStorageError('read', input.assetsRoot, err)
  }

  const summaries: AssetSummary[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!entry.name.endsWith('.asset.json')) continue

    // Asset name is the filename minus the `.asset.json` suffix.
    const assetName = entry.name.slice(0, -'.asset.json'.length)
    try {
      const manifest = await readManifest(input.storage, input.assetsRoot, assetName)
      summaries.push(toSummary(manifest))
    } catch (err) {
      // Don't fail the whole listing on one corrupt/missing manifest.
      // eslint-disable-next-line no-console
      console.warn(`[assets-list] Skipping ${assetName}: ${(err as Error).message}`)
    }
  }

  // Most-recent first — default sort for the library's "recently uploaded" view.
  summaries.sort((a, b) => (a.uploadedAt > b.uploadedAt ? -1 : 1))
  return summaries
}

function toSummary(manifest: AssetManifest): AssetSummary {
  return {
    name: manifest.name,
    kind: manifest.kind,
    mime: manifest.mime,
    size: manifest.size,
    hash: manifest.hash,
    width: manifest.width,
    height: manifest.height,
    alt: manifest.alt,
    uploadedAt: manifest.uploadedAt,
  }
}

function isDirectoryMissing(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  return msg.includes('Directory not found') || msg.includes('ENOENT')
}
