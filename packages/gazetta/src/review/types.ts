/**
 * Review state-machine types.
 *
 * The state machine itself (`transition`) is a pure function over
 * (snapshot, action, principal, config). I/O — sidecar reads, audit
 * writes, hook firings — lives at the caller; the FSM only computes
 * the next state or the rejection reason.
 *
 * Per design-review-workflow.md "Locked invariants":
 *   - Three content states: draft → pending-review → approved.
 *   - `requiredApprovers` snapshotted at submit time (lives on the
 *     pending-review snapshot, not re-read from config at approve
 *     time).
 *   - `allowSelfApproval: false` blocks the submitter from BOTH
 *     approving and rejecting their own submission — the escape is
 *     withdraw.
 *   - Single reject action with mandatory comment.
 *   - Edit during pending-review locks at the save handler; the FSM
 *     models invalidate as approved → draft per `invalidateOnSave`
 *     policy and treats invalidate from any non-approved state as a
 *     no-op (the save handler may call defensively).
 */
import type { Principal } from '../auth/types.js'
import type { ReviewWorkflowConfig } from '../types.js'

export type ReviewState = 'draft' | 'pending-review' | 'approved'

/**
 * The minimum content-state context the FSM needs. The submitter
 * identity is carried because self-approval + withdraw decisions
 * need it; the approvers list is carried because the per-approver
 * threshold check is the only multi-step state in the machine.
 */
export type ReviewStateSnapshot =
  | { state: 'draft' }
  | {
      state: 'pending-review'
      submitter: string
      approvers: ReadonlyArray<string>
      requiredApprovers: number
    }
  | {
      state: 'approved'
      submitter: string
      approvers: ReadonlyArray<string>
    }

export type ReviewAction =
  | { kind: 'submit' }
  | { kind: 'approve' }
  | { kind: 'reject'; comment: string }
  | { kind: 'withdraw' }
  | { kind: 'invalidate'; contentDiffers: boolean }

/**
 * Closed-enum failure codes. Callers map them to HTTP status:
 *   - forbidden → 403
 *   - disabled → 409 (review workflow off on this scope)
 *   - invalid-transition → 409
 *   - comment-required → 400
 *   - already-voted → 409
 *   - not-submitter → 403
 */
export type ReviewTransitionError =
  | { code: 'forbidden'; reason: string; missingCapability?: string }
  | { code: 'invalid-transition'; reason: string }
  | { code: 'comment-required'; reason: string }
  | { code: 'already-voted'; reason: string }
  | { code: 'not-submitter'; reason: string }
  | { code: 'disabled'; reason: string }

export type ReviewTransitionResult =
  | { ok: true; next: ReviewStateSnapshot }
  | { ok: false; error: ReviewTransitionError }

/**
 * Re-export the types the transition function consumes so callers
 * can import everything from `gazetta/review` without reaching into
 * auth/types or the top-level types module.
 */
export type { Principal, ReviewWorkflowConfig }
