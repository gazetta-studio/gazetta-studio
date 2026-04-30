import { createHash } from 'node:crypto'
import type { StorageProvider, PurgeStrategy, CacheConfig } from './types.js'
import type { Site } from './site-loader.js'
import { allFragmentEntries, allPageEntries, loadSite } from './site-loader.js'
import { resolvePage, resolveComponent, resolveFragment } from './resolver.js'
import { renderComponent, renderPage } from './renderer.js'
import { writeSidecars, collectFragmentRefs } from './sidecars.js'
import { createContentRoot, type ContentRoot } from './content-root.js'
import { resolveSeoTags, escapeAttr } from './seo.js'
import { ASSET_REFS_ROOT, rebuildItemRefs } from './assets/refs-sidecars.js'

function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 8)
}

/** List existing hashed files (styles.*.css, script.*.js) in a directory */
async function listHashedFiles(storage: StorageProvider, dir: string): Promise<string[]> {
  try {
    const entries = await storage.readDir(dir)
    return entries
      .filter(e => !e.isDirectory && /\.(css|js)$/.test(e.name) && /\.[a-f0-9]{8}\./.test(e.name))
      .map(e => `${dir}/${e.name}`)
  } catch {
    return []
  }
}

/** Delete files that existed before but weren't written this time */
async function cleanupOldFiles(storage: StorageProvider, oldFiles: string[], newFiles: string[]): Promise<number> {
  const newSet = new Set(newFiles)
  let removed = 0
  for (const file of oldFiles) {
    if (!newSet.has(file)) {
      try {
        await storage.rm(file)
        removed++
      } catch {
        /* already gone */
      }
    }
  }
  return removed
}

/**
 * Publish a page as HTML with ESI placeholders for fragments.
 * Local components are baked in. Fragment markup is replaced at request time by the worker.
 * CSS is stored as separate hashed files for immutable caching.
 */
export async function publishPageRendered(
  pageName: string,
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  targetCache?: CacheConfig,
  templatesDir?: string,
  manifestHash?: string,
  preloadedSite?: Site,
  /** SEO context for the fallback chain — caller builds from manifest + target config. */
  seo?: import('./seo.js').SeoContext,
  /** Locale for this render pass. When set, resolves locale-specific fragments. */
  locale?: string,
): Promise<{ files: number; removed: number }> {
  // Reuse a preloaded site when the caller already has one (runPublish loops
  // over N items; loading per-item was quadratic). loadSite is idempotent.
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, templatesDir }))
  const page = site.pages.get(pageName)
  if (!page) throw new Error(`Page "${pageName}" not found`)

  // Scope IDs are now deterministic (hash-based), no reset needed
  const resolved = await resolvePage(pageName, site, locale)

  // Render each child — fragments become ESI placeholders, local components baked in
  const bodyParts: string[] = []
  const localCssParts: string[] = []
  const localJsParts: string[] = []
  const localHeadParts: string[] = []
  const esiHeadTags: string[] = []

  for (let i = 0; i < resolved.children.length; i++) {
    const childEntry = page.components![i]
    const isFragment = typeof childEntry === 'string' && childEntry.startsWith('@')

    if (isFragment) {
      const fragName = childEntry.slice(1)
      const fragFile = locale ? `index.${locale}.html` : 'index.html'
      const fragPath = `fragments/${fragName}/${fragFile}`
      esiHeadTags.push(`<!--esi-head:/${fragPath}-->`)
      bodyParts.push(`<!--esi:/${fragPath}-->`)
    } else {
      const rendered = await renderComponent(resolved.children[i])
      bodyParts.push(rendered.html)
      if (rendered.css) localCssParts.push(rendered.css)
      if (rendered.js) localJsParts.push(rendered.js)
      if (rendered.head) localHeadParts.push(rendered.head)
    }
  }

  // Render page-level template (layout CSS, head tags)
  const lang = seo?.locale || locale || 'en'
  const childOutputs = await Promise.all(resolved.children.map(c => renderComponent(c, undefined, lang)))
  const pageOutput = await resolved.template({ content: resolved.content, children: childOutputs, locale: lang })
  if (pageOutput.css) localCssParts.unshift(pageOutput.css)
  if (pageOutput.head) localHeadParts.unshift(pageOutput.head)

  // Use page name as path (matches source folder structure)
  const pageDir = `pages/${pageName}`

  // Remember old hashed files for cleanup
  const oldFiles = await listHashedFiles(targetStorage, pageDir)
  const newFiles: string[] = []
  let fileCount = 0

  // Write page CSS as hashed file
  const pageCss = localCssParts.join('\n')
  let pageCssLink = ''
  if (pageCss) {
    const hash = contentHash(pageCss)
    const cssPath = `${pageDir}/styles.${hash}.css`
    await targetStorage.mkdir(pageDir)
    await targetStorage.writeFile(cssPath, pageCss)
    newFiles.push(cssPath)
    pageCssLink = `<link rel="stylesheet" href="/${cssPath}">`
    fileCount++
  }

  // Write page JS as hashed file (if any)
  const pageJs = localJsParts.join('\n')
  let pageJsLink = ''
  if (pageJs) {
    const hash = contentHash(pageJs)
    const jsPath = `${pageDir}/script.${hash}.js`
    await targetStorage.mkdir(pageDir)
    await targetStorage.writeFile(jsPath, pageJs)
    newFiles.push(jsPath)
    pageJsLink = `<script type="module" src="/${jsPath}"></script>`
    fileCount++
  }

  // SEO tags from the fallback chain — same logic as renderPage uses for
  // static publish. Template head parts are checked for duplicates so the
  // renderer doesn't double-emit tags the template already provides.
  const templateHead = localHeadParts.join('\n')
  const seoHead = resolveSeoTags({
    metadata: page.metadata,
    content: page.content,
    route: page.route,
    seo: seo ?? {},
    templateHead,
  })

  const headContent = [
    `<meta charset="UTF-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
    seoHead,
    ...localHeadParts,
    pageCssLink,
    ...esiHeadTags,
    pageJsLink,
  ]
    .filter(Boolean)
    .join('\n  ')

  const bodyContent = bodyParts.join('\n')

  // Resolve cache config: page → target → defaults
  const browser = page.cache?.browser ?? targetCache?.browser ?? 0
  const edge = page.cache?.edge ?? targetCache?.edge ?? 86400
  const cacheComment = `<!--cache:browser=${browser},edge=${edge}-->\n`

  const html = `${cacheComment}<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
  ${headContent}
</head>
<body>
${bodyContent}
</body>
</html>`

  const indexFile = locale ? `index.${locale}.html` : 'index.html'
  await targetStorage.mkdir(pageDir)
  await targetStorage.writeFile(`${pageDir}/${indexFile}`, html)
  fileCount++

  // Write content-hash sidecar + reverse-dep sidecars for compare/dependents.
  // Locale variants get locale-suffixed sidecars (.hash.fr, .pub.fr);
  // structural sidecars (.uses-*, .tpl-*) are shared (written only for default).
  if (manifestHash) {
    await writeSidecars(
      targetStorage,
      pageDir,
      {
        hash: manifestHash,
        uses: collectFragmentRefs(page.components),
        template: page.template,
        pub: {
          lastPublished: new Date().toISOString(),
          noindex: !!page.metadata?.robots?.includes('noindex'),
        },
      },
      locale,
    )
  }

  // Clean up old hashed files
  const removed = await cleanupOldFiles(targetStorage, oldFiles, newFiles)

  return { files: fileCount, removed }
}

/**
 * Publish a page as fully assembled HTML — no ESI, no worker needed.
 * All components (including fragments) are baked in. CSS/JS inline.
 * For static hosting: GitHub Pages, Netlify, Vercel, any file server.
 */
export async function publishPageStatic(
  pageName: string,
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  templatesDir?: string,
  manifestHash?: string,
  preloadedSite?: Site,
  /** SEO context for the fallback chain — caller builds from manifest + target config. */
  seo?: import('./seo.js').SeoContext,
  /** Locale for this render pass. When set, resolves locale-specific content and writes to locale-prefixed path. */
  locale?: string,
): Promise<{ files: number }> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, templatesDir }))
  const page = site.pages.get(pageName)
  if (!page) throw new Error(`Page "${pageName}" not found`)

  // Scope IDs are now deterministic (hash-based), no reset needed
  const resolved = await resolvePage(pageName, site, locale)
  const html = await renderPage(resolved, {
    metadata: page.metadata,
    route: page.route,
    seo,
  })

  // URL path: / → index.html, /about → about/index.html
  // Locale prefix: /fr/about → fr/about/index.html
  const baseUrlPath = page.route === '/' ? '' : page.route.replace(/^\//, '')
  const urlPath = locale ? (baseUrlPath ? `${locale}/${baseUrlPath}` : locale) : baseUrlPath
  const outputPath = urlPath ? `${urlPath}/index.html` : 'index.html'
  const outputDir = urlPath || '.'

  await targetStorage.mkdir(outputDir)
  await targetStorage.writeFile(outputPath, html)
  // Sidecars go under pages/{name}/ regardless of static route layout, so compare
  // + dependents find them the same way as for ESI targets. pages/ doesn't clash
  // with static serving (routes are / and /{route}, not /pages/*).
  if (manifestHash) {
    await writeSidecars(targetStorage, `pages/${pageName}`, {
      hash: manifestHash,
      uses: collectFragmentRefs(page.components),
      template: page.template,
      pub: {
        lastPublished: new Date().toISOString(),
        noindex: !!page.metadata?.robots?.includes('noindex'),
      },
    })
  }

  return { files: 1 }
}

/**
 * Publish a fragment as HTML with a <head> section for CSS/JS.
 * The worker injects <head> content before </head> and body content at the ESI placeholder.
 */
export async function publishFragmentRendered(
  fragmentName: string,
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  templatesDir?: string,
  manifestHash?: string,
  preloadedSite?: Site,
  /** Locale for this render pass. When set, resolves locale-specific content and writes to index.{locale}.html. */
  locale?: string,
): Promise<{ files: number; removed: number }> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, templatesDir }))
  const fragment = site.fragments.get(fragmentName)
  if (!fragment) throw new Error(`Fragment "${fragmentName}" not found`)

  const resolved = await resolveFragment(fragmentName, site, locale)

  // Scope IDs are now deterministic (hash-based), no reset needed
  const rendered = await renderComponent(resolved)

  const fragDir = `fragments/${fragmentName}`
  const oldFiles = await listHashedFiles(targetStorage, fragDir)
  const newFiles: string[] = []
  let fileCount = 0

  // Write fragment CSS as hashed file
  const headParts: string[] = []
  if (rendered.css) {
    const hash = contentHash(rendered.css)
    const cssPath = `${fragDir}/styles.${hash}.css`
    await targetStorage.mkdir(fragDir)
    await targetStorage.writeFile(cssPath, rendered.css)
    newFiles.push(cssPath)
    headParts.push(`<link rel="stylesheet" href="/${cssPath}">`)
    fileCount++
  }

  // Write fragment JS as hashed file (if any)
  if (rendered.js) {
    const hash = contentHash(rendered.js)
    const jsPath = `${fragDir}/script.${hash}.js`
    await targetStorage.mkdir(fragDir)
    await targetStorage.writeFile(jsPath, rendered.js)
    newFiles.push(jsPath)
    headParts.push(`<script type="module" src="/${jsPath}"></script>`)
    fileCount++
  }

  if (rendered.head) {
    headParts.push(rendered.head)
  }

  // Build fragment HTML
  const headSection = headParts.length ? `<head>\n${headParts.join('\n')}\n</head>\n` : ''
  const fragmentHtml = `${headSection}${rendered.html}`

  const indexFile = locale ? `index.${locale}.html` : 'index.html'
  await targetStorage.mkdir(fragDir)
  await targetStorage.writeFile(`${fragDir}/${indexFile}`, fragmentHtml)
  fileCount++

  // Write content-hash sidecar + reverse-dep sidecars for compare/dependents.
  // Locale variants get locale-suffixed sidecars (.hash.fr);
  // structural sidecars (.uses-*, .tpl-*) are shared (written only for default).
  if (manifestHash) {
    await writeSidecars(
      targetStorage,
      fragDir,
      {
        hash: manifestHash,
        uses: collectFragmentRefs(fragment.components),
        template: fragment.template,
        pub: null,
      },
      locale,
    )
  }

  // Clean up old hashed files
  const removed = await cleanupOldFiles(targetStorage, oldFiles, newFiles)

  return { files: fileCount, removed }
}

/**
 * Publish site manifest (stripped of targets config).
 */
export async function publishSiteManifest(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<void> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot }))
  const manifest = { name: site.manifest.name, version: site.manifest.version }
  await targetStorage.writeFile('site.json', JSON.stringify(manifest))
}

/**
 * Rebuild the asset-refs sidecar index on the target.
 *
 * Walks every page + fragment manifest (including locale variants) from
 * the source site and writes per-edge sidecars at
 * `{target}/.gazetta/asset-refs/{asset}/{item}`. Wipes the existing
 * index dir first to avoid stale entries from previous publishes.
 *
 * Used by:
 *   - publish flow (CLI + admin route) at end of publish
 *   - reindex CLI for source-side recovery
 *   - history-restorer after rollback
 *
 * The cost is N readDirs + N small writes; mirrors the rest of the
 * publish loop's per-item work.
 *
 * Why rebuild rather than incremental: a full rebuild is one walk +
 * N zero-byte writes — simpler than tracking diffs against the target's
 * prior state and equally fast for typical sites.
 */
export async function rebuildAssetRefsIndex(
  sourceSite: Site,
  destStorage: StorageProvider,
  destRootPath = '',
): Promise<void> {
  const destRoot = createContentRoot(destStorage, destRootPath)

  // Wipe existing index — full rebuild semantics. Stale entries from
  // assets that no longer exist in source manifests get cleared.
  await destStorage.rm(destRoot.path(ASSET_REFS_ROOT)).catch(() => {
    // Missing dir = nothing to wipe; fine.
  })

  const writes: Promise<void>[] = []
  for (const { name, page, locale } of allPageEntries(sourceSite)) {
    const item = locale ? { source: 'page' as const, name, locale } : { source: 'page' as const, name }
    writes.push(rebuildItemRefs(destRoot, item, null, page))
  }
  for (const { name, fragment, locale } of allFragmentEntries(sourceSite)) {
    const item = locale ? { source: 'fragment' as const, name, locale } : { source: 'fragment' as const, name }
    writes.push(rebuildItemRefs(destRoot, item, null, fragment))
  }
  await Promise.all(writes)
}

/**
 * Publish-flow wrapper that loads the site if needed and rebuilds the
 * asset-refs index on the target. Same call shape as
 * `publishFragmentIndex` so callers can wire them in series.
 */
export async function publishAssetRefsIndex(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<void> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot }))
  await rebuildAssetRefsIndex(site, targetStorage, '')
}

/**
 * Build and store reverse fragment index.
 * Maps each fragment to the list of page routes that use it.
 */
export async function publishFragmentIndex(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<Record<string, string[]>> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot }))
  const index: Record<string, string[]> = {}

  for (const [_pageName, page] of site.pages) {
    if (!page.components) continue
    for (const entry of page.components) {
      if (typeof entry === 'string' && entry.startsWith('@')) {
        if (!index[entry]) index[entry] = []
        index[entry].push(page.route)
      }
    }
  }

  await targetStorage.mkdir('index')
  await targetStorage.writeFile('index/fragments.json', JSON.stringify(index))
  return index
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

/**
 * Publish a fragment and purge affected pages.
 */
export async function publishFragmentWithPurge(
  fragmentName: string,
  sourceStorage: StorageProvider,
  sourceDir: string,
  targetStorage: StorageProvider,
  purge: PurgeStrategy,
  purgeMode: 'all' | 'url' = 'all',
): Promise<{ files: number; purgedUrls: string[] }> {
  const result = await publishFragmentRendered(fragmentName, createContentRoot(sourceStorage, sourceDir), targetStorage)

  if (purgeMode === 'all') {
    await purge.purgeAll()
    return { ...result, purgedUrls: ['*'] }
  }

  let index: Record<string, string[]> = {}
  try {
    index = JSON.parse(await targetStorage.readFile('index/fragments.json'))
  } catch {
    /* no index yet */
  }

  const urls = index[`@${fragmentName}`] ?? []
  if (urls.length > 0) {
    await purge.purgeUrls(urls)
  }
  return { ...result, purgedUrls: urls }
}

/**
 * Publish a page and purge its URL.
 */
export async function publishPageWithPurge(
  pageName: string,
  sourceStorage: StorageProvider,
  sourceDir: string,
  targetStorage: StorageProvider,
  purge: PurgeStrategy,
): Promise<{ files: number; purgedUrls: string[] }> {
  const sourceRoot = createContentRoot(sourceStorage, sourceDir)
  const result = await publishPageRendered(pageName, sourceRoot, targetStorage)

  const site = await loadSite({ contentRoot: sourceRoot })
  const page = site.pages.get(pageName)
  if (page) await purge.purgeUrls([page.route])

  await publishFragmentIndex(sourceRoot, targetStorage)

  return { ...result, purgedUrls: page ? [page.route] : [] }
}
