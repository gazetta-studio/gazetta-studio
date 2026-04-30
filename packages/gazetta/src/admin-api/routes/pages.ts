import { Hono } from 'hono'
import { join } from 'node:path'
import { loadSiteFromSource } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import type { SourceContextResolver } from '../source-context.js'
import { CreatePageRequestSchema } from '../schemas/pages.js'
import { isValidLocale } from '../../locale.js'
import { rebuildAssetRefs, type ItemRef } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'

export function pageRoutes(resolve: SourceContextResolver) {
  const app = new Hono()

  app.get('/api/pages', async c => {
    const source = await resolve(c.req.query('target'))
    // Empty target (e.g. a publish-target that's never received any
    // content) is valid per the stateless-CMS model — return an empty
    // list rather than erroring. Callers checking item availability
    // across targets (e.g. the target-switch missing-item banner) rely
    // on this: a 404/500 would force them to choose between "fail
    // open" (wrong, reports items as present) and "fail closed" (wrong,
    // hides legitimate targets the user might want to switch to).
    try {
      const site = await loadSiteFromSource(source)
      const pages = [...site.pages.entries()].map(([name, page]) => {
        const localeEntry = site.pageLocales.get(name)
        return {
          name,
          route: page.route,
          template: page.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
        }
      })
      return c.json(pages)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('No site.yaml found')) return c.json([])
      throw err
    }
  })

  app.post('/api/pages', async c => {
    const source = await resolve(c.req.query('target'))
    const { storage } = source
    // Schema-validate the body so drift between client and server
    // can't silently accept malformed requests. The Zod schema is the
    // single source of truth, shared with the client via
    // `gazetta/admin-api/schemas` (see testing-plan.md Priority 3.2).
    const raw = await c.req.json()
    const parsed = CreatePageRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid request body',
          issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      )
    }
    const body = parsed.data

    const pageDir = source.contentRoot.path('pages', body.name)
    const manifestPath = join(pageDir, 'page.json')

    if (await storage.exists(manifestPath)) {
      return c.json({ error: `Page "${body.name}" already exists` }, 409)
    }

    await storage.mkdir(pageDir)
    const manifest = {
      template: body.template,
      content: body.content ?? { title: body.name },
      components: [],
    }
    await storage.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    // Dep sidecars: index this page's asset and fragment references.
    // Freshly-created pages have empty manifests so this is mostly a
    // no-op today, but wires the dep tracking the moment templates
    // ship initial content with `_asset` or `@fragment` refs.
    const item: ItemRef = { source: 'page', name: body.name }
    await Promise.all([
      rebuildAssetRefs(source.contentRoot, item, null, manifest),
      rebuildFragmentDeps(source.contentRoot, item, null, manifest),
    ])
    return c.json({ ok: true, name: body.name })
  })

  app.get('/api/pages/:name{.+}', async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)
    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source)

    // If a locale is requested, return the locale variant
    let page = site.pages.get(name)
    if (locale) {
      const localeEntry = site.pageLocales.get(name)
      const localeVariant = localeEntry?.locales.get(locale)
      if (localeVariant) page = localeVariant
      else if (!page) return c.json({ error: `Page "${name}" locale "${locale}" not found` }, 404)
    }
    if (!page) return c.json({ error: `Page "${name}" not found` }, 404)

    const localeEntry = site.pageLocales.get(name)
    return c.json({
      name,
      route: page.route,
      template: page.template,
      content: page.content,
      components: page.components,
      metadata: page.metadata,
      dir: page.dir,
      locale: locale ?? undefined,
      locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
    })
  })

  app.put('/api/pages/:name{.+}', async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)

    const source = await resolve(c.req.query('target'))
    const { storage } = source
    const site = await loadSiteFromSource(source)

    // Resolve the page to update — locale variant or default
    const defaultPage = site.pages.get(name)
    if (!defaultPage) return c.json({ error: `Page "${name}" not found` }, 404)
    const localeVariant = locale ? site.pageLocales.get(name)?.locales.get(locale) : undefined
    const page = localeVariant ?? defaultPage

    const body = await c.req.json()
    const manifest: Record<string, unknown> = {
      template: body.template ?? page.template,
      content: body.content ?? page.content,
      components: body.components ?? page.components,
    }
    if (body.metadata !== undefined) manifest.metadata = body.metadata
    else if (page.metadata) manifest.metadata = page.metadata
    // Locale variants store their route for preview resolution
    if (locale && page.route) manifest.route = page.route

    const filename = locale ? `page.${locale}.json` : 'page.json'
    const manifestPath = join(defaultPage.dir, filename)
    const serialized = JSON.stringify(manifest, null, 2) + '\n'

    // Record the history revision BEFORE the disk write. recordWrite's
    // first call scans the content tree to produce a pre-save baseline
    // — if we wrote to disk first, the baseline would capture the
    // post-save state and "undo my first save" would be a no-op.
    // The baseline scan reads current disk state (pre-save); then
    // recordWrite overlays the incoming delta (the post-save content)
    // to build the save revision's snapshot.
    if (source.history) {
      await recordWrite({
        history: source.history,
        contentRoot: source.contentRoot,
        operation: 'save',
        items: [{ path: source.contentRoot.relative(manifestPath), content: serialized }],
      })
    }
    await storage.writeFile(manifestPath, serialized)
    // Dep sidecars: diff old vs new manifest for both asset and fragment
    // references. Each affected target gets its sidecar written/removed
    // accordingly. The pre-save manifest is already in memory as `page`
    // (via loadSiteFromSource).
    const item: ItemRef = locale ? { source: 'page', name, locale } : { source: 'page', name }
    await Promise.all([
      rebuildAssetRefs(source.contentRoot, item, page, manifest),
      rebuildFragmentDeps(source.contentRoot, item, page, manifest),
    ])
    return c.json({ ok: true })
  })

  app.delete('/api/pages/:name{.+}', async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    const { storage } = source
    const site = await loadSiteFromSource(source)
    const page = site.pages.get(name)
    if (!page) return c.json({ error: `Page "${name}" not found` }, 404)

    const manifestPath = join(page.dir, 'page.json')
    // History first — see PUT handler rationale.
    if (source.history) {
      await recordWrite({
        history: source.history,
        contentRoot: source.contentRoot,
        operation: 'save',
        items: [{ path: source.contentRoot.relative(manifestPath), content: null }],
      })
    }
    await storage.rm(page.dir)
    // Dep sidecars: deleting the page removes all its refs (both asset
    // and fragment). Pass pre-delete manifest as `old`, null as `new`.
    // Per-locale variants share the page directory so they all go in
    // the rm above; tear down the index entries for default + each
    // locale variant the site loader exposed.
    const localeEntry = site.pageLocales.get(name)
    const variantManifests = localeEntry ? [...localeEntry.locales.entries()] : []
    const teardowns: Promise<void>[] = [
      rebuildAssetRefs(source.contentRoot, { source: 'page', name }, page, null),
      rebuildFragmentDeps(source.contentRoot, { source: 'page', name }, page, null),
    ]
    for (const [loc, variant] of variantManifests) {
      teardowns.push(
        rebuildAssetRefs(source.contentRoot, { source: 'page', name, locale: loc }, variant, null),
        rebuildFragmentDeps(source.contentRoot, { source: 'page', name, locale: loc }, variant, null),
      )
    }
    await Promise.all(teardowns)
    return c.json({ ok: true })
  })

  return app
}
