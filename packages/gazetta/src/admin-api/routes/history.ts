/**
 * History endpoints.
 *
 * GET  /api/history?target=<name>              List revisions, newest first.
 * POST /api/history/undo?target=<name>         Restore the revision just before
 *                                              head — the "undo last write"
 *                                              affordance surfaced in the admin
 *                                              toolbar. Records a forward
 *                                              'rollback' revision.
 * POST /api/history/restore?target=<name>&id=<rev>
 *                                              Restore an arbitrary revision,
 *                                              used by the (future) history
 *                                              panel's per-row Restore button.
 *
 * Every write path routes through `restoreRevision` in core — soft undo
 * only, forward-only history, operation='rollback' on the new
 * revision. Route here just glues HTTP to the core.
 */

import { createRoute } from '@hono/zod-openapi'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { isHistoryEnabled, getHistoryRetention } from '../../types.js'
import { createHistoryProvider } from '../../history-provider.js'
import { restoreRevision } from '../../history-restorer.js'
import { createContentRoot } from '../../content-root.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import type { AuditEnv } from '../middleware/audit.js'
import { problem, problemFrom } from '../problem.js'
import type { ErrorCode } from '../schemas/error.js'
import { apiApp, json, problems } from '../openapi.js'
import {
  HistoryListQuerySchema,
  HistoryRestoreQuerySchema,
  HistoryUndoQuerySchema,
  ListHistoryResponseSchema,
  RestoreRevisionResponseSchema,
} from '../schemas/history.js'

const listHistory = createRoute({
  method: 'get',
  path: '/history',
  summary: "A target's revisions, newest first",
  middleware: [requireCapability('read:pages')] as const,
  request: { query: HistoryListQuerySchema },
  responses: {
    200: json(ListHistoryResponseSchema, 'The revisions'),
    ...problems({ 400: ['BAD_REQUEST'], 403: ['FORBIDDEN'], 409: ['CONFLICT'] }),
  },
})

const undoHistory = createRoute({
  method: 'post',
  path: '/history/undo',
  summary: 'Restore the revision before the latest one',
  middleware: [requireCapability('restore:history')] as const,
  request: { query: HistoryUndoQuerySchema },
  responses: {
    200: json(RestoreRevisionResponseSchema, 'The new revision'),
    ...problems({ 400: ['BAD_REQUEST'], 403: ['FORBIDDEN'], 409: ['CONFLICT'] }),
  },
})

const restoreHistory = createRoute({
  method: 'post',
  path: '/history/restore',
  summary: 'Restore a revision',
  middleware: [requireCapability('restore:history')] as const,
  request: { query: HistoryRestoreQuerySchema },
  responses: {
    200: json(RestoreRevisionResponseSchema, 'The new revision'),
    ...problems({ 400: ['BAD_REQUEST'], 403: ['FORBIDDEN'], 404: ['NOT_FOUND'], 409: ['CONFLICT'] }),
  },
})

export function historyRoutes(
  resolve: SourceContextResolver,
  preInitTargets?: Map<string, StorageProvider>,
  targetConfigs?: Record<string, TargetConfig>,
) {
  const app = apiApp<AuditEnv>()

  let targets: Map<string, StorageProvider> | null = preInitTargets ?? null
  let targetsInitPromise: Promise<Map<string, StorageProvider>> | null = null

  /**
   * Lazily build the cross-target registry on first call. Mirrors the
   * pattern in publish.ts / compare.ts — the dev bootstrap pre-inits
   * only the editable local target for startup speed; history endpoints
   * can target any configured target (e.g. undo a publish on staging),
   * so we lazy-init here on first use.
   */
  async function getTargets(projectSiteDir: string): Promise<Map<string, StorageProvider>> {
    if (targets) return targets
    if (!targetConfigs || Object.keys(targetConfigs).length === 0) {
      targets = new Map()
      return targets
    }
    // Assigned before any await so concurrent first requests share one init.
    if (!targetsInitPromise) {
      const configs = targetConfigs
      targetsInitPromise = import('../../targets.js')
        .then(({ createTargetRegistry }) => createTargetRegistry(configs))
        .then(t => {
          targets = t
          return t
        })
        .catch(() => {
          targets = new Map()
          return new Map()
        })
    }
    return targetsInitPromise
  }

  type ResolveResult =
    | {
        kind: 'ok'
        storage: StorageProvider
        config: TargetConfig
        history: ReturnType<typeof createHistoryProvider>
        contentRoot: ReturnType<typeof createContentRoot>
      }
    | { kind: 'err'; status: 400 | 409; body: { code: ErrorCode; message: string } }

  /**
   * Resolve the target + config + history provider for this request.
   * Returns an error object when the target isn't valid or has
   * history disabled — callers pass the result through `respond`.
   */
  async function resolveHistory(targetName: string, projectSiteDir: string): Promise<ResolveResult> {
    if (!targetName) {
      return { kind: 'err', status: 400, body: { code: 'BAD_REQUEST', message: 'Missing "target" query parameter' } }
    }
    const t = await getTargets(projectSiteDir)
    const storage = t.get(targetName)
    const config = targetConfigs?.[targetName]
    if (!storage || !config) {
      return { kind: 'err', status: 400, body: { code: 'BAD_REQUEST', message: `Unknown target: ${targetName}` } }
    }
    if (!isHistoryEnabled(config)) {
      return {
        kind: 'err',
        status: 409,
        body: { code: 'CONFLICT', message: `History disabled for target "${targetName}"` },
      }
    }
    const history = createHistoryProvider({ storage, retention: getHistoryRetention(config) })
    const contentRoot = createContentRoot(storage)
    return { kind: 'ok', storage, config, history, contentRoot }
  }

  app.openapi(listHistory, async c => {
    const query = c.req.valid('query')
    const source = await resolve(query.source)
    const targetName = query.target
    if (!targetName) return problem(c, 400, 'BAD_REQUEST', 'Missing "target" query parameter')
    const resolved = await resolveHistory(targetName, source.projectSiteDir)
    if (resolved.kind === 'err') return problemFrom(c, resolved.status, resolved.body)
    const limit = Number(query.limit ?? '50')
    const revisions = await resolved.history.listRevisions(limit)
    return c.json({ revisions }, 200)
  })

  app.openapi(undoHistory, async c => {
    const query = c.req.valid('query')
    const source = await resolve(query.source)
    const targetName = query.target
    if (!targetName) return problem(c, 400, 'BAD_REQUEST', 'Missing "target" query parameter')
    const resolved = await resolveHistory(targetName, source.projectSiteDir)
    if (resolved.kind === 'err') return problemFrom(c, resolved.status, resolved.body)
    const { history, contentRoot } = resolved

    // Undo = restore the revision just before head. Needs at least
    // two revisions — one current + one to roll back to. No-op (with
    // a clear 409) otherwise.
    const list = await history.listRevisions(2)
    if (list.length < 2) {
      return problem(c, 409, 'CONFLICT', 'Nothing to undo — no prior revision on this target')
    }
    const restored = await restoreRevision({
      history,
      contentRoot,
      revisionId: list[1].id,
      message: `Undo ${list[0].operation} (rev ${list[0].id})`,
    })
    // Restoring on the source target rewrites the manifests we summarize
    // through `/api/pages` and `/api/fragments`. Other targets share no
    // cache with this source so they're untouched.
    if (targetName === source.targetName) {
      await Promise.all([source.cache.invalidatePrefix('pages:'), source.cache.invalidatePrefix('fragments:')])
    }
    await c.var.audit.record({
      action: 'restore',
      outcome: 'success',
      scope: { kind: 'site' },
      metadata: { targetName, restoredFrom: list[1].id, undoneOperation: list[0].operation },
    })
    return c.json({ revision: restored, restoredFrom: list[1].id }, 200)
  })

  app.openapi(restoreHistory, async c => {
    const query = c.req.valid('query')
    const source = await resolve(query.source)
    const targetName = query.target
    const revisionId = query.id
    if (!targetName) return problem(c, 400, 'BAD_REQUEST', 'Missing "target" query parameter')
    if (!revisionId) return problem(c, 400, 'BAD_REQUEST', 'Missing "id" query parameter')
    const resolved = await resolveHistory(targetName, source.projectSiteDir)
    if (resolved.kind === 'err') return problemFrom(c, resolved.status, resolved.body)
    const { history, contentRoot } = resolved

    try {
      const restored = await restoreRevision({
        history,
        contentRoot,
        revisionId,
        message: `Rollback to ${revisionId}`,
      })
      if (targetName === source.targetName) {
        await Promise.all([source.cache.invalidatePrefix('pages:'), source.cache.invalidatePrefix('fragments:')])
      }
      await c.var.audit.record({
        action: 'restore',
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { targetName, restoredFrom: revisionId },
      })
      return c.json({ revision: restored, restoredFrom: revisionId }, 200)
    } catch (err) {
      // readRevision throws ENOENT-style errors when the id doesn't
      // exist — treat as a 404 so clients can render a helpful message.
      return problem(c, 404, 'NOT_FOUND', (err as Error).message)
    }
  })

  return app
}
