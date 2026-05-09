import { Hono } from 'hono'
import { join } from 'node:path'
import { loadSiteFromSource } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import type { SourceContextResolver } from '../source-context.js'
import { CreateFragmentRequestSchema, type FragmentSummary } from '../schemas/fragments.js'
import { isValidLocale } from '../../locale.js'
import { rebuildAssetRefs, type ItemRef } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import { rebuildArchiveAliases } from '../../archive-aliases.js'
import { FRAGMENT_HANDLE, handleArchive, handlePurge } from './archive.js'
import { resolveArchivedNameConflict, type ArchivedNameConflictMode } from '../archived-name-conflict.js'
import { hasBlockingIssues, runSaveDelta } from '../../validation/save-delta.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import type { FragmentManifest } from '../../types.js'
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

export interface FragmentRoutesOptions {
  hooks?: HookRegistry
  /**
   * Background validation scanner. Fragment saves notify the scanner to
   * re-validate this fragment + every page/fragment that references it
   * (transitively, via `findDependentsFromSidecars`).
   */
  scanner?: import('../../validation/scanner.js').ValidationScanner | null
}

export function fragmentRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: FragmentRoutesOptions = {},
) {
  const app = new Hono<AuditEnv>()
  const hooks = opts.hooks

  app.get('/api/fragments', requireCapability('read:fragments'), async c => {
    const source = await resolve(c.req.query('target'))
    // Empty target → empty list. See pages.ts for rationale.
    try {
      // Cache the summary list (see pages.ts for the rationale + the
      // target-scoping invariant per design-cache.md Gap 6).
      const targetKey = source.targetName ?? '__source__'
      const cacheKey = `fragments:summary:target:${targetKey}`
      const cached = await source.cache.get<FragmentSummary[]>(cacheKey)
      if (cached) return c.json(cached)
      const site = await loadSiteFromSource(source)
      const fragments: FragmentSummary[] = [...site.fragments.entries()].map(([name, frag]) => {
        const localeEntry = site.fragmentLocales.get(name)
        return {
          name,
          template: frag.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
          // Archive surfacing per design-soft-delete.md Q7 J1.
          ...(frag.archived === true ? { archived: true } : {}),
          ...(frag.aliasOf ? { aliasOf: frag.aliasOf } : {}),
        }
      })
      await source.cache.set(cacheKey, fragments)
      return c.json(fragments)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([])
      throw err
    }
  })

  app.post('/api/fragments', requireCapability('edit:fragments'), async c => {
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

    // Per design-soft-delete.md Q5 I3: archived-name-conflict gets
    // the structured 409 + ?onConflict resolution flow. See pages.ts
    // for the full rationale; same shape applies here.
    if (await storage.exists(manifestPath)) {
      const onConflict = c.req.query('onConflict')
      const site = await loadSiteFromSource(source)
      const existing = site.fragments.get(body.name)
      const isArchived = existing?.archived === true

      if (!isArchived) {
        return c.json({ error: `Fragment "${body.name}" already exists` }, 409)
      }

      if (!onConflict) {
        return c.json(
          {
            code: 'ARCHIVED_NAME_CONFLICT' as const,
            archive: {
              kind: 'fragment' as const,
              name: body.name,
              ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
              ...(existing?.archivedBy ? { archivedBy: existing.archivedBy } : {}),
              ...(existing?.aliasOf ? { aliasOf: existing.aliasOf } : {}),
            },
          },
          409,
        )
      }

      const principal = c.var.principal
      const result = await resolveArchivedNameConflict({
        source,
        kind: 'fragment',
        name: body.name,
        existing: existing as FragmentManifest & { dir: string },
        mode: onConflict as ArchivedNameConflictMode,
        newTemplate: body.template,
        actorId: principal.id,
      })
      if (result.kind === 'invalid-mode') {
        return c.json({ error: `Invalid onConflict mode "${onConflict}"` }, 400)
      }
      const action: 'unarchive' | 'archive' | 'rename' =
        result.kind === 'restored' ? 'unarchive' : result.kind === 'replaced' ? 'archive' : 'rename'
      await c.var.audit.record({
        action,
        outcome: 'success',
        scope: { kind: 'fragment', name: body.name },
        metadata: { onConflict },
      })
      await Promise.all([source.cache.invalidatePrefix('fragments:'), source.cache.invalidatePrefix('pages:')])
      return c.json({ ok: true, name: body.name, resolution: result.kind })
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
    // Fragment edits affect both fragments and any pages that
    // reference them — drop both summaries so /api/pages reflects
    // any newly-resolvable fragment refs on the next call.
    await Promise.all([source.cache.invalidatePrefix('fragments:'), source.cache.invalidatePrefix('pages:')])
    return c.json({ ok: true, name: body.name })
  })

  app.get('/api/fragments/:name', requireCapability('read:fragments'), async c => {
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
    // Save-concurrency etag — see save-etag.ts. Same shape as pages
    // (without metadata + route since fragments don't carry them).
    const etag = await computeSaveEtag({
      template: fragment.template,
      content: fragment.content,
      components: fragment.components,
    })
    c.header('ETag', `"${etag}"`)
    let body: Record<string, unknown> = {
      name,
      template: fragment.template,
      content: fragment.content,
      components: fragment.components,
      dir: fragment.dir,
      locale: locale ?? undefined,
      locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
      // Archive fields per design-soft-delete.md Q1 A1. See pages.ts.
      ...(fragment.archived === true ? { archived: true } : {}),
      ...(fragment.archivedAt ? { archivedAt: fragment.archivedAt } : {}),
      ...(fragment.archivedBy ? { archivedBy: fragment.archivedBy } : {}),
      ...(fragment.aliasOf ? { aliasOf: fragment.aliasOf } : {}),
    }
    // afterLoad hooks per design-hooks.md "Save flow with hooks":
    // mutating chain at read time. See pages.ts for rationale.
    if (hooks) {
      const ctx = buildHookContext({
        principal: c.var.principal,
        storage: source.storage,
        target: source.targetName,
        requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
        site: { name: source.manifest?.name },
        auditEmit: makeAuditFiringEmitter(c.var.audit),
      })
      body = await dispatchAfterLoad(hooks, { kind: 'fragment', name, locale: locale ?? undefined }, body, ctx)
    }
    return c.json(body)
  })

  app.put('/api/fragments/:name', requireCapability('edit:fragments'), async c => {
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

    // Save-concurrency check per design-offline.md Q3. Mirrors the
    // pages PUT handler — see pages.ts for the rationale + 409 STALE
    // shape.
    const ifMatchRaw = c.req.header('If-Match')
    const ifMatch = ifMatchRaw?.replace(/^"(.*)"$/, '$1')
    if (ifMatch) {
      const currentEtag = await computeSaveEtag({
        template: fragment.template,
        content: fragment.content,
        components: fragment.components,
      })
      if (currentEtag !== ifMatch) {
        return c.json(
          {
            code: 'STALE' as const,
            current: {
              template: fragment.template,
              content: fragment.content,
              components: fragment.components,
            },
            currentEtag,
          },
          409,
          { ETag: `"${currentEtag}"` },
        )
      }
    }

    const body = await c.req.json()
    // Auto-generate stable component IDs on every save (per
    // `design-collaboration.md`'s component-ID anchor primitive).
    // See pages.ts PUT handler for full rationale; same shape here.
    const components = ensureComponentIds(body.components ?? fragment.components)
    const manifest = {
      template: body.template ?? fragment.template,
      content: body.content ?? fragment.content,
      components,
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
      await c.var.audit.record({
        action: 'save',
        outcome: 'validation-failed',
        scope: { kind: 'fragment', name },
        metadata: locale ? { locale } : undefined,
      })
      return c.json({ code: 'VALIDATION_FAILED' as const, issues }, 409)
    }

    // beforeSave hooks per design-hooks.md "Save flow with hooks".
    // See pages.ts PUT handler for rationale; same shape applied
    // to fragments.
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
    const hookScope = { kind: 'fragment' as const, name, locale: locale ?? undefined }
    let finalManifest: typeof manifest = manifest
    if (hooks && hookCtx) {
      try {
        finalManifest = (await dispatchBeforeSave(hooks, hookScope, manifest, hookCtx)) as typeof manifest
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          await c.var.audit.record({
            action: 'save',
            outcome: 'validation-failed',
            scope: { kind: 'fragment', name },
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
    const serializedFinal = hooks === undefined ? serialized : JSON.stringify(finalManifest, null, 2) + '\n'

    // History first — see pages.ts PUT handler rationale (baseline must
    // capture pre-write state).
    if (source.history) {
      await recordWrite({
        history: source.history,
        contentRoot: source.contentRoot,
        operation: 'save',
        items: [{ path: source.contentRoot.relative(manifestPath), content: serializedFinal }],
      })
    }
    await storage.writeFile(manifestPath, serializedFinal)
    // Dep sidecars: diff old (in-memory `fragment`) vs new manifest for
    // both asset and fragment dep relations.
    const item: ItemRef = locale ? { source: 'fragment', name, locale } : { source: 'fragment', name }
    await Promise.all([
      rebuildAssetRefs(source.contentRoot, item, fragment, finalManifest),
      rebuildFragmentDeps(source.contentRoot, item, fragment, finalManifest),
      // archive-aliases sidecar — same rationale as pages.ts.
      rebuildArchiveAliases(source.contentRoot, item, fragment, finalManifest),
    ])
    await Promise.all([source.cache.invalidatePrefix('fragments:'), source.cache.invalidatePrefix('pages:')])
    const newEtag = await computeSaveEtag(finalManifest)
    c.header('ETag', `"${newEtag}"`)
    await c.var.audit.record({
      action: 'save',
      outcome: 'success',
      scope: { kind: 'fragment', name },
      metadata: locale ? { locale } : undefined,
    })
    // afterSave per design-hooks.md "Save flow" step 5. Observational;
    // failures logged. Runs AFTER audit so the forensic record is
    // committed first.
    if (hooks && hookCtx) {
      await dispatchAfterSave(hooks, hookScope, { payload: finalManifest, etag: newEtag }, hookCtx)
    }
    // Background validation scanner re-validates this fragment + every
    // page/fragment that references it (transitively). Fire-and-forget;
    // SSE event drives the admin UI re-fetch when complete.
    if (opts.scanner) {
      void opts.scanner.rescan({ kind: 'fragment', name })
    }
    return c.json({ ok: true, etag: newEtag })
  })

  // DELETE = soft-delete (archive) by default per Cut 7 cutover.
  // `?permanent=true` invokes purge for explicit hard-delete intent.
  // See pages.ts for the full rationale; same shape applies here.
  app.delete('/api/fragments/:name', requireCapability('delete:fragments'), async c => {
    const permanent = c.req.query('permanent') === 'true'
    if (permanent) return handlePurge(c, resolve, FRAGMENT_HANDLE)
    return handleArchive(c, resolve, FRAGMENT_HANDLE)
  })

  return app
}
