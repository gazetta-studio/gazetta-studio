import { createRoute, z } from '@hono/zod-openapi'
import { problem } from '../problem.js'
import { loadSiteFromSource } from '../source-context.js'
import type { SourceContextResolver } from '../source-context.js'
import {
  CreatePageRequestSchema,
  CreatedPageResponseSchema,
  type PageDetail,
  PageDetailSchema,
  type PageSummary,
  PageSummarySchema,
  SavePageRequestSchema,
  SaveResponseSchema,
} from '../schemas/pages.js'
import { ArchiveRequestSchema, ArchiveResponseSchema, PurgeResponseSchema } from '../schemas/archive.js'
import {
  DeleteQuerySchema,
  ItemLocaleQuerySchema,
  ItemNameParamSchema,
  OnConflictQuerySchema,
  RequestIdHeaderSchema,
  SaveHeadersSchema,
  TargetQuerySchema,
} from '../schemas/item-route.js'
import { apiApp, json, problems } from '../openapi.js'
import { bodyFailure, jsonBody } from '../route-input.js'
import type { PageManifest } from '../../types.js'
import { isValidLocale } from '../../locale.js'
import { ARCHIVE_PROBLEMS, handleArchive, handlePurge, PAGE_HANDLE, PURGE_PROBLEMS } from './archive.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import { computeSaveEtag } from '../../save-etag.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import type { AuditEnv } from '../middleware/audit.js'
import { buildHookContext, dispatchAfterLoad, type HookRegistry } from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import { InvalidLocaleError, PageNotFoundError, savePage } from '../../pages/save.js'
import { createPage } from '../../pages/create.js'
import { REDIRECT_RESTORE_MESSAGE } from '../../archive-helpers.js'

export interface PageRoutesOptions {
  /**
   * Registered hooks. When omitted, dispatch is a no-op (sites
   * without hooks pay zero overhead). Construct via
   * `buildHooksRegistry({ contributions })` from
   * `manifest.admin?.hooks` in the admin-api boot path.
   */
  hooks?: HookRegistry
  /**
   * Background validation scanner. When provided, save handlers notify
   * the scanner on commit so background-stage validators re-run for the
   * affected item. When omitted, save handlers run as today (save-delta
   * only).
   */
  scanner?: import('../../validation/scanner.js').ValidationScanner | null
}

export function pageRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: PageRoutesOptions = {},
) {
  const editableTarget = requireEditableTarget(resolve)
  const app = apiApp<AuditEnv>()
  const hooks = opts.hooks

  const listPages = createRoute({
    method: 'get',
    path: '/pages',
    summary: 'List pages',
    middleware: [requireCapability('read:pages')] as const,
    request: { query: TargetQuerySchema },
    responses: {
      200: json(z.array(PageSummarySchema), 'Every page on the target; empty when the target has none'),
      ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
    },
  })
  app.openapi(listPages, async c => {
    const source = await resolve(c.req.valid('query').target)
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
      if (cached) return c.json(cached, 200)
      const site = await loadSiteFromSource(source)
      const pages: PageSummary[] = [...site.pages.entries()].map(([name, page]) => {
        const localeEntry = site.pageLocales.get(name)
        return {
          name,
          route: page.route,
          template: page.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
          // Archive surfacing per design-soft-delete.md Q7 J1.
          ...(page.archived === true ? { archived: true } : {}),
          ...(page.aliasOf ? { aliasOf: page.aliasOf } : {}),
        }
      })
      await source.cache.set(cacheKey, pages)
      return c.json(pages, 200)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([], 200)
      throw err
    }
  })

  // POST delegates to `pages/create.ts` — the create-time decision
  // tree (live conflict / archived conflict prompt / archived
  // resolution / fresh create) lives there. This handler is now a
  // protocol translator: parse + Zod-validate → call `createPage` →
  // project `CreatePageResult` to HTTP. Same response shape as before.
  const createPageRoute = createRoute({
    method: 'post',
    path: '/pages',
    summary: 'Create a page',
    middleware: [requireCapability('edit:pages'), editableTarget] as const,
    request: {
      query: OnConflictQuerySchema,
      body: { required: true, content: { 'application/json': { schema: CreatePageRequestSchema } } },
    },
    responses: {
      200: json(CreatedPageResponseSchema, 'Created, or an archived page resolved by `onConflict`'),
      ...problems({
        400: ['BAD_REQUEST', 'INVALID_CONFLICT_MODE'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        409: ['LIVE_CONFLICT', 'ARCHIVED_NAME_CONFLICT', 'REDIRECT_RESTORE'],
        415: ['BAD_REQUEST'],
      }),
    },
  })
  app.openapi(
    createPageRoute,
    async c => {
      const { target, onConflict } = c.req.valid('query')
      const source = await resolve(target)
      // The body was validated against `CreatePageRequestSchema`, shared
      // with the client via `gazetta/admin-api/schemas`.
      const body = c.req.valid('json')

      const result = await createPage({
        name: body.name,
        template: body.template,
        content: body.content,
        onConflict,
        source,
        principal: c.var.principal,
        audit: c.var.audit,
      })

      if (result.ok) {
        return c.json(
          result.resolution
            ? { ok: true, name: result.name, resolution: result.resolution }
            : { ok: true, name: result.name },
          200,
        )
      }
      if (result.code === 'LIVE_CONFLICT') {
        return problem(c, 409, 'LIVE_CONFLICT', `Page "${result.name}" already exists`)
      }
      if (result.code === 'ARCHIVED_CONFLICT') {
        return problem(c, 409, 'ARCHIVED_NAME_CONFLICT', undefined, { archive: result.archive })
      }
      if (result.code === 'REDIRECT_RESTORE') {
        // Manual Redirect targeted by restore (#1343).
        return problem(c, 409, 'REDIRECT_RESTORE', REDIRECT_RESTORE_MESSAGE)
      }
      // INVALID_CONFLICT_MODE — exhaustive narrow.
      return problem(c, 400, 'INVALID_CONFLICT_MODE', `Invalid onConflict mode "${result.mode}"`)
    },
    bodyFailure('BAD_REQUEST', 'Invalid request body'),
  )

  const getPage = createRoute({
    method: 'get',
    path: '/pages/:name{.+}',
    summary: 'Read a page',
    middleware: [requireCapability('read:pages')] as const,
    request: { params: ItemNameParamSchema, query: ItemLocaleQuerySchema, headers: RequestIdHeaderSchema },
    responses: {
      200: json(PageDetailSchema, 'The page, or its locale variant; ETag is its save version'),
      ...problems({ 400: ['BAD_REQUEST'], 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 404: ['NOT_FOUND'] }),
    },
  })
  app.openapi(getPage, async c => {
    const { name } = c.req.valid('param')
    const { target, locale: rawLocale } = c.req.valid('query')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return problem(c, 400, 'BAD_REQUEST', `Invalid locale code: "${rawLocale}"`)
    const source = await resolve(target)
    const site = await loadSiteFromSource(source)

    // If a locale is requested, return the locale variant
    let page = site.pages.get(name)
    if (locale) {
      const localeEntry = site.pageLocales.get(name)
      const localeVariant = localeEntry?.locales.get(locale)
      if (localeVariant) page = localeVariant
      else if (!page) return problem(c, 404, 'NOT_FOUND', `Page "${name}" locale "${locale}" not found`)
    }
    if (!page) return problem(c, 404, 'NOT_FOUND', `Page "${name}" not found`)

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
      // Archive fields (per design-soft-delete.md Q1 A1) — included
      // when present so the admin UI can surface "Archived" banner +
      // alias-target indicator. Absent fields stay absent (not undefined
      // in the JSON output) per the locked invariant: `archived: false`
      // is identical to `archived` absent.
      ...(page.archived === true ? { archived: true } : {}),
      ...(page.archivedAt ? { archivedAt: page.archivedAt } : {}),
      ...(page.archivedBy ? { archivedBy: page.archivedBy } : {}),
      ...(page.aliasOf ? { aliasOf: page.aliasOf } : {}),
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
        requestId: c.req.valid('header')['x-request-id'] ?? crypto.randomUUID(),
        site: { name: source.manifest?.name },
        auditEmit: makeAuditFiringEmitter(c.var.audit),
      })
      body = await dispatchAfterLoad(hooks, { kind: 'page', name, locale: locale ?? undefined }, body, ctx)
    }
    return c.json(body as PageDetail, 200)
  })

  // PUT delegates to `pages/save.ts` — the Page-Save spine lives in the
  // `manifest-save.ts` orchestrator (per Cut 2). This handler is now a
  // protocol translator: parse Hono request → call `savePage` →
  // project `SaveResult` to HTTP. Same response shape as before.
  const savePageRoute = createRoute({
    method: 'put',
    path: '/pages/:name{.+}',
    summary: 'Save a page',
    middleware: [requireCapability('edit:pages'), editableTarget] as const,
    request: {
      params: ItemNameParamSchema,
      query: ItemLocaleQuerySchema,
      headers: SaveHeadersSchema,
      body: { required: true, content: { 'application/json': { schema: SavePageRequestSchema } } },
    },
    responses: {
      200: json(SaveResponseSchema, 'Saved; ETag is the new save version'),
      ...problems({
        400: ['BAD_REQUEST'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['NOT_FOUND'],
        409: ['STALE', 'EDIT_LOCKED', 'ARCHIVED', 'VALIDATION_FAILED', 'HOOK_CANCELLED'],
        415: ['BAD_REQUEST'],
        500: ['AUDIT_FAILED'],
      }),
    },
  })
  app.openapi(savePageRoute, async c => {
    const { name } = c.req.valid('param')
    const { target, locale: rawLocale } = c.req.valid('query')
    const headers = c.req.valid('header')

    const source = await resolve(target)
    const site = await loadSiteFromSource(source, { templatesDir })

    // RFC-7232 If-Match is quoted; normalize before passing through.
    const ifMatch = headers['if-match']?.replace(/^"(.*)"$/, '$1')

    const body = c.req.valid('json') as Partial<PageManifest> & Record<string, unknown>

    let result
    try {
      result = await savePage({
        name,
        locale: rawLocale,
        body,
        ifMatch,
        site,
        source,
        principal: c.var.principal,
        audit: c.var.audit,
        validators,
        hooks,
        hookAuditEmit: makeAuditFiringEmitter(c.var.audit),
        scanner: opts.scanner ?? undefined,
        requestId: headers['x-request-id'] ?? undefined,
      })
    } catch (err) {
      if (err instanceof InvalidLocaleError) return problem(c, 400, 'BAD_REQUEST', err.message)
      if (err instanceof PageNotFoundError) return problem(c, 404, 'NOT_FOUND', err.message)
      throw err
    }

    if (result.ok) {
      c.header('ETag', `"${result.etag}"`)
      return c.json({ ok: true as const, etag: result.etag }, 200)
    }
    if (result.code === 'STALE') {
      c.header('ETag', `"${result.currentEtag}"`)
      return problem(c, 409, 'STALE', undefined, { current: result.current, currentEtag: result.currentEtag })
    }
    if (result.code === 'EDIT_LOCKED') {
      return problem(c, 409, 'EDIT_LOCKED', result.message)
    }
    if (result.code === 'ARCHIVED') {
      return problem(c, 409, 'ARCHIVED', result.message)
    }
    if (result.code === 'VALIDATION_FAILED') {
      return problem(c, 409, 'VALIDATION_FAILED', undefined, { issues: result.issues })
    }
    if (result.code === 'AUDIT_FAILED') {
      // Strict audit mode refused the write before anything changed
      // (#1393). 500 per the audit error taxonomy: the failure is
      // server-side (audit storage), not the client's request.
      return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; save refused (strict mode)')
    }
    // HOOK_CANCELLED — exhaustive narrow per Q1 lock.
    return problem(c, 409, 'HOOK_CANCELLED', undefined, { hook: result.hook, reason: result.reason })
  })

  // DELETE = soft-delete by default (Cut 7 cutover per design-soft-delete.md).
  // `?permanent=true` calls the purge logic from archive.ts for explicit
  // hard-delete intent (allowLive: the /purge routes themselves refuse
  // non-archived items, #1341); `?force=true` (admin-only) bypasses purge-blocked
  // checks. The unified path keeps audit shape consistent with the explicit
  // /archive and /purge routes — DELETE without `?permanent=true` audits
  // as `action: 'archive'`, DELETE with `?permanent=true` audits as
  // `action: 'purge'`.
  const deletePage = createRoute({
    method: 'delete',
    path: '/pages/:name{.+}',
    summary: 'Archive a page, or delete it with `permanent=true`',
    middleware: [requireCapability('delete:pages'), editableTarget, jsonBody({ optional: true })] as const,
    request: {
      params: ItemNameParamSchema,
      query: DeleteQuerySchema,
      body: { required: false, content: { 'application/json': { schema: ArchiveRequestSchema } } },
    },
    responses: {
      200: json(z.union([ArchiveResponseSchema, PurgeResponseSchema]), 'Archived, or deleted'),
      ...problems({
        400: ARCHIVE_PROBLEMS[400],
        401: ARCHIVE_PROBLEMS[401],
        403: ARCHIVE_PROBLEMS[403],
        404: ARCHIVE_PROBLEMS[404],
        409: [...ARCHIVE_PROBLEMS[409], ...PURGE_PROBLEMS[409]],
        415: ARCHIVE_PROBLEMS[415],
      }),
    },
  })
  app.openapi(
    deletePage,
    async c => {
      const { name } = c.req.valid('param')
      const { target, force, permanent } = c.req.valid('query')
      if (permanent === 'true') {
        return handlePurge(c, resolve, PAGE_HANDLE, { name, target, force: force === 'true' }, null, {
          allowLive: true,
        })
      }
      const { aliasOf } = c.req.valid('json')
      return handleArchive(c, resolve, PAGE_HANDLE, { name, target, force: force === 'true', aliasOf })
    },
    bodyFailure('BAD_REQUEST', 'Invalid request body'),
  )

  return app
}
