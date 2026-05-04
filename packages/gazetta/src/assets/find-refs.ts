/**
 * Find every reference to a given asset across a site's pages and
 * fragments (including locale variants).
 *
 * Single responsibility: site-wide orchestration. Loads the site,
 * iterates every manifest, delegates the per-manifest walk to
 * `scan-manifest-for-asset.ts`, concatenates results.
 *
 * Scan-on-demand model (v1 simplification):
 * - The design doc calls for an incremental `.refs/` index written on
 *   every save. That's a separate feature — its writer will import
 *   `scanManifestForAsset` directly (single-manifest granularity) and
 *   update the sidecar files, rather than calling this function.
 * - For v1, delete-check and usage-panel reads use this full scan. O(site
 *   content size) per call, fine up to a few thousand pages.
 */
import type { SiteManifest, StorageProvider } from '../types.js'
import { createContentRoot } from '../content-root.js'
import { allFragmentEntries, allPageEntries, loadSite } from '../site-loader.js'
import { scanManifestForAsset } from './scan-manifest-for-asset.js'
import type { AssetRef } from './refs.js'

export interface FindRefsInput {
  storage: StorageProvider
  /** Path prefix applied to storage operations (content root). */
  siteDir: string
  /** The asset name to find references to. */
  assetName: string
  /**
   * Optional project-level site manifest. Passed through to `loadSite` so
   * scans work in contexts where the target doesn't have its own site config.
   */
  manifest?: SiteManifest
}

/**
 * Find every page or fragment manifest that references `assetName`. One
 * entry per match — a manifest that references the asset twice produces
 * two entries with different `componentPath` values.
 */
export async function findAssetRefs(input: FindRefsInput): Promise<AssetRef[]> {
  const contentRoot = createContentRoot(input.storage, input.siteDir)
  const site = await loadSite({ contentRoot, manifest: input.manifest ?? { name: '(refs-scan)' } })

  const refs: AssetRef[] = []

  for (const { name, page, locale } of allPageEntries(site)) {
    refs.push(
      ...scanManifestForAsset({
        manifest: page,
        manifestPath: localeManifestPath('pages', name, 'page', locale),
        source: 'page',
        assetName: input.assetName,
      }),
    )
  }

  for (const { name, fragment, locale } of allFragmentEntries(site)) {
    refs.push(
      ...scanManifestForAsset({
        manifest: fragment,
        manifestPath: localeManifestPath('fragments', name, 'fragment', locale),
        source: 'fragment',
        assetName: input.assetName,
      }),
    )
  }

  return refs
}

function localeManifestPath(
  root: 'pages' | 'fragments',
  itemName: string,
  baseName: 'page' | 'fragment',
  locale: string | undefined,
): string {
  const file = locale ? `${baseName}.${locale}.json` : `${baseName}.json`
  return `${root}/${itemName}/${file}`
}
