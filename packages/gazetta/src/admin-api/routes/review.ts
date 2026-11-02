/**
 * Review workflow routes (design-review-workflow.md cut 7, #521):
 *
 *   POST /api/review/{page|fragment}/:name/{submit|approve|reject|withdraw}
 *   GET  /api/review/{page|fragment}/:name
 *
 * Each POST asks the state machine (`review/state-machine.ts`) whether
 * the transition is allowed, records the attempt in the audit log, and
 * writes the new state to the item's review sidecars on the source
 * target. The state machine decides; this module only reads the state
 * in and writes it out.
 *
 * One review state per page or fragment, covering its translations, so
 * the routes take no locale (2026-10-25 item 8). Policy comes from
 * `resolveSaveReviewPolicy`, as saves resolve it.
 *
 * Submit writes the pending marker
 * `.gazetta/review/pending/{kind}/{name}`; approve (threshold met),
 * reject and withdraw remove it (item 9). The pending-review queue
 * (cut 17) lists those markers.
 *
 * POSTs check the capability first, then the editable target, so a
 * missing capability answers 403 whatever the target, and review state
 * is never written to a read-only or public target
 * (design-public-storage.md Q5).
 */
import { createRoute } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { AuditEvent } from '../../audit/types.js'
import type { AuditProvider } from '../../audit/provider.js'
import { buildReviewAuditEvent } from '../../review/audit.js'
import { resolveSaveReviewPolicy } from '../../review/save-gate.js'
import {
  clearReviewSidecar,
  readApprovers,
  readReviewSidecar,
  type ReviewStateKind,
  writeApproverSidecar,
  writePendingMarker,
  writeReviewSidecar,
  removePendingMarker,
} from '../../review/sidecars.js'
import { transition } from '../../review/state-machine.js'
import type { ReviewAction, ReviewSidecar, ReviewStateSnapshot, ReviewTransitionError } from '../../review/types.js'
import { lookupManifest } from '../lookup-manifest.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import type { AuditEnv } from '../middleware/audit.js'
import { apiApp, json, problems } from '../openapi.js'
import { problem, type ProblemResponse } from '../problem.js'
import { bodyFailure, jsonBody } from '../route-input.js'
import type { AuditEventWire } from '../schemas/audit.js'
import type { ErrorCode } from '../schemas/error.js'
import { ItemNameParamSchema, TargetQuerySchema } from '../schemas/item-route.js'
import {
  type ReviewDetail,
  ReviewDetailSchema,
  ReviewRejectRequestSchema,
  type ReviewStatus,
  ReviewStatusSchema,
} from '../schemas/review.js'
import type { SourceContext, SourceContextResolver } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'

export interface ReviewRoutesOptions {
  /** Configured audit providers; the GET's history queries them. */
  auditProviders?: ReadonlyArray<AuditProvider>
}

/** Enough history for any one item; the audit query's own ceiling. */
const HISTORY_LIMIT = 1000

type Transition = Exclude<ReviewAction['kind'], 'invalidate'>

const ERROR_STATUS: Record<ReviewTransitionError['code'], { status: 400 | 403 | 409; code: ErrorCode }> = {
  forbidden: { status: 403, code: 'FORBIDDEN' },
  'not-submitter': { status: 403, code: 'NOT_SUBMITTER' },
  'invalid-transition': { status: 409, code: 'INVALID_TRANSITION' },
  'already-voted': { status: 409, code: 'ALREADY_VOTED' },
  disabled: { status: 409, code: 'REVIEW_DISABLED' },
  'comment-required': { status: 400, code: 'COMMENT_REQUIRED' },
}

const TRANSITION_PROBLEMS = {
  400: ['BAD_REQUEST', 'COMMENT_REQUIRED'],
  401: ['UNAUTHENTICATED'],
  403: ['FORBIDDEN', 'NOT_SUBMITTER', 'TARGET_NOT_EDITABLE'],
  404: ['NOT_FOUND'],
  409: ['INVALID_TRANSITION', 'ALREADY_VOTED', 'REVIEW_DISABLED'],
  415: ['BAD_REQUEST'],
  500: ['AUDIT_FAILED'],
} as const satisfies Record<number, readonly ErrorCode[]>

const CAPABILITY: Record<Transition, 'review:submit' | 'review:approve'> = {
  submit: 'review:submit',
  approve: 'review:approve',
  reject: 'review:approve',
  withdraw: 'review:submit',
}

export function reviewRoutes(resolve: SourceContextResolver, opts: ReviewRoutesOptions = {}) {
  const app = apiApp<AuditEnv>()
  const editableTarget = requireEditableTarget(resolve)
  const providers = opts.auditProviders ?? []

  for (const kind of ['page', 'fragment'] as const) {
    const label = kind
    for (const action of ['submit', 'approve', 'withdraw'] as const) {
      const route = createRoute({
        method: 'post',
        path: `/review/${kind}/:name/${action}`,
        summary: `${action[0].toUpperCase()}${action.slice(1)} a ${label}'s review`,
        middleware: [requireCapability(CAPABILITY[action]), editableTarget] as const,
        request: { params: ItemNameParamSchema, query: TargetQuerySchema },
        responses: {
          200: json(ReviewStatusSchema, 'The review state after the transition'),
          ...problems(TRANSITION_PROBLEMS),
        },
      })
      app.openapi(route, c => {
        const { name } = c.req.valid('param')
        const { target } = c.req.valid('query')
        return handleTransition(c, resolve, kind, name, target, { kind: action })
      })
    }

    const reject = createRoute({
      method: 'post',
      path: `/review/${kind}/:name/reject`,
      summary: `Reject a ${label}'s review, with a comment`,
      middleware: [
        requireCapability(CAPABILITY.reject),
        editableTarget,
        jsonBody({ malformed: { code: 'BAD_REQUEST', detail: 'Invalid JSON body' } }),
      ] as const,
      request: {
        params: ItemNameParamSchema,
        query: TargetQuerySchema,
        body: { required: true, content: { 'application/json': { schema: ReviewRejectRequestSchema } } },
      },
      responses: {
        200: json(ReviewStatusSchema, 'The review state after the transition'),
        ...problems(TRANSITION_PROBLEMS),
      },
    })
    app.openapi(
      reject,
      c => {
        const { name } = c.req.valid('param')
        const { target } = c.req.valid('query')
        const { comment } = c.req.valid('json')
        return handleTransition(c, resolve, kind, name, target, { kind: 'reject', comment: comment ?? '' })
      },
      bodyFailure('BAD_REQUEST', 'Invalid request body'),
    )

    const get = createRoute({
      method: 'get',
      path: `/review/${kind}/:name`,
      summary: `A ${label}'s review state, approvers and review history`,
      middleware: [requireCapability(`read:${kind}s`)] as const,
      request: { params: ItemNameParamSchema, query: TargetQuerySchema },
      responses: {
        200: json(ReviewDetailSchema, 'State, approvers and review events, newest first'),
        ...problems({ 400: ['BAD_REQUEST'], 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 404: ['NOT_FOUND'] }),
      },
    })
    app.openapi(get, async c => {
      const { name } = c.req.valid('param')
      const { target } = c.req.valid('query')
      const found = await findItem(c, resolve, kind, name, target)
      if ('response' in found) return found.response
      const status = await readStatus(found.source, kind, name)
      const body: ReviewDetail = {
        ...status,
        history: (await reviewHistory(providers, kind, name)) as AuditEventWire[],
      }
      return c.json(body, 200)
    })
  }

  return app
}

type Found = { source: SourceContext } | { response: ProblemResponse<400 | 404> }

/** The item must exist on the source; its name must be encodable as a sidecar path. */
async function findItem(
  c: Context<AuditEnv, any, any>,
  resolve: SourceContextResolver,
  kind: ReviewStateKind,
  name: string,
  target: string | undefined,
): Promise<Found> {
  // Dots are reserved in sidecar names (`encodeRefName`).
  if (name.includes('.')) {
    return { response: problem(c, 400, 'BAD_REQUEST', `Invalid ${kind} name "${name}"`) }
  }
  const source = await resolve(target)
  const site = await loadSiteFromSource(source)
  if (!lookupManifest(site, kind, name)) {
    const label = kind === 'page' ? 'Page' : 'Fragment'
    return { response: problem(c, 404, 'NOT_FOUND', `${label} "${name}" not found`) }
  }
  return { source }
}

async function handleTransition(
  c: Context<AuditEnv, any, any>,
  resolve: SourceContextResolver,
  kind: ReviewStateKind,
  name: string,
  target: string | undefined,
  action: ReviewAction,
) {
  const found = await findItem(c, resolve, kind, name, target)
  if ('response' in found) return found.response
  const { source } = found
  const root = source.contentRoot

  const sidecar = await readReviewSidecar(root, kind, name)
  const snapshot = await snapshotOf(source, kind, name, sidecar)
  const config = resolveSaveReviewPolicy(source.manifest, source.targetName) ?? { enabled: false }
  const principal = c.var.principal
  const result = transition(snapshot, action, principal, config)
  const event = buildReviewAuditEvent({ action, result, scope: { kind, name } })

  if (!result.ok) {
    if (event) await c.var.audit.record(event)
    const { status, code } = ERROR_STATUS[result.error.code]
    return problem(c, status, code, result.error.reason)
  }

  // Strict audit (#1393): the event is recorded before anything is
  // written, and a failed record refuses the transition.
  const strict = c.var.audit.strict
  if (strict && event && (await c.var.audit.record(event)).failed > 0) {
    return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; transition refused (strict mode)')
  }
  try {
    await persist(source, kind, name, action, sidecar, result.next, principal.id)
  } catch (err) {
    if (strict && event) await c.var.audit.record({ ...event, outcome: 'write-failed' })
    throw err
  }
  if (!strict && event) await c.var.audit.record(event)

  return c.json(await readStatus(source, kind, name), 200)
}

/** The state machine's view of the stored state. */
async function snapshotOf(
  source: SourceContext,
  kind: ReviewStateKind,
  name: string,
  sidecar: ReviewSidecar | null,
): Promise<ReviewStateSnapshot> {
  if (!sidecar || sidecar.state === 'draft') return { state: 'draft' }
  const approvers = await readApprovers(source.contentRoot, kind, name)
  const submitter = sidecar.submitter ?? ''
  if (sidecar.state === 'approved') return { state: 'approved', submitter, approvers }
  return { state: 'pending-review', submitter, approvers, requiredApprovers: sidecar.requiredApprovers ?? 1 }
}

/** Write what the transition changed. */
async function persist(
  source: SourceContext,
  kind: ReviewStateKind,
  name: string,
  action: ReviewAction,
  previous: ReviewSidecar | null,
  next: ReviewStateSnapshot,
  actorId: string,
): Promise<void> {
  const root = source.contentRoot
  const now = new Date().toISOString()
  if (next.state === 'draft') {
    // Reject and withdraw: back to draft, votes and marker gone.
    await clearReviewSidecar(root, kind, name)
    return
  }
  if (action.kind === 'submit' && next.state === 'pending-review') {
    await writeReviewSidecar(root, kind, name, {
      state: 'pending-review',
      submitter: next.submitter,
      requiredApprovers: next.requiredApprovers,
      submittedAt: now,
      updatedAt: now,
    })
    await writePendingMarker(root, kind, name)
    return
  }
  if (action.kind === 'approve') {
    await writeApproverSidecar(root, kind, name, actorId)
    if (next.state === 'approved') {
      await writeReviewSidecar(root, kind, name, {
        state: 'approved',
        submitter: next.submitter,
        requiredApprovers: previous?.requiredApprovers,
        submittedAt: previous?.submittedAt,
        approvedAt: now,
        updatedAt: now,
      })
      await removePendingMarker(root, kind, name)
    }
  }
}

async function readStatus(source: SourceContext, kind: ReviewStateKind, name: string): Promise<ReviewStatus> {
  const sidecar = await readReviewSidecar(source.contentRoot, kind, name)
  if (!sidecar || sidecar.state === 'draft') return { kind, name, state: 'draft', approvers: [] }
  return {
    kind,
    name,
    state: sidecar.state,
    ...(sidecar.submitter !== undefined ? { submitter: sidecar.submitter } : {}),
    ...(sidecar.requiredApprovers !== undefined ? { requiredApprovers: sidecar.requiredApprovers } : {}),
    approvers: await readApprovers(source.contentRoot, kind, name),
    ...(sidecar.submittedAt ? { submittedAt: sidecar.submittedAt } : {}),
    ...(sidecar.approvedAt ? { approvedAt: sidecar.approvedAt } : {}),
  }
}

/**
 * The item's review events: one audit query per queryable provider,
 * keeping the `review-*` actions, in the order the provider returns
 * them (newest first, same-millisecond events included, #1244). Not
 * re-sorted and not de-duplicated: two real events can share a
 * timestamp, actor and action (#1245).
 */
async function reviewHistory(
  providers: ReadonlyArray<AuditProvider>,
  kind: ReviewStateKind,
  name: string,
): Promise<AuditEvent[]> {
  const history: AuditEvent[] = []
  for (const provider of providers) {
    if (typeof provider.query !== 'function') continue
    let events: AuditEvent[]
    try {
      events = await provider.query({ scope: { kind, name }, limit: HISTORY_LIMIT })
    } catch {
      // Fail-open, as the audit route: no history rather than no state.
      continue
    }
    for (const event of events) if (event.action.startsWith('review-')) history.push(event)
  }
  return history
}
