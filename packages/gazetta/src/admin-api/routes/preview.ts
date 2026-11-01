import type { Context } from 'hono'
import { createRoute, z } from '@hono/zod-openapi'
import type { ComponentEntry, DraftOverrides, ManifestKey, ResolvedComponent } from '../../types.js'
import { manifestKeyToString } from '../../types.js'
import { allPageEntries, type Site } from '../../site-loader.js'
import { loadSiteFromSource } from '../source-context.js'
import { resolveFragment, resolvePage } from '../../resolver.js'
import { renderFragment, renderPage } from '../../renderer.js'
import { defaultLocaleFor } from '../../locale.js'
import type { SourceContext, SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { isArchived } from '../../archive-helpers.js'
import { apiApp, problems, UNVERSIONED } from '../openapi.js'
import { PreviewQuerySchema, PreviewRequestSchema } from '../schemas/preview.js'

const EMPTY_OVERRIDES: DraftOverrides = { content: {}, structural: {} }

/** Preview answers are HTML pages for the admin's iframe, errors included. */
function htmlPage(description: string) {
  return { description, content: { 'text/html': { schema: z.string() } } }
}

const previewResponses = {
  200: htmlPage('The rendered page or fragment (or an archive placeholder)'),
  404: htmlPage('No page at this path, or no content on the target yet'),
  500: htmlPage('A template failed to render'),
  ...problems({ 403: ['FORBIDDEN'] }),
}

const getPreview = createRoute({
  method: 'get',
  path: '/preview/*',
  summary: 'Render a page (`/preview/<route>`) or fragment (`/preview/@<name>`) as stored',
  ...UNVERSIONED,
  middleware: [requireCapability('read:pages')] as const,
  request: { query: PreviewQuerySchema },
  responses: previewResponses,
})

const postPreview = createRoute({
  method: 'post',
  path: '/preview/*',
  summary: 'Render a page or fragment with unsaved edits',
  ...UNVERSIONED,
  middleware: [requireCapability('read:pages')] as const,
  request: {
    query: PreviewQuerySchema,
    body: { content: { 'application/json': { schema: PreviewRequestSchema } } },
  },
  responses: previewResponses,
})

export function previewRoutes(resolve: SourceContextResolver, templatesDir?: string) {
  const app = apiApp()

  // No caching — preview always serves fresh content for editing
  app.use('/preview/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  app.openapi(getPreview, async c => {
    const source = await resolve(c.req.valid('query').target)
    return renderPreview(c, source, EMPTY_OVERRIDES, templatesDir)
  })

  app.openapi(postPreview, async c => {
    const source = await resolve(c.req.valid('query').target)
    const body = c.req.valid('json')
    const overrides: DraftOverrides = {
      content: body.overrides?.content ?? {},
      structural: (body.overrides?.structural ?? {}) as Record<string, ComponentEntry[]>,
    }
    return renderPreview(c, source, overrides, templatesDir)
  })

  return app
}

async function renderPreview(c: Context, source: SourceContext, overrides: DraftOverrides, templatesDir?: string) {
  // Empty target (no site config / no project manifest) — preview returns
  // a friendly placeholder so the admin can still show the iframe.
  // Happens when the active target is a never-published publish-target.
  let site: Awaited<ReturnType<typeof loadSiteFromSource>>
  try {
    site = await loadSiteFromSource(source, { templatesDir })
  } catch (err) {
    if ((err as Error).message.includes('loadSite:')) {
      return c.html(
        '<!doctype html><html><body style="font-family:system-ui;padding:2rem;color:#525252">' +
          '<h2 style="margin:0 0 0.5rem">No content on this target yet</h2>' +
          '<p style="margin:0;font-size:0.875rem">Publish from an editable target to see a preview here.</p>' +
          '</body></html>',
        404,
      )
    }
    throw err
  }
  const requestPath = c.req.path.replace(/^.*\/preview/, '') || '/'

  // Fragment preview: /preview/@fragmentName or /preview/fr/@fragmentName
  // Extract locale prefix if present before the @
  let previewLocale: string | undefined
  let fragRequestPath = requestPath
  const localeFragMatch = requestPath.match(/^\/([a-z]{2}(?:-[a-z]+)?)\/(@.+)$/)
  if (localeFragMatch) {
    previewLocale = localeFragMatch[1]
    fragRequestPath = `/${localeFragMatch[2]}`
  }
  if (fragRequestPath.startsWith('/@')) {
    const fragmentName = fragRequestPath.slice(2)
    // Archived fragments have no template to render (or must not render it):
    // show what references resolve to instead — the alias in @name form, or
    // 410 Gone. Fragments have no route, so the placeholder has no page link.
    const fragment = site.fragments.get(fragmentName)
    if (fragment && isArchived(fragment)) {
      return c.html(archivePlaceholder(site, fragment.aliasOf, 'fragment'))
    }
    try {
      const previewSite = withStructuralOverride(site, { kind: 'fragment', name: fragmentName }, overrides)
      const resolved = await resolveFragment(fragmentName, previewSite, previewLocale)
      applyContentOverrides(resolved, overrides.content)
      return c.html(await renderFragment(resolved, previewLocale))
    } catch (err) {
      const e = err as Error
      const msg = e.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const stack = (e.stack ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return c.html(
        `<div style="font-family:system-ui;padding:2rem;color:#fca5a5;background:#1a1a2e;min-height:100vh"><h2 style="color:#f87171;margin-bottom:1rem">Template Error</h2><pre style="white-space:pre-wrap;font-size:0.875rem;line-height:1.7">${msg}</pre><details style="margin-top:1rem"><summary style="color:#52525b;cursor:pointer">Stack trace</summary><pre style="color:#52525b;font-size:0.75rem;margin-top:0.5rem">${stack}</pre></details></div>`,
        500,
      )
    }
  }

  for (const { name: pageName, page, locale: pageLocale } of allPageEntries(site)) {
    const params = matchRoute(page.route, requestPath)
    if (params) {
      // Archived pages have no template to render (or must not render it):
      // show what visitors get instead — a 301 to the alias, or 410 Gone.
      if (isArchived(page)) return c.html(archivePlaceholder(site, page.aliasOf))
      try {
        const previewSite = withStructuralOverride(site, { kind: 'page', name: pageName }, overrides)
        const resolved = await resolvePage(pageName, previewSite, pageLocale)
        applyContentOverrides(resolved, overrides.content)
        return c.html(
          await renderPage(resolved, {
            routeParams: params,
            metadata: page.metadata,
            route: page.route,
            seo: {
              siteName: site.manifest.name,
              locale: pageLocale ?? defaultLocaleFor(site.manifest),
              defaultOgImage: site.manifest.defaultOgImage,
            },
          }),
        )
      } catch (err) {
        const e = err as Error
        const msg = e.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const stack = (e.stack ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return c.html(
          `<div style="font-family:system-ui;padding:2rem;color:#fca5a5;background:#1a1a2e;min-height:100vh"><h2 style="color:#f87171;margin-bottom:1rem">Template Error</h2><pre style="white-space:pre-wrap;font-size:0.875rem;line-height:1.7">${msg}</pre><details style="margin-top:1rem"><summary style="color:#52525b;cursor:pointer">Stack trace</summary><pre style="color:#52525b;font-size:0.75rem;margin-top:0.5rem">${stack}</pre></details></div>`,
          500,
        )
      }
    }
  }
  return c.html('<p>Page not found</p>', 404)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function archivePlaceholder(site: Site, aliasOf: string | undefined, kind: 'page' | 'fragment' = 'page'): string {
  const open = '<!doctype html><html><body style="font-family:system-ui;padding:2rem;color:#525252">'
  const close = '</body></html>'
  if (!aliasOf) {
    const detail =
      kind === 'fragment'
        ? 'This fragment is archived. References to it cannot resolve.'
        : 'This page is archived. Visitors get a "Gone" response.'
    return (
      open +
      '<h2 style="margin:0 0 0.5rem">410 Gone</h2>' +
      `<p style="margin:0;font-size:0.875rem">${detail}</p>` +
      close
    )
  }
  if (kind === 'fragment') {
    const alias = escapeHtml(`@${aliasOf}`)
    return (
      open +
      `<h2 style="margin:0 0 0.5rem">301 → ${alias}</h2>` +
      `<p style="margin:0;font-size:0.875rem">References to this fragment resolve to ${alias}.</p>` +
      close
    )
  }
  const route = escapeHtml(site.pages.get(aliasOf)?.route ?? `/${aliasOf}`)
  return (
    open +
    `<h2 style="margin:0 0 0.5rem">301 → ${route}</h2>` +
    `<p style="margin:0;font-size:0.875rem">Visitors are redirected to <a href="${route}">${route}</a>.</p>` +
    close
  )
}

function applyContentOverrides(node: ResolvedComponent, content: DraftOverrides['content']) {
  // Match on treePath (name path) for merged JSON format, fallback to filesystem path for compatibility
  const key = node.treePath ?? node.path
  if (key && content[key]) {
    node.content = content[key]
  }
  for (const child of node.children) {
    applyContentOverrides(child, content)
  }
}

/**
 * Return a shallow-cloned Site with one page or fragment manifest's `components`
 * array replaced by the structural override (when present). All other state is
 * shared with the original — only the affected Map and the affected manifest are
 * cloned. Concurrency-safe: the original Site is never mutated, so concurrent
 * preview renders can't interleave on shared state.
 *
 * When no override exists for `key`, returns the original Site unchanged.
 *
 * v1 limitation: only patches the default-locale manifest; locale-variant
 * structural overrides are not yet plumbed through. Locale-variant edits
 * fall back to the default-locale structural override if any.
 */
export function withStructuralOverride(site: Site, key: ManifestKey, overrides: DraftOverrides): Site {
  const replacement = overrides.structural[manifestKeyToString(key)]
  if (!replacement) return site
  if (key.kind === 'page') {
    const manifest = site.pages.get(key.name)
    if (!manifest) return site
    const patchedPages = new Map(site.pages)
    patchedPages.set(key.name, { ...manifest, components: replacement })
    return { ...site, pages: patchedPages }
  }
  const manifest = site.fragments.get(key.name)
  if (!manifest) return site
  const patchedFragments = new Map(site.fragments)
  patchedFragments.set(key.name, { ...manifest, components: replacement })
  return { ...site, fragments: patchedFragments }
}

function matchRoute(route: string, path: string): Record<string, string> | null {
  const routeParts = route.split('/')
  const pathParts = path.split('/')
  if (routeParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < routeParts.length; i++) {
    if (routeParts[i].startsWith(':')) {
      params[routeParts[i].slice(1)] = pathParts[i]
    } else if (routeParts[i] !== pathParts[i]) {
      return null
    }
  }
  return params
}
