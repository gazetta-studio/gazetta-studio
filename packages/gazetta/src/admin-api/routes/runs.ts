/**
 * `GET /api/v1/runs/:runId` and `POST /api/v1/runs/:runId/revert`
 * (design-agent-access.md Q48, Q50, #1730). `run-revert.ts` plans and
 * carries out the revert; this route checks rights, gives the revert its
 * own run, and wires the archive core for items the run created.
 */
import { randomBytes } from 'node:crypto'
import { createRoute } from '@hono/zod-openapi'
import type { AuditContext } from '../../audit/context.js'
import type { HookRegistry } from '../../hooks/index.js'
import { currentOrigin, runWithOrigin, originOf } from '../../request-origin.js'
import { loadRunPlan, revertRun, type ArchiveOutcome } from '../../run-revert.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import type { ValidationScanner } from '../../validation/scanner.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import type { AuditEnv } from '../middleware/audit.js'
import { denyWithoutCapability, requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import { apiApp, json, problems } from '../openapi.js'
import { problem } from '../problem.js'
import { bodyFailure, jsonBody } from '../route-input.js'
import { RequestIdHeaderSchema, TargetQuerySchema } from '../schemas/item-route.js'
import { RevertRunRequestSchema, RevertRunResponseSchema, RunParamSchema, RunResponseSchema } from '../schemas/runs.js'
import { loadSiteFromSource, type SourceContextResolver } from '../source-context.js'
import { FRAGMENT_HANDLE, handleArchive, PAGE_HANDLE } from './archive.js'

const getRun = createRoute({
  method: 'get',
  path: '/runs/:runId',
  summary: "An agent run's items, and what reverting it would do",
  middleware: [requireCapability('read:pages')] as const,
  request: { params: RunParamSchema, query: TargetQuerySchema },
  responses: {
    200: json(RunResponseSchema, "The run's items"),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 404: ['NOT_FOUND'] }),
  },
})

const revert = createRoute({
  method: 'post',
  path: '/runs/:runId/revert',
  summary: 'Revert an agent run item by item',
  description:
    "Puts each item the run changed back to its version before the run, through the single save, and archives the items it created. Items changed since the run are skipped unless named in force; items whose save or archive fails are skipped with the reason. The revert's writes form a run of their own (Gazetta-Run, or one named after the reverted run).",
  // Anyone reverting must be able to read the run; anonymous callers are
  // answered 401 before anything about the run is read.
  middleware: [requireCapability('read:pages'), jsonBody({ optional: true })] as const,
  request: {
    params: RunParamSchema,
    query: TargetQuerySchema,
    headers: RequestIdHeaderSchema,
    body: { required: false, content: { 'application/json': { schema: RevertRunRequestSchema } } },
  },
  responses: {
    200: json(RevertRunResponseSchema, 'What happened to each item'),
    ...problems({
      400: ['BAD_REQUEST'],
      401: ['UNAUTHENTICATED'],
      403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE', 'TOKEN_EDIT_ONLY'],
      404: ['NOT_FOUND'],
      415: ['BAD_REQUEST'],
    }),
  },
})

export interface RunRoutesOptions {
  hooks?: HookRegistry
  scanner?: ValidationScanner | null
}

export function runRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: RunRoutesOptions = {},
) {
  const app = apiApp<AuditEnv>()
  app.use('/runs/:runId/revert', requireEditableTarget(resolve))

  app.openapi(getRun, async c => {
    const { runId } = c.req.valid('param')
    const plan = await loadRunPlan(await resolve(c.req.valid('query').target), runId)
    if (!plan) return problem(c, 404, 'NOT_FOUND', `No run "${runId}" in this target's history`)
    return c.json(
      {
        runId,
        items: plan.map(p => ({
          item: p.item,
          kind: p.kind,
          name: p.name,
          ...(p.locale ? { locale: p.locale } : {}),
          created: p.created,
          changed: p.changed,
          restorable: p.before !== undefined,
        })),
      },
      200,
    )
  })

  app.openapi(
    revert,
    async c => {
      const { runId } = c.req.valid('param')
      const { target } = c.req.valid('query')
      const { force = [] } = c.req.valid('json') ?? {}
      const origin = currentOrigin() ?? originOf(c.var.principal)
      if (origin.runId === runId) {
        return problem(c, 400, 'BAD_REQUEST', 'A revert is a run of its own: send a different Gazetta-Run')
      }
      const revertRunId = origin.runId ?? `revert-${runId.slice(0, 50)}-${randomBytes(3).toString('hex')}`

      const source = await resolve(target)
      const plan = await loadRunPlan(source, runId)
      if (!plan) return problem(c, 404, 'NOT_FOUND', `No run "${runId}" in this target's history`)

      // Editing rights for what it saves, as editing by hand would need (Q50).
      const saved = plan.filter(p => !p.created && p.kind !== 'asset')
      for (const kind of new Set(saved.map(p => p.kind))) {
        const denied = await denyWithoutCapability(c, `edit:${kind}s`)
        if (denied) return denied as never
      }

      // Every audit event the revert causes names the run it reverts.
      const base = c.var.audit
      const audit: AuditContext = {
        strict: base.strict,
        record: event => base.record({ ...event, metadata: { ...event.metadata, revertedRun: runId } }),
      }
      c.set('audit', audit)

      const archive = async (kind: 'page' | 'fragment', name: string): Promise<ArchiveOutcome> => {
        if (await denyWithoutCapability(c, `archive:${kind}s`)) {
          return { ok: false, inUse: false, reason: `You can't archive ${kind}s` }
        }
        const res = await handleArchive(
          c,
          resolve,
          kind === 'page' ? PAGE_HANDLE : FRAGMENT_HANDLE,
          { name, target, force: false },
          opts.scanner ?? null,
        )
        if (res.status === 200) return { ok: true }
        const body = (await res.json().catch(() => ({}))) as { code?: string; detail?: string }
        return {
          ok: false,
          inUse: body.code === 'ARCHIVE_HAS_LIVE_REFS',
          reason:
            body.code === 'ARCHIVE_HAS_LIVE_REFS'
              ? 'Something else still uses it'
              : (body.detail ?? body.code ?? 'It could not be archived'),
        }
      }

      const items = await runWithOrigin({ ...origin, runId: revertRunId }, async () =>
        revertRun({
          plan,
          force,
          site: await loadSiteFromSource(source, { templatesDir }),
          source,
          principal: c.var.principal,
          audit,
          validators,
          hooks: opts.hooks,
          hookAuditEmit: makeAuditFiringEmitter(audit),
          scanner: opts.scanner ?? undefined,
          requestId: c.req.valid('header')['x-request-id'] ?? undefined,
          archive,
        }),
      )
      return c.json(
        {
          runId,
          revertRun: revertRunId,
          items: items.map(i => ({
            item: i.item,
            kind: i.kind,
            name: i.name,
            ...(i.locale ? { locale: i.locale } : {}),
            status: i.outcome.status,
            ...('reason' in i.outcome ? { reason: i.outcome.reason } : {}),
          })),
        },
        200,
      )
    },
    bodyFailure('BAD_REQUEST', 'Invalid request body'),
  )

  return app
}
