/**
 * Build the audit-event input shape for a review-workflow transition.
 *
 * Per `design-review-workflow.md` "Audit event shape" + the locked
 * recording-site discipline in `design-audit.md` ("the layer that
 * produced the outcome records its own event"): the FSM in
 * `state-machine.ts` is pure — it returns the next snapshot or a
 * typed error. This module turns that `(action, result, scope)`
 * triple into the `RecordEventInput` the route handler hands to
 * `c.var.audit.record(...)`.
 *
 * # Why a separate module, not bolted onto the FSM
 *
 *   - SRP — the FSM stays pure (no audit knowledge, no I/O); this
 *     module owns the FSM-error → audit-outcome mapping.
 *   - LSP — `transition` returns the same `ReviewTransitionResult`
 *     whether or not audit is wired; consumers without audit (CLI,
 *     unit tests) don't pull this surface.
 *   - DIP — the route handler (Cut 7) depends on this helper's
 *     `RecordEventInput` shape, not on the FSM's error vocabulary.
 *     When `ReviewTransitionError` gains a new code, the mapping
 *     update lives in one place.
 *
 * # The outcome map
 *
 * `forbidden` and `not-submitter` are authorization failures — the
 * actor lacked the right to do this. They map to audit
 * `outcome: 'forbidden'` (matches design-audit.md "Forbidden-event
 * scope visibility" shape).
 *
 * `invalid-transition` / `comment-required` / `already-voted` /
 * `disabled` are request-shape failures — the FSM rejected the
 * attempt because it doesn't fit the current state or the supplied
 * payload is malformed. They map to `outcome: 'validation-failed'`
 * (matches save-handler validation rejection per design-audit.md
 * Q1 lock).
 *
 * # Reject comment
 *
 * Per the locked "single reject action with mandatory comment"
 * invariant, every successful reject carries a non-empty comment in
 * `metadata.comment`. On failure paths where the actor still supplied
 * a non-empty comment (e.g. self-approval denial mid-rejection), the
 * comment is preserved in metadata too — forensic record of what
 * was attempted, not just that it was attempted. Empty / whitespace
 * comments are excluded (those are the `comment-required` rejection
 * case; an empty string in metadata would be noise).
 *
 * # Invalidate action
 *
 * The FSM accepts an `invalidate` action representing the save
 * handler's "this save modified content; recompute the review state
 * per `invalidateOnSave` policy." That isn't a user-initiated review
 * transition; the user's save already emitted `action: 'save'`. So
 * this helper returns `null` for invalidate — the route handler
 * skips audit emission, no duplicate event.
 */
import type { AuditAction, AuditOutcome, AuditScope } from '../audit/types.js'
import type { RecordEventInput } from '../audit/context.js'
import type { ReviewAction, ReviewTransitionError, ReviewTransitionResult } from './types.js'

/**
 * Map each user-initiated review action to its audit verb. The
 * `invalidate` action is internal (not user-initiated) and omitted
 * from this map; the helper short-circuits before lookup.
 */
const REVIEW_AUDIT_ACTION: Record<Exclude<ReviewAction['kind'], 'invalidate'>, AuditAction> = {
  submit: 'review-submit',
  approve: 'review-approve',
  reject: 'review-reject',
  withdraw: 'review-withdraw',
}

export interface BuildReviewAuditEventInput {
  /** The action the actor attempted. */
  action: ReviewAction
  /** Result returned by `transition(snapshot, action, principal, config)`. */
  result: ReviewTransitionResult
  /** What was acted on — `{ kind: 'page' | 'fragment', name }`. */
  scope: AuditScope
}

/**
 * Build the audit-event input for a review transition attempt.
 * Returns `null` for the `invalidate` action (not user-driven; no
 * audit event needed — the originating save already audited).
 *
 * Recording layer call site (Cut 7):
 *
 *     const result = transition(snapshot, action, principal, config)
 *     const event = buildReviewAuditEvent({ action, result, scope })
 *     if (event !== null) await c.var.audit.record(event)
 *     // ... return result.ok ? next : error to the client ...
 */
export function buildReviewAuditEvent(input: BuildReviewAuditEventInput): RecordEventInput | null {
  if (input.action.kind === 'invalidate') return null
  const auditAction = REVIEW_AUDIT_ACTION[input.action.kind]

  if (input.result.ok) {
    if (input.action.kind === 'reject') {
      return {
        action: auditAction,
        outcome: 'success',
        scope: input.scope,
        metadata: { comment: input.action.comment },
      }
    }
    return {
      action: auditAction,
      outcome: 'success',
      scope: input.scope,
    }
  }

  const error = input.result.error
  const outcome: AuditOutcome = isAuthorizationCode(error.code) ? 'forbidden' : 'validation-failed'
  const metadata: Record<string, unknown> = {
    code: error.code,
    reason: error.reason,
  }
  if (error.code === 'forbidden' && error.missingCapability) {
    metadata.missingCapability = error.missingCapability
  }
  if (input.action.kind === 'reject' && input.action.comment.trim().length > 0) {
    metadata.comment = input.action.comment
  }
  return {
    action: auditAction,
    outcome,
    scope: input.scope,
    metadata,
  }
}

function isAuthorizationCode(code: ReviewTransitionError['code']): boolean {
  return code === 'forbidden' || code === 'not-submitter'
}
