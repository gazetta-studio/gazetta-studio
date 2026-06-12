/**
 * Pure review-state-machine transition function.
 *
 * `transition` accepts the current snapshot, the action, the actor
 * principal, and the resolved review-workflow config; it returns
 * either the next snapshot (on success) or a typed error (on
 * rejection). It performs no I/O: callers handle sidecar reads,
 * audit emission, and hook firings.
 *
 * The function is total — every (snapshot, action, principal,
 * config) input returns a result; it never throws.
 *
 * See design-review-workflow.md "State machine details" + the
 * locked invariants for the per-transition rules; this module is
 * the executable spec.
 */
import { capabilityGrants } from '../auth/capabilities.js'
import type {
  Principal,
  ReviewAction,
  ReviewStateSnapshot,
  ReviewTransitionResult,
  ReviewWorkflowConfig,
} from './types.js'

export function transition(
  current: ReviewStateSnapshot,
  action: ReviewAction,
  principal: Principal,
  config: ReviewWorkflowConfig,
): ReviewTransitionResult {
  const enabled = config.enabled ?? false
  const allowSelfApproval = config.allowSelfApproval ?? true
  const invalidatePolicy = config.invalidateOnSave ?? 'content-diff'
  const requiredApprovers = config.requiredApprovers ?? 1

  switch (action.kind) {
    case 'submit':
      return handleSubmit(current, principal, enabled, requiredApprovers)
    case 'approve':
      return handleApprove(current, principal, allowSelfApproval)
    case 'reject':
      return handleReject(current, principal, action.comment, allowSelfApproval)
    case 'withdraw':
      return handleWithdraw(current, principal)
    case 'invalidate':
      return handleInvalidate(current, action.contentDiffers, invalidatePolicy)
  }
}

function handleSubmit(
  current: ReviewStateSnapshot,
  principal: Principal,
  enabled: boolean,
  requiredApprovers: number,
): ReviewTransitionResult {
  if (!enabled) {
    return {
      ok: false,
      error: {
        code: 'disabled',
        reason: 'Review workflow is not enabled on this scope',
      },
    }
  }
  if (current.state !== 'draft') {
    return {
      ok: false,
      error: {
        code: 'invalid-transition',
        reason: `Cannot submit from '${current.state}'; only 'draft' can be submitted`,
      },
    }
  }
  if (!capabilityGrants(principal.capabilities, 'review:submit')) {
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: "Missing capability 'review:submit'",
        missingCapability: 'review:submit',
      },
    }
  }
  return {
    ok: true,
    next: {
      state: 'pending-review',
      submitter: principal.id,
      approvers: [],
      requiredApprovers,
    },
  }
}

function handleApprove(
  current: ReviewStateSnapshot,
  principal: Principal,
  allowSelfApproval: boolean,
): ReviewTransitionResult {
  if (current.state !== 'pending-review') {
    return {
      ok: false,
      error: {
        code: 'invalid-transition',
        reason: `Cannot approve from '${current.state}'; only 'pending-review' can be approved`,
      },
    }
  }
  if (!capabilityGrants(principal.capabilities, 'review:approve')) {
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: "Missing capability 'review:approve'",
        missingCapability: 'review:approve',
      },
    }
  }
  if (!allowSelfApproval && principal.id === current.submitter) {
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: 'Self-approval is not allowed; the submitter cannot approve their own submission',
      },
    }
  }
  if (current.approvers.includes(principal.id)) {
    return {
      ok: false,
      error: {
        code: 'already-voted',
        reason: `Principal '${principal.id}' has already approved this submission`,
      },
    }
  }
  const nextApprovers: ReadonlyArray<string> = [...current.approvers, principal.id]
  if (nextApprovers.length >= current.requiredApprovers) {
    return {
      ok: true,
      next: {
        state: 'approved',
        submitter: current.submitter,
        approvers: nextApprovers,
      },
    }
  }
  return {
    ok: true,
    next: {
      state: 'pending-review',
      submitter: current.submitter,
      approvers: nextApprovers,
      requiredApprovers: current.requiredApprovers,
    },
  }
}

function handleReject(
  current: ReviewStateSnapshot,
  principal: Principal,
  comment: string,
  allowSelfApproval: boolean,
): ReviewTransitionResult {
  if (current.state !== 'pending-review') {
    return {
      ok: false,
      error: {
        code: 'invalid-transition',
        reason: `Cannot reject from '${current.state}'; only 'pending-review' can be rejected`,
      },
    }
  }
  if (!capabilityGrants(principal.capabilities, 'review:approve')) {
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: "Missing capability 'review:approve'",
        missingCapability: 'review:approve',
      },
    }
  }
  // `allowSelfApproval: false` blocks the submitter from voting on
  // their own submission in either direction — they withdraw
  // instead. Per design-review-workflow.md's interpretation that
  // the policy gates "the submitter being one of the approvers,"
  // which by symmetry includes rejecting.
  if (!allowSelfApproval && principal.id === current.submitter) {
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: 'Self-approval is not allowed; the submitter cannot reject their own submission — withdraw instead',
      },
    }
  }
  if (comment.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: 'comment-required',
        reason: 'Reject requires a non-empty comment',
      },
    }
  }
  return { ok: true, next: { state: 'draft' } }
}

function handleWithdraw(current: ReviewStateSnapshot, principal: Principal): ReviewTransitionResult {
  if (current.state !== 'pending-review') {
    return {
      ok: false,
      error: {
        code: 'invalid-transition',
        reason: `Cannot withdraw from '${current.state}'; only 'pending-review' can be withdrawn`,
      },
    }
  }
  if (principal.id !== current.submitter) {
    return {
      ok: false,
      error: {
        code: 'not-submitter',
        reason: `Only the submitter can withdraw — submitter is '${current.submitter}' but actor is '${principal.id}'`,
      },
    }
  }
  return { ok: true, next: { state: 'draft' } }
}

function handleInvalidate(
  current: ReviewStateSnapshot,
  contentDiffers: boolean,
  policy: 'content-diff' | 'always',
): ReviewTransitionResult {
  // Defensive no-op for non-approved states: save handlers may call
  // invalidate on every save regardless of current state, and the
  // FSM tolerates that by returning the input unchanged.
  if (current.state !== 'approved') {
    return { ok: true, next: current }
  }
  if (policy === 'always' || contentDiffers) {
    return { ok: true, next: { state: 'draft' } }
  }
  return { ok: true, next: current }
}
