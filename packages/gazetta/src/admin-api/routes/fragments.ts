import { createRoute, z } from '@hono/zod-openapi'
import { problem } from '../problem.js'
import { loadSiteFromSource } from '../source-context.js'
import type { SourceContextResolver } from '../source-context.js'
import {
  CreateFragmentRequestSchema,
  CreatedFragmentResponseSchema,
  type FragmentDetail,
  FragmentDetailSchema,
  type FragmentSummary,
  FragmentSummarySchema,
  SaveFragmentRequestSchema,
} from '../schemas/fragments.js'
import { SaveResponseSchema } from '../schemas/pages.js'
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
import type { FragmentManifest } from '../../types.js'
import { isValidLocale } from '../../locale.js'
import { ARCHIVE_PROBLEMS, FRAGMENT_HANDLE, handleArchive, handlePurge, PURGE_PROBLEMS } from './archive.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import { computeSaveEtag } from '../../save-etag.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import type { AuditEnv } from '../middleware/audit.js'
import { buildHookContext, dispatchAfterLoad, type HookRegistry } from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import { FragmentNotFoundError, InvalidLocaleError, saveFragment } from '../../fragments/save.js'
import { createFragment } from '../../fragments/create.js'
import { REDIRECT_RESTORE_MESSAGE } from '../../archive-helpers.js'

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
  const editableTarget = requireEditableTarget(resolve)
  const app = apiApp<AuditEnv>()
  const hooks = opts.hooks

  const listFragments = createRoute({
    method: 'get',
    path: '/fragments',
    summary: 'List fragments',
    middleware: [requireCapability('read:fragments')] as const,
    request: { query: TargetQuerySchema },
    responses: {
      200: json(z.array(FragmentSummarySchema), 'Every fragment on the target; empty when the target has none'),
      ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
    },
  })
  app.openapi(listFragments, async c => {
    const source = await resolve(c.req.valid('query').target)
    // Empty target → empty list. See pages.ts for rationale.
    try {
      // Cache the summary list (see pages.ts for the rationale + the
      // target-scoping invariant per design-cache.md Gap 6).
      const targetKey = source.targetName ?? '__source__'
      const cacheKey = `fragments:summary:target:${targetKey}`
      const cached = await source.cache.get<FragmentSummary[]>(cacheKey)
      if (cached) return c.json(cached, 200)
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
      return c.json(fragments, 200)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([], 200)
      throw err
    }
  })

  // POST delegates to `fragments/create.ts` — same protocol-thin
  // shape as pages POST.
  const createFragmentRoute = createRoute({
    method: 'post',
    path: '/fragments',
    summary: 'Create a fragment',
    middleware: [requireCapability('edit:fragments'), editableTarget] as const,
    request: {
      query: OnConflictQuerySchema,
      body: { required: true, content: { 'application/json': { schema: CreateFragmentRequestSchema } } },
    },
    responses: {
      200: json(CreatedFragmentResponseSchema, 'Created, or an archived fragment resolved by `onConflict`'),
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
    createFragmentRoute,
    async c => {
      const { target, onConflict } = c.req.valid('query')
      const source = await resolve(target)
      // Body validated against `CreateFragmentRequestSchema` — same rationale as pages.ts.
      const body = c.req.valid('json')

      const result = await createFragment({
        name: body.name,
        template: body.template,
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
        return problem(c, 409, 'LIVE_CONFLICT', `Fragment "${result.name}" already exists`)
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

  const getFragment = createRoute({
    method: 'get',
    path: '/fragments/:name',
    summary: 'Read a fragment',
    middleware: [requireCapability('read:fragments')] as const,
    request: { params: ItemNameParamSchema, query: ItemLocaleQuerySchema, headers: RequestIdHeaderSchema },
    responses: {
      200: json(FragmentDetailSchema, 'The fragment, or its locale variant; ETag is its save version'),
      ...problems({ 400: ['BAD_REQUEST'], 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 404: ['NOT_FOUND'] }),
    },
  })
  app.openapi(getFragment, async c => {
    const { name } = c.req.valid('param')
    const { target, locale: rawLocale } = c.req.valid('query')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return problem(c, 400, 'BAD_REQUEST', `Invalid locale code: "${rawLocale}"`)
    const source = await resolve(target)
    const site = await loadSiteFromSource(source)

    let fragment = site.fragments.get(name)
    if (locale) {
      const localeEntry = site.fragmentLocales.get(name)
      const localeVariant = localeEntry?.locales.get(locale)
      if (localeVariant) fragment = localeVariant
      else if (!fragment) return problem(c, 404, 'NOT_FOUND', `Fragment "${name}" locale "${locale}" not found`)
    }
    if (!fragment) return problem(c, 404, 'NOT_FOUND', `Fragment "${name}" not found`)

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
        requestId: c.req.valid('header')['x-request-id'] ?? crypto.randomUUID(),
        site: { name: source.manifest?.name },
        auditEmit: makeAuditFiringEmitter(c.var.audit),
      })
      body = await dispatchAfterLoad(hooks, { kind: 'fragment', name, locale: locale ?? undefined }, body, ctx)
    }
    return c.json(body as FragmentDetail, 200)
  })

  // PUT delegates to `fragments/save.ts` — the spine lives in
  // `manifest-save.ts` (per Cut 2). This handler is now a protocol
  // translator: parse Hono request → call `saveFragment` → project
  // `SaveResult` to HTTP. Same response shape as before.
  const saveFragmentRoute = createRoute({
    method: 'put',
    path: '/fragments/:name',
    summary: 'Save a fragment',
    middleware: [requireCapability('edit:fragments'), editableTarget] as const,
    request: {
      params: ItemNameParamSchema,
      query: ItemLocaleQuerySchema,
      headers: SaveHeadersSchema,
      body: { required: true, content: { 'application/json': { schema: SaveFragmentRequestSchema } } },
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
  app.openapi(saveFragmentRoute, async c => {
    const { name } = c.req.valid('param')
    const { target, locale: rawLocale } = c.req.valid('query')
    const headers = c.req.valid('header')

    const source = await resolve(target)
    const site = await loadSiteFromSource(source, { templatesDir })

    // RFC-7232 If-Match is quoted; normalize before passing through.
    const ifMatch = headers['if-match']?.replace(/^"(.*)"$/, '$1')

    const body = c.req.valid('json') as Partial<FragmentManifest> & Record<string, unknown>

    let result
    try {
      result = await saveFragment({
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
    } catch (err: unknown) {
      if (err instanceof InvalidLocaleError) return problem(c, 400, 'BAD_REQUEST', err.message)
      if (err instanceof FragmentNotFoundError) return problem(c, 404, 'NOT_FOUND', err.message)
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
      // (#1393); same projection as the page save route.
      return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; save refused (strict mode)')
    }
    // HOOK_CANCELLED — exhaustive narrow per Q1 lock.
    return problem(c, 409, 'HOOK_CANCELLED', undefined, { hook: result.hook, reason: result.reason })
  })

  // DELETE = soft-delete (archive) by default per Cut 7 cutover.
  // `?permanent=true` invokes purge for explicit hard-delete intent.
  // See pages.ts for the full rationale; same shape applies here.
  const deleteFragment = createRoute({
    method: 'delete',
    path: '/fragments/:name',
    summary: 'Archive a fragment, or delete it with `permanent=true`',
    middleware: [requireCapability('delete:fragments'), editableTarget, jsonBody({ optional: true })] as const,
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
    deleteFragment,
    async c => {
      const { name } = c.req.valid('param')
      const { target, force, permanent } = c.req.valid('query')
      if (permanent === 'true') {
        return handlePurge(c, resolve, FRAGMENT_HANDLE, { name, target, force: force === 'true' }, null, {
          allowLive: true,
        })
      }
      const { aliasOf } = c.req.valid('json')
      return handleArchive(c, resolve, FRAGMENT_HANDLE, { name, target, force: force === 'true', aliasOf })
    },
    bodyFailure('BAD_REQUEST', 'Invalid request body'),
  )

  return app
}
