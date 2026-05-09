/**
 * Cut 14 — review-workflow integration helpers.
 *
 * Pure-function tests for `archive-review.ts`. The integration with
 * `handleArchive` and `handleUnarchive` is exercised by
 * `admin-api-archive-review.test.ts` (route-level audit shape +
 * manifest-strip behavior).
 *
 * Pre-review-workflow: every helper is a no-op for manifests without
 * `reviewState`. These tests verify both the no-op path and the
 * forward-compat path with synthetic `reviewState` values.
 */
import { describe, expect, it } from 'vitest'
import {
  archiveReviewMetadata,
  buildAutoWithdrawEvent,
  stripReviewStateForRestore,
} from '../src/admin-api/routes/archive-review.js'
import type { ComponentManifest } from '../src/types.js'

const baseManifest: ComponentManifest = {
  template: 'page-default',
  content: { title: 'Test' },
}

describe('buildAutoWithdrawEvent', () => {
  it('returns null when manifest has no reviewState (current production)', () => {
    const event = buildAutoWithdrawEvent(baseManifest, { kind: 'page', name: 'home' })
    expect(event).toBeNull()
  })

  it('returns null when manifest is in draft state (future review-workflow)', () => {
    const manifest = { ...baseManifest, reviewState: 'draft' } as ComponentManifest
    const event = buildAutoWithdrawEvent(manifest, { kind: 'page', name: 'home' })
    expect(event).toBeNull()
  })

  it('returns null when manifest is approved (approved discards via priorReviewState; no synthetic withdraw)', () => {
    const manifest = { ...baseManifest, reviewState: 'approved' } as ComponentManifest
    const event = buildAutoWithdrawEvent(manifest, { kind: 'page', name: 'home' })
    expect(event).toBeNull()
  })

  it('returns review-withdraw event when manifest is pending-review', () => {
    const manifest = { ...baseManifest, reviewState: 'pending-review' } as ComponentManifest
    const event = buildAutoWithdrawEvent(manifest, { kind: 'page', name: 'home' })
    expect(event).toEqual({
      action: 'review-withdraw',
      outcome: 'success',
      scope: { kind: 'page', name: 'home' },
      metadata: {
        autoWithdrawn: true,
        reason: 'archive',
        priorState: 'pending-review',
      },
    })
  })

  it('handles fragment scope correctly', () => {
    const manifest = { ...baseManifest, reviewState: 'pending-review' } as ComponentManifest
    const event = buildAutoWithdrawEvent(manifest, { kind: 'fragment', name: 'header' })
    expect(event?.scope).toEqual({ kind: 'fragment', name: 'header' })
  })

  it('ignores non-string reviewState values defensively', () => {
    const manifest = { ...baseManifest, reviewState: 42 } as unknown as ComponentManifest
    const event = buildAutoWithdrawEvent(manifest, { kind: 'page', name: 'home' })
    expect(event).toBeNull()
  })
})

describe('archiveReviewMetadata', () => {
  it('returns empty object when manifest has no reviewState', () => {
    const meta = archiveReviewMetadata(baseManifest)
    expect(meta).toEqual({})
  })

  it('captures priorReviewState when manifest is approved', () => {
    const manifest = { ...baseManifest, reviewState: 'approved' } as ComponentManifest
    const meta = archiveReviewMetadata(manifest)
    expect(meta).toEqual({ priorReviewState: 'approved' })
  })

  it('captures priorReviewState when manifest is pending-review', () => {
    const manifest = { ...baseManifest, reviewState: 'pending-review' } as ComponentManifest
    const meta = archiveReviewMetadata(manifest)
    expect(meta).toEqual({ priorReviewState: 'pending-review' })
  })

  it('captures any string state (forward-compat with future review states)', () => {
    const manifest = { ...baseManifest, reviewState: 'pending-publish' } as ComponentManifest
    const meta = archiveReviewMetadata(manifest)
    expect(meta).toEqual({ priorReviewState: 'pending-publish' })
  })
})

describe('stripReviewStateForRestore', () => {
  it('returns manifest unchanged when no reviewState present', () => {
    const result = stripReviewStateForRestore(baseManifest)
    expect(result).toBe(baseManifest)
  })

  it('strips reviewState from restored manifest', () => {
    const manifest = { ...baseManifest, reviewState: 'pending-review' } as ComponentManifest
    const result = stripReviewStateForRestore(manifest)
    expect(result).toEqual(baseManifest)
    expect((result as ComponentManifest & { reviewState?: unknown }).reviewState).toBeUndefined()
  })

  it('preserves all other fields when stripping', () => {
    const manifest = {
      template: 'page-default',
      content: { title: 'Test' },
      components: ['hero'],
      reviewState: 'approved',
    } as ComponentManifest
    const result = stripReviewStateForRestore(manifest)
    expect(result).toEqual({
      template: 'page-default',
      content: { title: 'Test' },
      components: ['hero'],
    })
  })

  it('strips approved state too (restore always to draft per Q9 N-B.1)', () => {
    const manifest = { ...baseManifest, reviewState: 'approved' } as ComponentManifest
    const result = stripReviewStateForRestore(manifest)
    expect((result as ComponentManifest & { reviewState?: unknown }).reviewState).toBeUndefined()
  })
})
