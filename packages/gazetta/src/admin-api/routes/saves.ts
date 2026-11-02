/**
 * `POST /api/v1/saves`, the bulk save (design-agent-access.md Q46, #1714):
 * an agent run's edits written all or nothing, as one history revision.
 * `bulk-save.ts` does the work; this route checks the request and turns
 * the result into a response.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { bulkSave, type BulkItemFailure, type BulkItemRef } from '../../bulk-save.js'
import { currentOrigin, RUN_ID_PATTERN } from '../../request-origin.js'
import type { HookRegistry } from '../../hooks/index.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import type { ValidationScanner } from '../../validation/scanner.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import type { AuditEnv } from '../middleware/audit.js'
import { denyWithoutCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import { apiApp, json, problems } from '../openapi.js'
import { problem } from '../problem.js'
import type { ErrorCode } from '../schemas/error.js'
import { RequestIdHeaderSchema, TargetQuerySchema } from '../schemas/item-route.js'
import { BulkSaveRequestSchema, BulkSaveResponseSchema } from '../schemas/saves.js'
import { loadSiteFromSource, type SourceContextResolver } from '../source-context.js'

/**
 * The most items one bulk save takes (Q46). 200 took 5.8 s on a local
 * filesystem, over the 5-second admin budget; 100 took 2.9 s (#1714,
 * scripts/bench-bulk-save.ts).
 */
export const BULK_SAVE_MAX_ITEMS = 100

const saveBatch = createRoute({
  method: 'post',
  path: '/saves',
  summary: 'Save several pages and fragments at once, all or nothing',
  description:
    'Every item is checked (its save-version, the save checks and beforeSave hooks) before anything is written. If one fails, nothing is written and the problem lists every failing item. Otherwise all items are written and recorded as one history revision in the run named by Gazetta-Run, which this route requires.',
  request: {
    query: TargetQuerySchema,
    headers: RequestIdHeaderSchema.extend({
      'gazetta-run': z.string().regex(RUN_ID_PATTERN).describe('The agent run these saves belong to (required here).'),
    }),
    body: { required: true, content: { 'application/json': { schema: BulkSaveRequestSchema } } },
  },
  responses: {
    200: json(BulkSaveResponseSchema, 'Every item saved; one revision records them'),
    ...problems({
      400: ['BAD_REQUEST'],
      401: ['UNAUTHENTICATED'],
      403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE', 'TOKEN_EDIT_ONLY'],
      409: ['BATCH_REFUSED'],
      413: ['BATCH_TOO_LARGE'],
      415: ['BAD_REQUEST'],
      500: ['AUDIT_FAILED', 'STORAGE_WRITE_FAILED'],
    }),
  },
})

export interface SaveRoutesOptions {
  hooks?: HookRegistry
  scanner?: ValidationScanner | null
}

export function saveRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: SaveRoutesOptions = {},
) {
  const app = apiApp<AuditEnv>()
  app.use('/saves', requireEditableTarget(resolve))

  app.openapi(saveBatch, async c => {
    const { target } = c.req.valid('query')
    const headers = c.req.valid('header')
    const { items } = c.req.valid('json')
    const runId = currentOrigin()?.runId
    if (!runId) return problem(c, 400, 'BAD_REQUEST', 'A bulk save needs a Gazetta-Run header')
    if (items.length > BULK_SAVE_MAX_ITEMS) {
      return problem(c, 413, 'BATCH_TOO_LARGE', `A bulk save takes at most ${BULK_SAVE_MAX_ITEMS} items`, {
        max: BULK_SAVE_MAX_ITEMS,
      })
    }
    const keys = items.map(i => `${i.kind}:${i.name}:${i.locale?.toLowerCase() ?? ''}`)
    const duplicate = keys.find((k, i) => keys.indexOf(k) !== i)
    if (duplicate) return problem(c, 400, 'BAD_REQUEST', `An item appears twice: ${duplicate}`)
    const create = items.find(i => i.ifNoneMatch && typeof i.manifest.template !== 'string')
    if (create) return problem(c, 400, 'BAD_REQUEST', `Creating ${create.name} needs a template`)

    // Each kind's own capability, as the single save asks (Q12).
    for (const kind of new Set(items.map(i => i.kind))) {
      const denied = await denyWithoutCapability(c, `edit:${kind}s`)
      if (denied) return denied as never
    }

    const source = await resolve(target)
    const site = await loadSiteFromSource(source, { templatesDir })
    const result = await bulkSave({
      items: items.map(i => ({
        kind: i.kind,
        name: i.name,
        ...(i.locale ? { locale: i.locale } : {}),
        manifest: i.manifest,
        ...(i.ifMatch ? { ifMatch: i.ifMatch.replace(/^"(.*)"$/, '$1') } : {}),
        create: i.ifNoneMatch === '*',
      })),
      site,
      source,
      principal: c.var.principal,
      audit: c.var.audit,
      validators,
      hooks: opts.hooks,
      hookAuditEmit: makeAuditFiringEmitter(c.var.audit),
      scanner: opts.scanner ?? undefined,
      requestId: headers['x-request-id'] ?? undefined,
    })

    if (result.ok) {
      return c.json(
        { ok: true as const, ...(result.revisionId ? { revision: result.revisionId } : {}), items: [...result.items] },
        200,
      )
    }
    if (result.code === 'CHECK_FAILED') {
      return problem(c, 409, 'BATCH_REFUSED', `${result.failures.length} of ${items.length} items can't be saved`, {
        items: result.failures.map(itemProblem),
      })
    }
    if (result.code === 'AUDIT_FAILED') {
      return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; nothing was saved (strict mode)')
    }
    return problem(c, 500, 'STORAGE_WRITE_FAILED', `Saving stopped: ${result.message}`, {
      ...(result.revisionId ? { revision: result.revisionId } : {}),
      written: result.written,
      unwritten: result.unwritten,
    })
  })

  return app
}

/** One failing item, with the code and extras its single save would answer. */
function itemProblem(f: BulkItemRef & BulkItemFailure): Record<string, unknown> {
  const ref = { index: f.index, kind: f.kind, name: f.name, ...(f.locale ? { locale: f.locale } : {}) }
  switch (f.code) {
    case 'STALE':
      return { ...ref, code: 'STALE' satisfies ErrorCode, currentEtag: f.currentEtag }
    case 'VALIDATION_FAILED':
      return { ...ref, code: 'VALIDATION_FAILED' satisfies ErrorCode, issues: f.issues }
    case 'HOOK_CANCELLED':
      return { ...ref, code: 'HOOK_CANCELLED' satisfies ErrorCode, hook: f.hook, reason: f.reason }
    case 'EXISTS':
      return { ...ref, code: 'LIVE_CONFLICT' satisfies ErrorCode, detail: f.message }
    default:
      return { ...ref, code: f.code satisfies ErrorCode, detail: f.message }
  }
}
