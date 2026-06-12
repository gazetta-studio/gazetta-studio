/**
 * Cut #518 tests — review state machine (draft → pending-review → approved).
 *
 * `transition` is a pure function over (snapshot, action, principal,
 * config). It performs no I/O — these tests exercise the FSM by
 * calling it directly and asserting on the next snapshot or the
 * typed error. Per design-review-workflow.md "Locked invariants":
 *
 *   - Three content states (draft / pending-review / approved).
 *   - Explicit-action invariant — every transition is the result of
 *     a deliberate action; no time-based auto-transitions.
 *   - `requiredApprovers` snapshotted at submit time.
 *   - `allowSelfApproval: false` blocks the submitter from BOTH
 *     approving and rejecting their own submission; withdraw is the
 *     escape hatch.
 *   - Single reject action with mandatory non-empty comment.
 *   - `invalidateOnSave` ∈ {'content-diff', 'always'}; only an
 *     `approved` snapshot can be invalidated; other states are
 *     defensive no-ops.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Principal } from '../src/auth/types.js'
import {
  transition,
  type ReviewAction,
  type ReviewStateSnapshot,
  type ReviewWorkflowConfig,
} from '../src/review/index.js'

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'alice',
    role: 'editor',
    trustMode: 'none',
    capabilities: [],
    ...overrides,
  }
}

const ALICE_SUBMITTER = principal({ id: 'alice', capabilities: ['review:submit'] })
const BOB_APPROVER = principal({ id: 'bob', capabilities: ['review:approve'] })
const CAROL_APPROVER = principal({ id: 'carol', capabilities: ['review:approve'] })
const DAVE_BOTH = principal({ id: 'dave', capabilities: ['review:submit', 'review:approve'] })
const VIEWER = principal({ id: 'eve', capabilities: ['read:pages'] })

const CFG_ON: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 1,
  allowSelfApproval: true,
  invalidateOnSave: 'content-diff',
}
const CFG_OFF: ReviewWorkflowConfig = { enabled: false }
const CFG_TWO_NO_SELF: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 2,
  allowSelfApproval: false,
  invalidateOnSave: 'always',
}
const CFG_TWO_SELF_OK: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 2,
  allowSelfApproval: true,
  invalidateOnSave: 'content-diff',
}

const DRAFT: ReviewStateSnapshot = { state: 'draft' }
const PENDING = (
  partial: Partial<Extract<ReviewStateSnapshot, { state: 'pending-review' }>> = {},
): ReviewStateSnapshot => ({
  state: 'pending-review',
  submitter: 'alice',
  approvers: [],
  requiredApprovers: 1,
  ...partial,
})
const APPROVED = (partial: Partial<Extract<ReviewStateSnapshot, { state: 'approved' }>> = {}): ReviewStateSnapshot => ({
  state: 'approved',
  submitter: 'alice',
  approvers: ['bob'],
  ...partial,
})

describe('submit', () => {
  it('draft → pending-review with snapshotted requiredApprovers', () => {
    const result = transition(DRAFT, { kind: 'submit' }, ALICE_SUBMITTER, {
      ...CFG_ON,
      requiredApprovers: 2,
    })
    expect(result).toEqual({
      ok: true,
      next: {
        state: 'pending-review',
        submitter: 'alice',
        approvers: [],
        requiredApprovers: 2,
      },
    })
  })

  it('defaults requiredApprovers to 1 when config omits it', () => {
    const result = transition(DRAFT, { kind: 'submit' }, ALICE_SUBMITTER, {
      enabled: true,
    } satisfies ReviewWorkflowConfig)
    expect(result.ok && result.next.state === 'pending-review').toBe(true)
    if (result.ok && result.next.state === 'pending-review') {
      expect(result.next.requiredApprovers).toBe(1)
    }
  })

  it('forbidden when principal lacks review:submit', () => {
    const result = transition(DRAFT, { kind: 'submit' }, VIEWER, CFG_ON)
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        reason: "Missing capability 'review:submit'",
        missingCapability: 'review:submit',
      },
    })
  })

  it('disabled when reviewWorkflow.enabled is false', () => {
    const result = transition(DRAFT, { kind: 'submit' }, ALICE_SUBMITTER, CFG_OFF)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('disabled')
  })

  it('invalid-transition from pending-review', () => {
    const result = transition(PENDING(), { kind: 'submit' }, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })

  it('invalid-transition from approved', () => {
    const result = transition(APPROVED(), { kind: 'submit' }, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })

  it('admin wildcard grants review:submit', () => {
    const admin = principal({ id: 'admin', capabilities: ['*'] })
    const result = transition(DRAFT, { kind: 'submit' }, admin, CFG_ON)
    expect(result.ok).toBe(true)
  })
})

describe('approve — single-approver threshold (requiredApprovers: 1)', () => {
  it('first approve flips to approved', () => {
    const result = transition(PENDING(), { kind: 'approve' }, BOB_APPROVER, CFG_ON)
    expect(result).toEqual({
      ok: true,
      next: {
        state: 'approved',
        submitter: 'alice',
        approvers: ['bob'],
      },
    })
  })

  it('forbidden when principal lacks review:approve', () => {
    const result = transition(PENDING(), { kind: 'approve' }, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden')
      if (result.error.code === 'forbidden') {
        expect(result.error.missingCapability).toBe('review:approve')
      }
    }
  })

  it('invalid-transition from draft', () => {
    const result = transition(DRAFT, { kind: 'approve' }, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })

  it('invalid-transition from approved', () => {
    const result = transition(APPROVED(), { kind: 'approve' }, CAROL_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })
})

describe('approve — multi-approver threshold (requiredApprovers: 2)', () => {
  it('first approve stays pending-review with approver recorded', () => {
    const result = transition(PENDING({ requiredApprovers: 2 }), { kind: 'approve' }, BOB_APPROVER, CFG_TWO_SELF_OK)
    expect(result).toEqual({
      ok: true,
      next: {
        state: 'pending-review',
        submitter: 'alice',
        approvers: ['bob'],
        requiredApprovers: 2,
      },
    })
  })

  it('second approve from a different actor flips to approved', () => {
    const afterFirst = PENDING({ requiredApprovers: 2, approvers: ['bob'] })
    const result = transition(afterFirst, { kind: 'approve' }, CAROL_APPROVER, CFG_TWO_SELF_OK)
    expect(result).toEqual({
      ok: true,
      next: {
        state: 'approved',
        submitter: 'alice',
        approvers: ['bob', 'carol'],
      },
    })
  })

  it('duplicate approve from the same actor rejected as already-voted', () => {
    const afterFirst = PENDING({ requiredApprovers: 2, approvers: ['bob'] })
    const result = transition(afterFirst, { kind: 'approve' }, BOB_APPROVER, CFG_TWO_SELF_OK)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('already-voted')
  })

  it('threshold is the snapshotted value, not the live config', () => {
    // Snapshot says requiredApprovers: 2 even though config now says 1.
    // The snapshotted requirement IS the policy in effect.
    const snapshot = PENDING({ requiredApprovers: 2 })
    const result = transition(snapshot, { kind: 'approve' }, BOB_APPROVER, {
      ...CFG_ON,
      requiredApprovers: 1,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.next.state).toBe('pending-review')
  })
})

describe('approve — self-approval policy', () => {
  it('allowSelfApproval: false blocks submitter from approving own submission', () => {
    const snapshot = PENDING({
      submitter: 'dave',
      requiredApprovers: 2,
      approvers: ['bob'],
    })
    const result = transition(snapshot, { kind: 'approve' }, DAVE_BOTH, CFG_TWO_NO_SELF)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden')
      expect(result.error.reason).toContain('Self-approval')
    }
  })

  it('allowSelfApproval: true allows submitter to approve own submission', () => {
    const snapshot = PENDING({
      submitter: 'dave',
      requiredApprovers: 2,
      approvers: ['bob'],
    })
    const result = transition(snapshot, { kind: 'approve' }, DAVE_BOTH, CFG_TWO_SELF_OK)
    expect(result.ok).toBe(true)
    if (result.ok && result.next.state === 'approved') {
      expect(result.next.approvers).toEqual(['bob', 'dave'])
    }
  })

  it('non-submitter approver always allowed regardless of allowSelfApproval', () => {
    const snapshot = PENDING({ submitter: 'alice', requiredApprovers: 1 })
    const result = transition(snapshot, { kind: 'approve' }, BOB_APPROVER, CFG_TWO_NO_SELF)
    expect(result.ok).toBe(true)
  })

  it('allowSelfApproval defaults to true when config omits it', () => {
    const snapshot = PENDING({ submitter: 'dave', requiredApprovers: 1 })
    const result = transition(snapshot, { kind: 'approve' }, DAVE_BOTH, { enabled: true })
    expect(result.ok).toBe(true)
  })
})

describe('reject', () => {
  it('pending-review + reject with comment → draft', () => {
    const result = transition(PENDING(), { kind: 'reject', comment: 'Needs more detail' }, BOB_APPROVER, CFG_ON)
    expect(result).toEqual({ ok: true, next: { state: 'draft' } })
  })

  it.each([
    ['empty', ''],
    ['whitespace-only spaces', '   '],
    ['whitespace-only mixed', '   \n\t  '],
  ])('rejects %s comment → comment-required', (_label, comment) => {
    const result = transition(PENDING(), { kind: 'reject', comment }, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('comment-required')
  })

  it('forbidden when principal lacks review:approve', () => {
    const result = transition(PENDING(), { kind: 'reject', comment: 'nope' }, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('forbidden')
  })

  it('allowSelfApproval: false blocks submitter from rejecting own submission', () => {
    const snapshot = PENDING({ submitter: 'dave' })
    const result = transition(snapshot, { kind: 'reject', comment: 'wait' }, DAVE_BOTH, CFG_TWO_NO_SELF)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden')
      expect(result.error.reason).toContain('withdraw')
    }
  })

  it('invalid-transition from draft', () => {
    const result = transition(DRAFT, { kind: 'reject', comment: 'no' }, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })

  it('invalid-transition from approved', () => {
    const result = transition(APPROVED(), { kind: 'reject', comment: 'no' }, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })
})

describe('withdraw', () => {
  it('pending-review + withdraw by submitter → draft', () => {
    const snapshot = PENDING({ submitter: 'alice' })
    const result = transition(snapshot, { kind: 'withdraw' }, ALICE_SUBMITTER, CFG_ON)
    expect(result).toEqual({ ok: true, next: { state: 'draft' } })
  })

  it('non-submitter withdraw → not-submitter', () => {
    const snapshot = PENDING({ submitter: 'alice' })
    const result = transition(snapshot, { kind: 'withdraw' }, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not-submitter')
  })

  it('invalid-transition from draft', () => {
    const result = transition(DRAFT, { kind: 'withdraw' }, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })

  it('invalid-transition from approved', () => {
    const result = transition(APPROVED(), { kind: 'withdraw' }, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-transition')
  })

  it('withdraw does not require any capability — only submitter identity', () => {
    const noCap = principal({ id: 'alice', capabilities: [] })
    const snapshot = PENDING({ submitter: 'alice' })
    const result = transition(snapshot, { kind: 'withdraw' }, noCap, CFG_ON)
    expect(result.ok).toBe(true)
  })
})

describe('invalidate — content-diff policy', () => {
  it('approved + content differs → draft', () => {
    const result = transition(APPROVED(), { kind: 'invalidate', contentDiffers: true }, ALICE_SUBMITTER, {
      ...CFG_ON,
      invalidateOnSave: 'content-diff',
    })
    expect(result).toEqual({ ok: true, next: { state: 'draft' } })
  })

  it('approved + content unchanged → no-op (stays approved)', () => {
    const snapshot = APPROVED()
    const result = transition(snapshot, { kind: 'invalidate', contentDiffers: false }, ALICE_SUBMITTER, {
      ...CFG_ON,
      invalidateOnSave: 'content-diff',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.next).toEqual(snapshot)
  })

  it('content-diff is the default policy when config omits invalidateOnSave', () => {
    const result = transition(APPROVED(), { kind: 'invalidate', contentDiffers: false }, ALICE_SUBMITTER, {
      enabled: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.next.state).toBe('approved')
  })
})

describe('invalidate — always policy', () => {
  it('approved + content unchanged → draft (because policy is always)', () => {
    const result = transition(APPROVED(), { kind: 'invalidate', contentDiffers: false }, ALICE_SUBMITTER, {
      ...CFG_ON,
      invalidateOnSave: 'always',
    })
    expect(result).toEqual({ ok: true, next: { state: 'draft' } })
  })

  it('approved + content differs → draft', () => {
    const result = transition(APPROVED(), { kind: 'invalidate', contentDiffers: true }, ALICE_SUBMITTER, {
      ...CFG_ON,
      invalidateOnSave: 'always',
    })
    expect(result).toEqual({ ok: true, next: { state: 'draft' } })
  })
})

describe('invalidate — defensive no-op from non-approved states', () => {
  it.each([
    ['draft', DRAFT],
    ['pending-review', PENDING()],
  ] as const)('invalidate from %s is a no-op (state unchanged)', (_label, snapshot) => {
    const resultDiff = transition(snapshot, { kind: 'invalidate', contentDiffers: true }, ALICE_SUBMITTER, CFG_ON)
    const resultNoDiff = transition(snapshot, { kind: 'invalidate', contentDiffers: false }, ALICE_SUBMITTER, {
      ...CFG_ON,
      invalidateOnSave: 'always',
    })
    expect(resultDiff.ok && resultDiff.next).toEqual(snapshot)
    expect(resultNoDiff.ok && resultNoDiff.next).toEqual(snapshot)
  })
})

describe('property: totality + determinism over (state, action, config)', () => {
  // Arbitraries small enough to keep runs fast (default 100 each).
  const stateArb: fc.Arbitrary<ReviewStateSnapshot> = fc.oneof(
    fc.constant<ReviewStateSnapshot>({ state: 'draft' }),
    fc
      .record({
        submitter: fc.constantFrom('alice', 'bob', 'carol'),
        requiredApprovers: fc.integer({ min: 1, max: 5 }),
        approvers: fc.uniqueArray(fc.constantFrom('bob', 'carol', 'dave'), { maxLength: 3 }),
      })
      .map(
        (r): ReviewStateSnapshot => ({
          state: 'pending-review',
          submitter: r.submitter,
          approvers: r.approvers,
          requiredApprovers: r.requiredApprovers,
        }),
      ),
    fc
      .record({
        submitter: fc.constantFrom('alice', 'bob', 'carol'),
        approvers: fc.uniqueArray(fc.constantFrom('bob', 'carol', 'dave'), { minLength: 1, maxLength: 3 }),
      })
      .map(
        (r): ReviewStateSnapshot => ({
          state: 'approved',
          submitter: r.submitter,
          approvers: r.approvers,
        }),
      ),
  )

  const actionArb: fc.Arbitrary<ReviewAction> = fc.oneof(
    fc.constant<ReviewAction>({ kind: 'submit' }),
    fc.constant<ReviewAction>({ kind: 'approve' }),
    fc.string({ maxLength: 40 }).map(comment => ({ kind: 'reject' as const, comment })),
    fc.constant<ReviewAction>({ kind: 'withdraw' }),
    fc.boolean().map(contentDiffers => ({ kind: 'invalidate' as const, contentDiffers })),
  )

  const principalArb: fc.Arbitrary<Principal> = fc
    .record({
      id: fc.constantFrom('alice', 'bob', 'carol', 'dave', 'eve'),
      caps: fc.subarray(['review:submit', 'review:approve', 'read:pages', 'edit:pages', '*']),
    })
    .map(r =>
      principal({
        id: r.id,
        capabilities: r.caps,
      }),
    )

  const configArb: fc.Arbitrary<ReviewWorkflowConfig> = fc.record({
    enabled: fc.boolean(),
    requiredApprovers: fc.integer({ min: 1, max: 5 }),
    allowSelfApproval: fc.boolean(),
    invalidateOnSave: fc.constantFrom('content-diff' as const, 'always' as const),
  })

  it('never throws — totality', () => {
    fc.assert(
      fc.property(stateArb, actionArb, principalArb, configArb, (state, action, p, cfg) => {
        const r = transition(state, action, p, cfg)
        expect(r.ok === true || r.ok === false).toBe(true)
      }),
    )
  })

  it('deterministic — same inputs return same result', () => {
    fc.assert(
      fc.property(stateArb, actionArb, principalArb, configArb, (state, action, p, cfg) => {
        const a = transition(state, action, p, cfg)
        const b = transition(state, action, p, cfg)
        expect(a).toEqual(b)
      }),
    )
  })

  it('non-submit/non-invalidate actions on draft never succeed (regardless of principal/config)', () => {
    // The transition can fail with several different codes depending on
    // config (disabled / invalid-transition / forbidden / comment-required);
    // the load-bearing property is that none of them ever PRODUCE a state
    // change from draft for these actions.
    fc.assert(
      fc.property(principalArb, configArb, (p, cfg) => {
        for (const action of [
          { kind: 'approve' } as const,
          { kind: 'reject', comment: 'x' } as const,
          { kind: 'withdraw' } as const,
        ]) {
          const r = transition(DRAFT, action, p, cfg)
          expect(r.ok).toBe(false)
        }
      }),
    )
  })

  it('non-invalidate actions on approved never succeed (regardless of principal/config)', () => {
    fc.assert(
      fc.property(principalArb, configArb, (p, cfg) => {
        const snap: ReviewStateSnapshot = {
          state: 'approved',
          submitter: 'alice',
          approvers: ['bob'],
        }
        for (const action of [
          { kind: 'submit' } as const,
          { kind: 'approve' } as const,
          { kind: 'reject', comment: 'x' } as const,
          { kind: 'withdraw' } as const,
        ]) {
          const r = transition(snap, action, p, cfg)
          expect(r.ok).toBe(false)
        }
      }),
    )
  })

  it('invalidate from non-approved states never errors (defensive no-op)', () => {
    fc.assert(
      fc.property(principalArb, configArb, fc.boolean(), (p, cfg, diff) => {
        for (const snap of [
          { state: 'draft' } as const satisfies ReviewStateSnapshot,
          {
            state: 'pending-review',
            submitter: 'alice',
            approvers: [],
            requiredApprovers: 1,
          } as const satisfies ReviewStateSnapshot,
        ]) {
          const r = transition(snap, { kind: 'invalidate', contentDiffers: diff }, p, cfg)
          expect(r.ok).toBe(true)
          if (r.ok) expect(r.next).toEqual(snap)
        }
      }),
    )
  })
})
