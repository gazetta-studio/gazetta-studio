/**
 * Cut #520 tests — review-workflow audit integration.
 *
 * `buildReviewAuditEvent` maps a `(ReviewAction, ReviewTransitionResult,
 * AuditScope)` triple to the `RecordEventInput` shape the route handler
 * hands to `c.var.audit.record(...)`. It's pure — no I/O — so tests
 * exercise it by calling it directly and asserting on the returned
 * shape.
 *
 * The final block wires `buildReviewAuditEvent` + `recordToAll` +
 * `HistoryAuditProvider` against in-memory storage. That round-trip
 * pins the "actor-scoped query" acceptance bullet: an actor's events
 * survive serialization and surface via `provider.query({ actor })`.
 * Mirrors the recording-site pattern Cut 7 will adopt (see
 * `archive.ts`'s `c.var.audit.record(...)` calls).
 *
 * Per `design-review-workflow.md` "Audit event shape":
 *
 *   - Each of the 4 user-driven transitions has its own audit verb
 *     (`review-submit` / `review-approve` / `review-reject` /
 *     `review-withdraw`). The internal `invalidate` action has no
 *     audit verb (the originating save emits `action: 'save'`).
 *   - Successful reject carries the mandatory comment in
 *     `metadata.comment`.
 *   - Forbidden transitions (missing capability, self-approval
 *     denied, not-submitter on withdraw) record `outcome: 'forbidden'`.
 *   - Other FSM rejections (invalid-transition, comment-required,
 *     already-voted, disabled) record `outcome: 'validation-failed'`.
 */
import { describe, expect, it } from 'vitest'
import type { Principal } from '../src/auth/types.js'
import {
  buildReviewAuditEvent,
  transition,
  type ReviewAction,
  type ReviewStateSnapshot,
  type ReviewWorkflowConfig,
} from '../src/review/index.js'
import { createHistoryAuditProvider, recordToAll, type AuditEvent } from '../src/audit/index.js'
import { memoryStorage } from './_helpers/memory-storage.js'

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
const DAVE_BOTH = principal({ id: 'dave', capabilities: ['review:submit', 'review:approve'] })
const VIEWER = principal({ id: 'eve', capabilities: ['read:pages'] })

const CFG_ON: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 1,
  allowSelfApproval: true,
  invalidateOnSave: 'content-diff',
}
const CFG_OFF: ReviewWorkflowConfig = { enabled: false }
const CFG_NO_SELF: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 1,
  allowSelfApproval: false,
  invalidateOnSave: 'content-diff',
}
const CFG_TWO: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 2,
  allowSelfApproval: true,
  invalidateOnSave: 'content-diff',
}

const SCOPE_PAGE = { kind: 'page', name: 'home' } as const

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
const APPROVED: ReviewStateSnapshot = {
  state: 'approved',
  submitter: 'alice',
  approvers: ['bob'],
}

describe('successful transitions → outcome: success', () => {
  it.each([
    ['submit', { kind: 'submit' } as ReviewAction, DRAFT, ALICE_SUBMITTER, CFG_ON, 'review-submit'],
    ['approve', { kind: 'approve' } as ReviewAction, PENDING(), BOB_APPROVER, CFG_ON, 'review-approve'],
    ['withdraw', { kind: 'withdraw' } as ReviewAction, PENDING(), ALICE_SUBMITTER, CFG_ON, 'review-withdraw'],
  ] as const)('%s emits the right action verb', (_label, action, snap, actor, cfg, expectedVerb) => {
    const result = transition(snap, action, actor, cfg)
    expect(result.ok).toBe(true)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event).toEqual({
      action: expectedVerb,
      outcome: 'success',
      scope: SCOPE_PAGE,
    })
  })
})

describe('reject — mandatory comment captured in metadata', () => {
  it('successful reject records the comment', () => {
    const action: ReviewAction = { kind: 'reject', comment: 'Needs more detail before we can ship' }
    const result = transition(PENDING(), action, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(true)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event).toEqual({
      action: 'review-reject',
      outcome: 'success',
      scope: SCOPE_PAGE,
      metadata: { comment: 'Needs more detail before we can ship' },
    })
  })

  it('reject failure with empty comment → outcome: validation-failed, no comment in metadata', () => {
    const action: ReviewAction = { kind: 'reject', comment: '' }
    const result = transition(PENDING(), action, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event?.outcome).toBe('validation-failed')
    expect(event?.metadata).toMatchObject({ code: 'comment-required' })
    expect(event?.metadata).not.toHaveProperty('comment')
  })

  it('reject failure with non-empty comment preserves the comment in metadata (forensic record of attempt)', () => {
    // Submitter trying to reject own submission with self-approval denied —
    // they DID write a comment; record it so the audit log carries the
    // attempted reasoning, not just the rejection.
    const snap = PENDING({ submitter: 'dave' })
    const action: ReviewAction = { kind: 'reject', comment: 'Changed my mind' }
    const result = transition(snap, action, DAVE_BOTH, CFG_NO_SELF)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event?.outcome).toBe('forbidden')
    expect(event?.metadata).toMatchObject({ comment: 'Changed my mind' })
  })
})

describe('authorization failures → outcome: forbidden', () => {
  it('missing capability on submit → forbidden + missingCapability metadata', () => {
    const action: ReviewAction = { kind: 'submit' }
    const result = transition(DRAFT, action, VIEWER, CFG_ON)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event).toEqual({
      action: 'review-submit',
      outcome: 'forbidden',
      scope: SCOPE_PAGE,
      metadata: {
        code: 'forbidden',
        reason: "Missing capability 'review:submit'",
        missingCapability: 'review:submit',
      },
    })
  })

  it('missing capability on approve → forbidden with missingCapability', () => {
    const action: ReviewAction = { kind: 'approve' }
    const result = transition(PENDING(), action, ALICE_SUBMITTER, CFG_ON)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event?.action).toBe('review-approve')
    expect(event?.outcome).toBe('forbidden')
    expect(event?.metadata).toMatchObject({
      code: 'forbidden',
      missingCapability: 'review:approve',
    })
  })

  it('self-approval denied → forbidden (no missingCapability — actor HAS the capability)', () => {
    const snap = PENDING({ submitter: 'dave', requiredApprovers: 1 })
    const action: ReviewAction = { kind: 'approve' }
    const result = transition(snap, action, DAVE_BOTH, CFG_NO_SELF)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event?.outcome).toBe('forbidden')
    expect(event?.metadata).toMatchObject({ code: 'forbidden' })
    expect(event?.metadata).not.toHaveProperty('missingCapability')
  })

  it('not-submitter on withdraw → forbidden', () => {
    const snap = PENDING({ submitter: 'alice' })
    const action: ReviewAction = { kind: 'withdraw' }
    const result = transition(snap, action, BOB_APPROVER, CFG_ON)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event).toEqual({
      action: 'review-withdraw',
      outcome: 'forbidden',
      scope: SCOPE_PAGE,
      metadata: {
        code: 'not-submitter',
        reason: "Only the submitter can withdraw — submitter is 'alice' but actor is 'bob'",
      },
    })
  })
})

describe('request-shape failures → outcome: validation-failed', () => {
  it.each([
    [
      'invalid-transition (submit on pending-review)',
      { kind: 'submit' } as ReviewAction,
      PENDING(),
      ALICE_SUBMITTER,
      CFG_ON,
      'invalid-transition',
    ],
    [
      'disabled (submit when workflow off)',
      { kind: 'submit' } as ReviewAction,
      DRAFT,
      ALICE_SUBMITTER,
      CFG_OFF,
      'disabled',
    ],
    [
      'already-voted (duplicate approve from same actor)',
      { kind: 'approve' } as ReviewAction,
      PENDING({ requiredApprovers: 2, approvers: ['bob'] }),
      BOB_APPROVER,
      CFG_TWO,
      'already-voted',
    ],
  ] as const)('%s → validation-failed', (_label, action, snap, actor, cfg, expectedCode) => {
    const result = transition(snap, action, actor, cfg)
    expect(result.ok).toBe(false)
    const event = buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })
    expect(event?.outcome).toBe('validation-failed')
    expect(event?.metadata).toMatchObject({ code: expectedCode })
  })
})

describe('invalidate action → no audit event', () => {
  it.each([
    ['approved + content differs', APPROVED, true],
    ['approved + content unchanged', APPROVED, false],
    ['draft (defensive no-op)', DRAFT, true],
    ['pending-review (defensive no-op)', PENDING(), false],
  ] as const)('%s returns null', (_label, snap, contentDiffers) => {
    const action: ReviewAction = { kind: 'invalidate', contentDiffers }
    const result = transition(snap, action, ALICE_SUBMITTER, CFG_ON)
    expect(buildReviewAuditEvent({ action, result, scope: SCOPE_PAGE })).toBeNull()
  })
})

describe('end-to-end with HistoryAuditProvider — actor-scoped query', () => {
  it('records review events and surfaces them via actor.id filter', async () => {
    // Wire the helper + recorder + provider against fresh in-memory
    // storage. This mirrors the Cut 7 route handler pattern; it pins
    // that the audit-event shape produced by buildReviewAuditEvent
    // round-trips through the provider's JSONL serialization.
    const storage = memoryStorage()
    const provider = createHistoryAuditProvider({ storage, instance: 'test-1' })

    // Drive each transition through buildReviewAuditEvent, then
    // record. Two different actors, four events total.
    async function recordTransition(
      action: ReviewAction,
      snap: ReviewStateSnapshot,
      actor: Principal,
      cfg: ReviewWorkflowConfig,
      timestamp: string,
    ): Promise<void> {
      const result = transition(snap, action, actor, cfg)
      const input = buildReviewAuditEvent({
        action,
        result,
        scope: { kind: 'page', name: 'home' },
      })
      if (!input) return
      const event: AuditEvent = {
        timestamp,
        actor: {
          id: actor.id,
          email: `${actor.id}@example.com`,
          role: actor.role,
          trustMode: actor.trustMode,
        },
        ...input,
      }
      const recordResult = await recordToAll(event, { providers: [provider] })
      expect(recordResult.failed).toBe(0)
    }

    // Alice submits (success).
    await recordTransition({ kind: 'submit' }, DRAFT, ALICE_SUBMITTER, CFG_ON, '2026-06-16T10:00:00.000Z')
    // Bob approves (success).
    await recordTransition({ kind: 'approve' }, PENDING(), BOB_APPROVER, CFG_ON, '2026-06-16T10:01:00.000Z')
    // Bob rejects another submission with comment (success).
    await recordTransition(
      { kind: 'reject', comment: 'Please rephrase the headline' },
      PENDING(),
      BOB_APPROVER,
      CFG_ON,
      '2026-06-16T10:02:00.000Z',
    )
    // Alice tries to approve without the capability (forbidden).
    await recordTransition({ kind: 'approve' }, PENDING(), ALICE_SUBMITTER, CFG_ON, '2026-06-16T10:03:00.000Z')

    // Sanity: total events queryable.
    const all = await provider.query!({})
    expect(all.length).toBe(4)
    expect(all.map(e => e.action).sort()).toEqual(
      ['review-approve', 'review-approve', 'review-reject', 'review-submit'].sort(),
    )

    // Actor-scoped query: alice's events (submit success + approve forbidden).
    const aliceEvents = await provider.query!({ actor: 'alice' })
    expect(aliceEvents.length).toBe(2)
    const aliceByAction = new Map(aliceEvents.map(e => [e.action, e]))
    expect(aliceByAction.get('review-submit')?.outcome).toBe('success')
    expect(aliceByAction.get('review-approve')?.outcome).toBe('forbidden')
    expect(aliceByAction.get('review-approve')?.metadata).toMatchObject({
      code: 'forbidden',
      missingCapability: 'review:approve',
    })

    // Actor-scoped query: bob's events (approve + reject, both success).
    const bobEvents = await provider.query!({ actor: 'bob' })
    expect(bobEvents.length).toBe(2)
    expect(bobEvents.every(e => e.outcome === 'success')).toBe(true)
    const rejectEvent = bobEvents.find(e => e.action === 'review-reject')
    expect(rejectEvent?.metadata).toEqual({ comment: 'Please rephrase the headline' })

    // Action-scoped query layered on top of actor: alice's forbidden approve.
    const aliceForbidden = await provider.query!({ actor: 'alice', outcome: 'forbidden' })
    expect(aliceForbidden.length).toBe(1)
    expect(aliceForbidden[0].action).toBe('review-approve')
  })
})
