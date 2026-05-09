import { createHash } from 'node:crypto'
import type { StorageProvider, PurgeStrategy, CacheConfig } from './types.js'
import type { Site } from './site-loader.js'
import { allFragmentEntries, allPageEntries, loadSite } from './site-loader.js'
import { resolvePage, resolveComponent, resolveFragment } from './resolver.js'
import { renderComponent, renderPage } from './renderer.js'
import { writeSidecars } from './sidecars.js'
import { createContentRoot, type ContentRoot } from './content-root.js'
import { resolveSeoTags, escapeAttr } from './seo.js'
import type { DepRelation } from './dep-sidecars.js'
import { rebuildItemDeps } from './dep-sidecars.js'
import { ASSET_REFS } from './assets/asset-deps.js'
import { FRAGMENT_DEPS } from './fragment-deps.js'
import { aliasTarget, isArchived } from './archive-helpers.js'
import { archiveMarker } from './runtime/archive-marker.js'

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
 * Soft-delete short-circuit — emit ONLY the archive marker line as the
 * page HTML, no body, no doctype, no CSS/JS. The worker reads the first
 * 200 bytes, sees the marker, and emits 301 / 410 without composing.
 *
 * Body content for an archived page is dead weight. The page content
 * hash sidecar is still written so cross-target compare works
 * (compare picks up that the page changed when archived).
 *
 * Hashed CSS/JS files from the previous (live) publish are cleaned up
 * via the same `cleanupOldFiles` pass the live-page emit uses.
 */
async function publishArchiveMarker(
  page: { aliasOf?: string; metadata?: { robots?: string } },
  pageName: string,
  targetStorage: StorageProvider,
  manifestHash?: string,
  locale?: string,
): Promise<{ files: number; removed: number }> {
  const target = aliasTarget(page)
  const marker = target ? archiveMarker({ kind: 'alias', target }) : archiveMarker({ kind: 'gone' })

  const pageDir = `pages/${pageName}`
  const oldFiles = await listHashedFiles(targetStorage, pageDir)
  const indexFile = locale ? `index.${locale}.html` : 'index.html'
  await targetStorage.mkdir(pageDir)
  await targetStorage.writeFile(`${pageDir}/${indexFile}`, marker)

  if (manifestHash) {
    await writeSidecars(
      targetStorage,
      pageDir,
      {
        hash: manifestHash,
        pub: {
          lastPublished: new Date().toISOString(),
          // Archived pages always 410 (no alias) or 301 (alias) — both
          // exclude from sitemap; encode noindex flag for sitemap generator.
          noindex: true,
        },
      },
      locale,
    )
  }

  // Live publish wrote `styles.<hash>.css` and `script.<hash>.js`; archive
  // emits no CSS/JS. cleanupOldFiles deletes the stale hashed files.
  const removed = await cleanupOldFiles(targetStorage, oldFiles, [])
  return { files: 1, removed }
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
  const site =
    preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, templatesDir, manifest: { name: '(publish)' } }))
  const page = site.pages.get(pageName)
  if (!page) throw new Error(`Page "${pageName}" not found`)

  // Soft-delete short-circuit (per design-soft-delete.md Q10):
  // archived pages emit ONLY the marker line as the page HTML. Body
  // content is dead weight — worker reads the first 200 bytes, sees
  // the marker, emits 301/410 without composing.
  if (isArchived(page)) {
    return publishArchiveMarker(page, pageName, targetStorage, manifestHash, locale)
  }

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

  // Write content-hash + publish sidecars for compare. Locale variants
  // get locale-suffixed sidecars (.hash.fr, .pub.fr).
  if (manifestHash) {
    await writeSidecars(
      targetStorage,
      pageDir,
      {
        hash: manifestHash,
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
  const site =
    preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, templatesDir, manifest: { name: '(publish)' } }))
  const page = site.pages.get(pageName)
  if (!page) throw new Error(`Page "${pageName}" not found`)

  // Soft-delete short-circuit — see publishArchiveMarker. For static
  // targets the URL path comes from the route (page.route → /url/path)
  // rather than the pages/{name}/ ESI layout; the route maps to a
  // disk path the host serves directly.
  if (isArchived(page)) {
    const target = aliasTarget(page)
    const marker = target ? archiveMarker({ kind: 'alias', target }) : archiveMarker({ kind: 'gone' })
    const baseUrlPath = page.route === '/' ? '' : page.route.replace(/^\//, '')
    const urlPath = locale ? (baseUrlPath ? `${locale}/${baseUrlPath}` : locale) : baseUrlPath
    const outputPath = urlPath ? `${urlPath}/index.html` : 'index.html'
    const outputDir = urlPath || '.'
    await targetStorage.mkdir(outputDir)
    await targetStorage.writeFile(outputPath, marker)
    if (manifestHash) {
      await writeSidecars(targetStorage, `pages/${pageName}`, {
        hash: manifestHash,
        pub: {
          lastPublished: new Date().toISOString(),
          noindex: true,
        },
      })
    }
    return { files: 1 }
  }

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
  const site =
    preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, templatesDir, manifest: { name: '(publish)' } }))
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

  // Write content-hash sidecar for compare. Locale variants get
  // locale-suffixed sidecars (.hash.fr).
  if (manifestHash) {
    await writeSidecars(
      targetStorage,
      fragDir,
      {
        hash: manifestHash,
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
  await destStorage.rm(destRoot.path('.gazetta', rel.rootName)).catch(() => {
    // Missing dir = nothing to wipe; fine.
  })

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
  await Promise.all([
    rebuildDepIndex(ASSET_REFS, site, targetStorage, ''),
    rebuildDepIndex(FRAGMENT_DEPS, site, targetStorage, ''),
  ])
}

/**
 * Backwards-compatible single-relation wrapper. New callers should use
 * `publishDepIndices` to get both indices rebuilt in one walk.
 */
export async function publishAssetRefsIndex(
  sourceRoot: ContentRoot,
  targetStorage: StorageProvider,
  preloadedSite?: Site,
): Promise<void> {
  const site = preloadedSite ?? (await loadSite({ contentRoot: sourceRoot, manifest: { name: '(publish)' } }))
  await rebuildDepIndex(ASSET_REFS, site, targetStorage, '')
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
