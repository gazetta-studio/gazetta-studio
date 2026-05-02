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
import type { AssetManifest, AssetSummary } from '../schema/types.js'
import { AssetStorageError } from './errors.js'
import { parseManifestFilename } from './manifest-filename.js'
import { readManifest } from './manifest.js'

export type { AssetSummary }

/**
 * Project a full manifest to its library-list summary shape. Override
 * locale/theme lists are passed in by the caller — `toSummary` is pure
 * and doesn't do I/O. Single-asset GET passes empty arrays + an
 * optional override-discovery pass; the bulk list passes pre-bucketed
 * results from the directory scan.
 */
export function toSummary(
  manifest: AssetManifest,
  overrideLocales: readonly string[] = [],
  overrideThemes: readonly string[] = [],
): AssetSummary {
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
    overrideLocales: [...overrideLocales].sort(),
    overrideThemes: [...overrideThemes].sort(),
  }
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
 *
 * Override-locale/theme detection happens in the same directory scan —
 * no extra I/O. We bucket every `*.asset.json` file by its asset name;
 * default manifests get loaded into summaries, and locale/theme variant
 * filenames contribute to the parent asset's `overrideLocales` /
 * `overrideThemes` lists.
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

  // Bucket entries by asset name in one pass: identify the default
  // manifest filenames and collect each asset's locale/theme variants
  // alongside. The variants are detected via parseManifestFilename —
  // same parser used by enumerateAssetStoragePaths, so the two paths
  // can't drift on what counts as a valid override filename.
  const defaultNames: string[] = []
  const overridesByAsset = new Map<string, { locales: string[]; themes: string[] }>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const parsed = parseManifestFilename(entry.name)
    if (!parsed) continue
    if (parsed.selector === null) {
      defaultNames.push(parsed.assetName)
      continue
    }
    const bucket = overridesByAsset.get(parsed.assetName) ?? { locales: [], themes: [] }
    const locale = parsed.selector.get('locale')
    const theme = parsed.selector.get('theme')
    if (locale !== undefined && !bucket.locales.includes(locale)) bucket.locales.push(locale)
    if (theme !== undefined && !bucket.themes.includes(theme)) bucket.themes.push(theme)
    overridesByAsset.set(parsed.assetName, bucket)
  }

  const summaries: AssetSummary[] = []
  for (const assetName of defaultNames) {
    try {
      const manifest = await readManifest(input.storage, input.assetsRoot, assetName)
      const overrides = overridesByAsset.get(assetName) ?? { locales: [], themes: [] }
      summaries.push(toSummary(manifest, overrides.locales, overrides.themes))
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

function isDirectoryMissing(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  return msg.includes('Directory not found') || msg.includes('ENOENT')
}
