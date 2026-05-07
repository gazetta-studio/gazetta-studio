import { Hono } from 'hono'
import { join } from 'node:path'
import { loadSiteFromSource } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import type { SourceContextResolver } from '../source-context.js'
import { CreatePageRequestSchema, type PageSummary } from '../schemas/pages.js'
import { isValidLocale } from '../../locale.js'
import { rebuildAssetRefs, type ItemRef } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import { hasBlockingIssues, runSaveDelta } from '../../validation/save-delta.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import type { PageManifest } from '../../types.js'
import { computeSaveEtag } from '../../save-etag.js'
import { ensureComponentIds } from '../../component-ids.js'
import { requireCapability } from '../middleware/capability.js'
import type { AuditEnv } from '../middleware/audit.js'
import {
  buildHookContext,
  dispatchAfterLoad,
  dispatchAfterSave,
  dispatchBeforeSave,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
} from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'

export interface PageRoutesOptions {
  /**
   * Registered hooks. When omitted, dispatch is a no-op (sites
   * without hooks pay zero overhead). Construct via
   * `new HookRegistry()` + `discoverSiteLocalHooks(...)` in the
   * admin-api boot path.
   */
  hooks?: HookRegistry
}

export function pageRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: PageRoutesOptions = {},
) {
  const app = new Hono<AuditEnv>()
  const hooks = opts.hooks

  app.get('/api/pages', requireCapability('read:pages'), async c => {
    const source = await resolve(c.req.query('target'))
    // Empty target (e.g. a publish-target that's never received any
    // content) is valid per the stateless-CMS model — return an empty
    // list rather than erroring. Callers checking item availability
    // across targets (e.g. the target-switch missing-item banner) rely
    // on this: a 404/500 would force them to choose between "fail
    // open" (wrong, reports items as present) and "fail closed" (wrong,
    // hides legitimate targets the user might want to switch to).
    try {
      // Cache the summary list. Per design-scale.md, /api/pages is a
      // load-bearing read; per design-cache.md the key includes the
      // 'pages:' reserved prefix so save handlers can blow this entry
      // (and any future per-prefix entries) with one invalidatePrefix.
      // SourceContext owns the cache, so two requests against the same
      // target reuse the same instance.
      //
      // The `:target:{name}` suffix is target-scoping per design-cache.md
      // Gap 6 ("Target is a first-class dimension in cache keys when
      // value is target-scoped"). Pages can diverge between targets
      // (per design-publishing.md "targets can diverge"), so summaries
      // must too. Without the suffix, two SourceContexts sharing one
      // backing cache (operator's `gazetta.config.ts defaults.cache`)
      // would clobber each other's summaries.
      const targetKey = source.targetName ?? '__source__'
      const cacheKey = `pages:summary:target:${targetKey}`
      const cached = await source.cache.get<PageSummary[]>(cacheKey)
      if (cached) return c.json(cached)
      const site = await loadSiteFromSource(source)
      const pages: PageSummary[] = [...site.pages.entries()].map(([name, page]) => {
        const localeEntry = site.pageLocales.get(name)
        return {
          name,
          route: page.route,
          template: page.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
        }
      })
      await source.cache.set(cacheKey, pages)
      return c.json(pages)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([])
      throw err
    }
  })

  app.post('/api/pages', requireCapability('edit:pages'), async c => {
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
    // The summary list is now stale — drop it so the next /api/pages
    // recomputes from disk. Cheap (single key) and explicit per
    // design-cache.md Q2 (no auto-invalidation; consumers enumerate).
    //
    // Note: `pages:` matches all `pages:summary:target:*` entries,
    // so this over-invalidates other targets when a backing cache is
    // shared (one cross-target recompute on next read per affected
    // target). Acceptable trade vs. the alternative — per-target
    // precision would require the save handler to scope its
    // invalidation key, but `pages:summary:target:${this}` doesn't
    // catch hypothetical future per-page entries (e.g.
    // `pages:detail:home:target:${this}`) without a wildcard the
    // cache contract doesn't support.
    await source.cache.invalidatePrefix('pages:')
    return c.json({ ok: true, name: body.name })
  })

  app.get('/api/pages/:name{.+}', requireCapability('read:pages'), async c => {
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
    // Save-concurrency etag — see save-etag.ts. Client uses this in
    // If-Match on the next PUT to detect mid-edit drift (someone else
    // saved while the author was editing). Different from the
    // `.{8hex}.hash` publish-state hash; both run.
    const etag = await computeSaveEtag({
      template: page.template,
      content: page.content,
      components: page.components,
      metadata: page.metadata,
      route: page.route,
    })
    c.header('ETag', `"${etag}"`)
    let body: Record<string, unknown> = {
      name,
      route: page.route,
      template: page.template,
      content: page.content,
      components: page.components,
      metadata: page.metadata,
      dir: page.dir,
      locale: locale ?? undefined,
      locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
    }
    // afterLoad hooks per design-hooks.md "Save flow with hooks":
    // mutating chain at read time. Hooks may transform the loaded
    // payload (e.g., resolve denormalized references, inject
    // synthetic fields). Output flows to the client.
    if (hooks) {
      const ctx = buildHookContext({
        principal: c.var.principal,
        storage: source.storage,
        target: source.targetName,
        requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
        site: { name: source.manifest?.name },
        auditEmit: makeAuditFiringEmitter(c.var.audit),
      })
      body = await dispatchAfterLoad(hooks, { kind: 'page', name, locale: locale ?? undefined }, body, ctx)
    }
    return c.json(body)
  })

  app.put('/api/pages/:name{.+}', requireCapability('edit:pages'), async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)

    const source = await resolve(c.req.query('target'))
    const { storage } = source
    const site = await loadSiteFromSource(source, { templatesDir })

    // Resolve the page to update — locale variant or default
    const defaultPage = site.pages.get(name)
    if (!defaultPage) return c.json({ error: `Page "${name}" not found` }, 404)
    const localeVariant = locale ? site.pageLocales.get(name)?.locales.get(locale) : undefined
    const page = localeVariant ?? defaultPage

    // Save-concurrency check per design-offline.md Q3. If-Match
    // present → server compares against current on-disk etag; mismatch
    // returns 409 STALE with current manifest body so the client can
    // surface a conflict diff. Absent If-Match → no concurrency check
    // (online clients without offline-awareness keep working — last-
    // write-wins). Header value is RFC-7232 quoted; normalize.
    const ifMatchRaw = c.req.header('If-Match')
    const ifMatch = ifMatchRaw?.replace(/^"(.*)"$/, '$1')
    if (ifMatch) {
      const currentEtag = await computeSaveEtag({
        template: page.template,
        content: page.content,
        components: page.components,
        metadata: page.metadata,
        route: page.route,
      })
      if (currentEtag !== ifMatch) {
        return c.json(
          {
            code: 'STALE' as const,
            current: {
              template: page.template,
              content: page.content,
              components: page.components,
              metadata: page.metadata,
              route: page.route,
            },
            currentEtag,
          },
          409,
          { ETag: `"${currentEtag}"` },
        )
      }
    }

    const body = await c.req.json()
    // Auto-generate stable component IDs on every save. Existing IDs
    // are preserved; ID-less components get NanoIDs. Per
    // `design-collaboration.md`, IDs are the load-bearing anchor for
    // inline comments + future per-component overrides. Running this
    // on every save (not just creation) means existing pages migrate
    // to having IDs the first time the author saves them — no separate
    // migration step required.
    const components = ensureComponentIds(body.components ?? page.components)
    const manifest: Record<string, unknown> = {
      template: body.template ?? page.template,
      content: body.content ?? page.content,
      components,
    }
    if (body.metadata !== undefined) manifest.metadata = body.metadata
    else if (page.metadata) manifest.metadata = page.metadata
    // Locale variants store their route for preview resolution
    if (locale && page.route) manifest.route = page.route

    const filename = locale ? `page.${locale}.json` : 'page.json'
    const manifestPath = join(defaultPage.dir, filename)
    const serialized = JSON.stringify(manifest, null, 2) + '\n'

    // Save-delta validation runs against the manifest the author is about to
    // commit. The route handler is responsible for converting issues into a
    // 409 response when error-severity issues are present. The validation
    // contract: validators must not throw on validation failure; the
    // orchestrator catches infrastructure errors and surfaces them as
    // synthetic issues so the save flow stays predictable.
    const issues = await runSaveDelta(
      {
        item: { kind: 'page', name, itemPath: source.contentRoot.relative(manifestPath) },
        before: page as unknown as PageManifest,
        after: { ...(manifest as unknown as PageManifest), route: page.route },
        site,
        contentRoot: source.contentRoot,
        storage,
      },
      validators,
    )
    if (hasBlockingIssues(issues)) {
      // Audit: validation-failed save. Per design-audit.md "Recording
      // sites": this layer produced the outcome (validators ran first,
      // returned blocking issues); record once before returning the
      // 409. The audit record never blocks the response (fail-open
      // unless strict mode).
      await c.var.audit.record({
        action: 'save',
        outcome: 'validation-failed',
        scope: { kind: 'page', name },
        metadata: locale ? { locale } : undefined,
      })
      return c.json({ code: 'VALIDATION_FAILED' as const, issues }, 409)
    }

    // beforeSave hooks per design-hooks.md "Save flow with hooks":
    // validators run → beforeSave fires → storage write → afterSave
    // → response. Hooks see the post-validation manifest; their
    // returned payload proceeds to disk. A handler that throws
    // cancels the operation (HookCancellation) — surface as a
    // 409 with HOOK_CANCELLED so clients can discriminate.
    //
    // Build the HookContext ONCE per request — design-hooks.md
    // "HookContext shape" locks `now` + `requestId` as deterministic
    // for all hooks in a request. Reused for the afterSave dispatch
    // below.
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: source.storage,
          target: source.targetName,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: source.manifest?.name },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    const hookScope = { kind: 'page' as const, name, locale: locale ?? undefined }
    let finalManifest: Record<string, unknown> = manifest
    if (hooks && hookCtx) {
      try {
        finalManifest = await dispatchBeforeSave(hooks, hookScope, manifest, hookCtx)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          await c.var.audit.record({
            action: 'save',
            outcome: 'validation-failed',
            scope: { kind: 'page', name },
            metadata: {
              ...(locale ? { locale } : {}),
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return c.json({ code: 'HOOK_CANCELLED' as const, hook: err.hookName, reason: err.message }, 409)
        }
        throw err
      }
    }
    // Re-serialize the (potentially mutated) manifest.
    const serializedFinal = hooks === undefined ? serialized : JSON.stringify(finalManifest, null, 2) + '\n'

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
        items: [{ path: source.contentRoot.relative(manifestPath), content: serializedFinal }],
      })
    }
    await storage.writeFile(manifestPath, serializedFinal)
    // Dep sidecars: diff old vs new manifest for both asset and fragment
    // references. Each affected target gets its sidecar written/removed
    // accordingly. The pre-save manifest is already in memory as `page`
    // (via loadSiteFromSource).
    const item: ItemRef = locale ? { source: 'page', name, locale } : { source: 'page', name }
    await Promise.all([
      rebuildAssetRefs(source.contentRoot, item, page, finalManifest),
      rebuildFragmentDeps(source.contentRoot, item, page, finalManifest),
    ])
    await source.cache.invalidatePrefix('pages:')
    // Echo the new save-etag so the client updates its baseline
    // without a separate GET. The shape MUST match what the next
    // GET produces — `route` is derived from the folder, not stored
    // in the file, but the in-memory entry carries it. Carry it
    // here so the projection chain works for offline replay
    // sequences (design-offline.md Q3).
    const echoShape: Record<string, unknown> = { ...finalManifest }
    if (page.route !== undefined) echoShape.route = page.route
    const newEtag = await computeSaveEtag(echoShape)
    c.header('ETag', `"${newEtag}"`)
    // Audit: successful save. Records actor + scope + locale (when
    // locale variant). Strict-mode operators check the result.failed
    // count; fail-open default ignores. Recorder never throws.
    await c.var.audit.record({
      action: 'save',
      outcome: 'success',
      scope: { kind: 'page', name },
      metadata: locale ? { locale } : undefined,
    })
    // afterSave hooks per design-hooks.md "Save flow" step 5.
    // Observational; failures logged but never propagated. Runs
    // AFTER the audit record so the forensic record is durably
    // committed before observational hooks fire. Per-hook timeout
    // applies; one slow hook bounded by its timeout, not the total.
    if (hooks && hookCtx) {
      await dispatchAfterSave(hooks, hookScope, { payload: finalManifest, etag: newEtag }, hookCtx)
    }
    return c.json({ ok: true, etag: newEtag })
  })

  app.delete('/api/pages/:name{.+}', requireCapability('delete:pages'), async c => {
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
    await source.cache.invalidatePrefix('pages:')
    // Audit: successful delete.
    await c.var.audit.record({
      action: 'delete',
      outcome: 'success',
      scope: { kind: 'page', name },
    })
    return c.json({ ok: true })
  })

  return app
}
