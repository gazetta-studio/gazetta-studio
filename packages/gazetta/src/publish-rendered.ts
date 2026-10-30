import type { StorageProvider, PurgeStrategy } from './types.js'
import type { Site } from './site-loader.js'
import { allFragmentEntries, allPageEntries, loadSite } from './site-loader.js'
import { createContentRoot, type ContentRoot } from './content-root.js'
import type { DepRelation, ItemRef } from './dep-sidecars.js'
import { applyDepDiff } from './dep-sidecars.js'
import { mapLimit } from './concurrency.js'
import { stateFolderPath } from './state-folders.js'
import { ASSET_REFS } from './assets/asset-deps.js'
import { FRAGMENT_DEPS } from './fragment-deps.js'

// The old per-item publish functions (publishPageRendered /
// publishPageStatic / publishFragmentRendered) moved to publish-compat.ts
// as thin wrappers over the live pipeline. This file keeps the
// publish-run helpers: site manifest, dependency indices, CDN purge.

/**
 * Publish site manifest (stripped of targets config).
 */
export async function publishSiteManifest(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<void> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, manifest: { name: '(publish)' } }))
  const manifest = { name: site.manifest.name, version: site.manifest.version }
  await targetStorage.writeFile('site.json', JSON.stringify(manifest))
}

/**
 * Rebuild a dep-sidecar index on the destination for one relation.
 *
 * Walks every page + fragment manifest (including locale variants) from
 * the source site and writes per-edge sidecars at
 * `{dest}/.gazetta/{rel.rootName}/{target}/{item}`. Wipes the existing
 * index dir first to avoid stale entries from previous runs.
 *
 * Used by:
 *   - publish flow (CLI + admin route) at end of publish, once per relation
 *   - reindex CLI for source-side recovery
 *   - history-restorer after rollback
 *
 * Why rebuild rather than incremental: a full rebuild is one walk +
 * N zero-byte writes — simpler than tracking diffs against the dest's
 * prior state and equally fast for typical sites.
 */
export async function rebuildDepIndex(
  rel: DepRelation,
  sourceSite: Site,
  destStorage: StorageProvider,
  destRootPath = '',
): Promise<void> {
  const destRoot = createContentRoot(destStorage, destRootPath)

  // Wipe existing index — full rebuild semantics. Stale entries from
  // targets that no longer exist in source manifests get cleared.
  await destStorage.rm(destRoot.path(stateFolderPath(rel.rootName))).catch(() => {
    // Missing dir = nothing to wipe; fine.
  })

  // One write per edge, at most DEFAULT_CONCURRENCY at once.
  const edges: { item: ItemRef; target: string }[] = []
  const none = new Set<string>()
  for (const { name, page, locale } of allPageEntries(sourceSite)) {
    const item: ItemRef = locale ? { source: 'page', name, locale } : { source: 'page', name }
    for (const target of rel.extract(page)) edges.push({ item, target })
  }
  for (const { name, fragment, locale } of allFragmentEntries(sourceSite)) {
    const item: ItemRef = locale ? { source: 'fragment', name, locale } : { source: 'fragment', name }
    for (const target of rel.extract(fragment)) edges.push({ item, target })
  }
  await mapLimit(edges, ({ item, target }) => applyDepDiff(rel, destRoot, item, none, new Set([target])))
}

/**
 * Backwards-compatible alias for the single-relation asset-refs rebuild.
 * Kept until callers (history-restorer, reindex CLI) migrate to the
 * generic `rebuildDepIndex(rel, …)` shape.
 */
export function rebuildAssetRefsIndex(
  sourceSite: Site,
  destStorage: StorageProvider,
  destRootPath = '',
): Promise<void> {
  return rebuildDepIndex(ASSET_REFS, sourceSite, destStorage, destRootPath)
}

/**
 * Publish-flow wrapper: load the site if needed and rebuild every
 * dep-sidecar index on the target. Run once per publish (alongside
 * `publishSiteManifest`). Indices rebuilt:
 *   - asset-refs (queried by delete-block check, library usage panel)
 *   - fragment-deps (queried by `findFragmentDependents` for the
 *     publish-UI blast radius and fragment cache-purge URL lookup)
 */
export async function publishDepIndices(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<void> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, manifest: { name: '(publish)' } }))
  // One relation at a time, so the per-relation write limit holds overall.
  await rebuildDepIndex(ASSET_REFS, site, targetStorage, '')
  await rebuildDepIndex(FRAGMENT_DEPS, site, targetStorage, '')
}

/** Purge via Cloudflare zone cache API */
export function createCloudflarePurge(zoneId: string, apiToken: string): PurgeStrategy {
  const apiBase = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` }

  return {
    async purgeAll() {
      const res = await fetch(apiBase, { method: 'POST', headers, body: JSON.stringify({ purge_everything: true }) })
      if (!res.ok) throw new Error(`Cloudflare purge failed: ${res.status} ${await res.text()}`)
    },
    async purgeUrls(urls: string[]) {
      const res = await fetch(apiBase, { method: 'POST', headers, body: JSON.stringify({ files: urls }) })
      if (!res.ok) throw new Error(`Cloudflare purge failed: ${res.status} ${await res.text()}`)
    },
  }
}

/** Look up Cloudflare zone ID from a site URL */
export async function lookupCloudflareZoneId(siteUrl: string, apiToken: string): Promise<string | null> {
  const domain = new URL(siteUrl).hostname.replace(/^www\./, '')
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${domain}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { result: Array<{ id: string }> }
  return data.result?.[0]?.id ?? null
}
