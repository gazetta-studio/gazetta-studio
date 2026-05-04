import { Hono } from 'hono'
import { join } from 'node:path'
import { loadSiteFromSource } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import type { SourceContextResolver } from '../source-context.js'
import { CreateFragmentRequestSchema } from '../schemas/fragments.js'
import { isValidLocale } from '../../locale.js'
import { rebuildAssetRefs, type ItemRef } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import { hasBlockingIssues, runSaveDelta } from '../../validation/save-delta.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import type { FragmentManifest } from '../../types.js'

export function fragmentRoutes(resolve: SourceContextResolver, validators: ValidatorRegistry, templatesDir?: string) {
  const app = new Hono()

  app.get('/api/fragments', async c => {
    const source = await resolve(c.req.query('target'))
    // Empty target → empty list. See pages.ts for rationale.
    try {
      const site = await loadSiteFromSource(source)
      const fragments = [...site.fragments.entries()].map(([name, frag]) => {
        const localeEntry = site.fragmentLocales.get(name)
        return {
          name,
          template: frag.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
        }
      })
      return c.json(fragments)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([])
      throw err
    }
  })

  app.post('/api/fragments', async c => {
    const source = await resolve(c.req.query('target'))
    const { storage } = source
    // Schema-validate the body — same rationale as pages.ts.
    const raw = await c.req.json()
    const parsed = CreateFragmentRequestSchema.safeParse(raw)
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

    const fragDir = source.contentRoot.path('fragments', body.name)
    const manifestPath = join(fragDir, 'fragment.json')

    if (await storage.exists(manifestPath)) {
      return c.json({ error: `Fragment "${body.name}" already exists` }, 409)
    }

    await storage.mkdir(fragDir)
    const manifest = { template: body.template, components: [] }
    await storage.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    // Dep sidecars: empty initial fragment, no-op today; wired for
    // symmetry with the fragment-update path.
    const item: ItemRef = { source: 'fragment', name: body.name }
    await Promise.all([
      rebuildAssetRefs(source.contentRoot, item, null, manifest),
      rebuildFragmentDeps(source.contentRoot, item, null, manifest),
    ])
    return c.json({ ok: true, name: body.name })
  })

  app.get('/api/fragments/:name', async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)
    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source)

    let fragment = site.fragments.get(name)
    if (locale) {
      const localeEntry = site.fragmentLocales.get(name)
      const localeVariant = localeEntry?.locales.get(locale)
      if (localeVariant) fragment = localeVariant
      else if (!fragment) return c.json({ error: `Fragment "${name}" locale "${locale}" not found` }, 404)
    }
    if (!fragment) return c.json({ error: `Fragment "${name}" not found` }, 404)

    const localeEntry = site.fragmentLocales.get(name)
    return c.json({
      name,
      template: fragment.template,
      content: fragment.content,
      components: fragment.components,
      dir: fragment.dir,
      locale: locale ?? undefined,
      locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
    })
  })

  app.put('/api/fragments/:name', async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)

    const source = await resolve(c.req.query('target'))
    const { storage } = source
    const site = await loadSiteFromSource(source, { templatesDir })

    const defaultFragment = site.fragments.get(name)
    if (!defaultFragment) return c.json({ error: `Fragment "${name}" not found` }, 404)
    const localeVariant = locale ? site.fragmentLocales.get(name)?.locales.get(locale) : undefined
    const fragment = localeVariant ?? defaultFragment

    const body = await c.req.json()
    const manifest = {
      template: body.template ?? fragment.template,
      content: body.content ?? fragment.content,
      components: body.components ?? fragment.components,
    }

    const filename = locale ? `fragment.${locale}.json` : 'fragment.json'
    const manifestPath = join(defaultFragment.dir, filename)
    const serialized = JSON.stringify(manifest, null, 2) + '\n'

    // Save-delta validation. Same contract as pages PUT handler — see
    // pages.ts comment for rationale.
    const issues = await runSaveDelta(
      {
        item: { kind: 'fragment', name, itemPath: source.contentRoot.relative(manifestPath) },
        before: fragment as unknown as FragmentManifest,
        after: manifest as FragmentManifest,
        site,
        contentRoot: source.contentRoot,
        storage,
      },
      validators,
    )
    if (hasBlockingIssues(issues)) {
      return c.json({ code: 'VALIDATION_FAILED' as const, issues }, 409)
    }

    // History first — see pages.ts PUT handler rationale (baseline must
    // capture pre-write state).
    if (source.history) {
      await recordWrite({
        history: source.history,
        contentRoot: source.contentRoot,
        operation: 'save',
        items: [{ path: source.contentRoot.relative(manifestPath), content: serialized }],
      })
    }
    await storage.writeFile(manifestPath, serialized)
    // Dep sidecars: diff old (in-memory `fragment`) vs new manifest for
    // both asset and fragment dep relations.
    const item: ItemRef = locale ? { source: 'fragment', name, locale } : { source: 'fragment', name }
    await Promise.all([
      rebuildAssetRefs(source.contentRoot, item, fragment, manifest),
      rebuildFragmentDeps(source.contentRoot, item, fragment, manifest),
    ])
    return c.json({ ok: true })
  })

  app.delete('/api/fragments/:name', async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    const { storage } = source
    const site = await loadSiteFromSource(source)
    const fragment = site.fragments.get(name)
    if (!fragment) return c.json({ error: `Fragment "${name}" not found` }, 404)

    const manifestPath = join(fragment.dir, 'fragment.json')
    if (source.history) {
      await recordWrite({
        history: source.history,
        contentRoot: source.contentRoot,
        operation: 'save',
        items: [{ path: source.contentRoot.relative(manifestPath), content: null }],
      })
    }
    await storage.rm(fragment.dir)
    // Dep sidecars: tear down default + every locale variant for both
    // asset and fragment dep relations.
    const localeEntry = site.fragmentLocales.get(name)
    const variantManifests = localeEntry ? [...localeEntry.locales.entries()] : []
    const teardowns: Promise<void>[] = [
      rebuildAssetRefs(source.contentRoot, { source: 'fragment', name }, fragment, null),
      rebuildFragmentDeps(source.contentRoot, { source: 'fragment', name }, fragment, null),
    ]
    for (const [loc, variant] of variantManifests) {
      teardowns.push(
        rebuildAssetRefs(source.contentRoot, { source: 'fragment', name, locale: loc }, variant, null),
        rebuildFragmentDeps(source.contentRoot, { source: 'fragment', name, locale: loc }, variant, null),
      )
    }
    await Promise.all(teardowns)
    return c.json({ ok: true })
  })

  return app
}
