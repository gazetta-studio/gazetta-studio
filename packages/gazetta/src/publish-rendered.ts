import type { StorageProvider, PurgeStrategy } from './types.js'
import type { Site } from './site-loader.js'
import { allFragmentEntries, allPageEntries, loadSite } from './site-loader.js'
import { createContentRoot, type ContentRoot } from './content-root.js'
import type { DepRelation } from './dep-sidecars.js'
import { rebuildItemDeps } from './dep-sidecars.js'
import { stateFolderPath } from './state-folders.js'
import { DEP_RELATIONS } from './dep-relations.js'

// The old per-item publish functions (publishPageRendered /
// publishPageStatic / publishFragmentRendered) moved to publish-compat.ts
// as thin wrappers over the live pipeline. This file keeps the
// publish-run helpers: site manifest, whole-index rebuilds, CDN purge.

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
 * Rebuild one relation's dep-sidecar index from a site's manifests.
 *
 * Walks every page + fragment manifest (including locale variants) and
 * writes per-edge sidecars at `{dest}/.gazetta/{rel.rootName}/{target}/{item}`
 * plus each item's forward record at `.gazetta/deps-of/{rel.rootName}/{item}`.
 * Wipes both first so the index describes exactly this site.
 *
 * For whole-index rebuilds of a store from its own manifests (history
 * restore, the source's first rebuild, `gazetta assets reindex`). A
 * publish never calls this: it replaces the edges of each item it
 * writes (`replaceItemDeps`), so a target's index describes the target.
 */
export async function rebuildDepIndex(
  rel: DepRelation,
  sourceSite: Site,
  destStorage: StorageProvider,
  destRootPath = '',
): Promise<void> {
  const destRoot = createContentRoot(destStorage, destRootPath)

  await wipeRelation(rel, destRoot)

  const writes: Promise<void>[] = []
  for (const { name, page, locale } of allPageEntries(sourceSite)) {
    const item = locale ? { source: 'page' as const, name, locale } : { source: 'page' as const, name }
    writes.push(rebuildItemDeps(rel, destRoot, item, null, page))
  }
  for (const { name, fragment, locale } of allFragmentEntries(sourceSite)) {
    const item = locale ? { source: 'fragment' as const, name, locale } : { source: 'fragment' as const, name }
    writes.push(rebuildItemDeps(rel, destRoot, item, null, fragment))
  }
  await Promise.all(writes)
}

async function wipeRelation(rel: DepRelation, root: ContentRoot): Promise<void> {
  await Promise.all(
    [stateFolderPath(rel.rootName), stateFolderPath('deps-of', rel.rootName)].map(dir =>
      root.storage.rm(root.path(dir)).catch(() => {
        // Missing dir = nothing to wipe.
      }),
    ),
  )
}

/** Rebuild every relation's index (see `rebuildDepIndex`). */
export async function rebuildAllDepIndices(site: Site, destStorage: StorageProvider, destRootPath = ''): Promise<void> {
  await Promise.all(DEP_RELATIONS.map(rel => rebuildDepIndex(rel, site, destStorage, destRootPath)))
}

/**
 * Delete every relation's index and forward records. A forced publish
 * runs this before its item loop, so the per-item path rebuilds the
 * index from what that publish writes.
 */
export async function wipeDepIndices(storage: StorageProvider, rootPath = ''): Promise<void> {
  const root = createContentRoot(storage, rootPath)
  const dirs = [...DEP_RELATIONS.map(rel => stateFolderPath(rel.rootName)), stateFolderPath('deps-of')]
  await Promise.all(
    dirs.map(dir =>
      storage.rm(root.path(dir)).catch(() => {
        // Missing dir = nothing to wipe.
      }),
    ),
  )
}

/**
 * Rebuild every relation's index on a store from a site's manifests.
 * Not part of publish (each published item replaces its own edges);
 * kept for callers that rebuild a whole store from its own site.
 */
export async function publishDepIndices(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<void> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, manifest: { name: '(publish)' } }))
  await rebuildAllDepIndices(site, targetStorage, '')
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
