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
 * What the review workflow operates on. Narrower than `AuditScope`
 * (which also covers assets and site config) — review workflow in v1
 * is pages + fragments only per `design-review-workflow.md`'s locked
 * invariant "Pages and fragments are reviewable in v1; assets and
 * asset-metadata defer to v2."
 */
export interface ReviewScope {
  kind: 'page' | 'fragment'
  name: string
}

/**
 * One approver's recorded vote on the current review. Timestamps the
 * vote and optionally carries a non-blocking comment. The audit log
 * is the authoritative forensic record (every approve emits an audit
 * event per `design-review-workflow.md`); this entry mirrors it on
 * the sidecar for cheap "show me who's approved + their comments"
 * lookups without a cross-system audit query.
 */
export interface ReviewApproverEntry {
  /** Actor identifier (matches `Principal.id`). */
  actor: string
  /** When the approval was recorded (ISO 8601 with Z suffix). */
  approvedAt: string
  comment?: string
}

/**
 * Persisted shape of `.gazetta/review/{kind}s/{name}/state.json`. Lives
 * next to zero-byte per-approver sidecars under `approvers/{actor-id}`;
 * the approver list is the single source of truth for threshold checks
 * (via `readDir`), the sidecar's `approvers` field mirrors it with
 * timestamps + comments for display.
 *
 * Fields are present per state:
 *   - `draft`: when returning to draft (e.g. after invalidate), the
 *     whole directory is removed, so this shape is only observed in
 *     `pending-review` or `approved` states by well-behaved callers.
 *     The type keeps the state-specific fields optional so the
 *     resolver can still parse a well-formed JSON blob and surface
 *     `state: 'draft'` without crashing on absence.
 *   - `pending-review`: `submitter`, `submittedAt`, `requiredApprovers`
 *     present; `approvers` may be empty (no votes yet).
 *   - `approved`: all of the above plus `approvedAt`.
 *
 * Concurrent-approval note: last-write-wins on this file means that
 * in a tight concurrent race, the `approvers` list may miss a
 * comment from one of the concurrent approvers. The zero-byte
 * approver sidecars are the race-free "who voted" signal; audit log
 * captures every approve attempt separately and is the authoritative
 * record for forensic queries that need every comment.
 */
export interface ReviewSidecar {
  state: ReviewState
  /** ISO 8601 with Z suffix. Updated on every state transition. */
  stateChangedAt: string
  /** Submitter identity. Present on `pending-review` and `approved`. */
  submitter?: string
  /** Submission timestamp (ISO 8601 with Z). Present on `pending-review` and `approved`. */
  submittedAt?: string
  /**
   * Approver policy snapshot at submit time. Mid-flight config
   * changes do not rewrite in-flight reviews (locked invariant from
   * `design-review-workflow.md`). Present on `pending-review` and
   * `approved`.
   */
  requiredApprovers?: number
  /** Approvers who've voted on the current review, with optional
   *  per-approver comments. Mirrors the zero-byte sidecars in
   *  `approvers/{actor-id}`. */
  approvers?: ReadonlyArray<ReviewApproverEntry>
  /** When the review reached `approved` state (ISO 8601 with Z). */
  approvedAt?: string
}

/**
 * Re-export the types the transition function consumes so callers
 * can import everything from `gazetta/review` without reaching into
 * auth/types or the top-level types module.
 */
export type { Principal, ReviewWorkflowConfig }
