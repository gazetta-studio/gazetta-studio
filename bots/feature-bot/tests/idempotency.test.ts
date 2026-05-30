/**
 * Idempotency tests — failing-test commit per rule 31 TDD-first ordering.
 *
 * Mirrors fix-bot's auto-clear-on-reopen pattern (label `feature-bot-attempted`).
 *
 * Decision rules:
 *   - No `feature-bot-attempted` label → proceed (fresh)
 *   - Label present + no reopen since → skip (already attempted)
 *   - Label present + reopened after label-applied-time → proceed (retry)
 */
import { describe, expect, it } from 'vitest'
import { decideIdempotency } from '../idempotency.js'

describe('decideIdempotency', () => {
  it('proceeds when label has never been applied', () => {
    const result = decideIdempotency({ attemptedAt: null, reopenedAt: null })
    expect(result.kind).toBe('proceed')
  })

  it('skips when label is present and issue has not been reopened', () => {
    const result = decideIdempotency({ attemptedAt: '2026-05-20T00:00:00Z', reopenedAt: null })
    expect(result.kind).toBe('skip')
  })

  it('skips when label is present and reopen is older than label-applied', () => {
    const result = decideIdempotency({
      attemptedAt: '2026-05-25T00:00:00Z',
      reopenedAt: '2026-05-20T00:00:00Z',
    })
    expect(result.kind).toBe('skip')
  })

  it('proceeds when reopen is newer than label-applied', () => {
    const result = decideIdempotency({
      attemptedAt: '2026-05-20T00:00:00Z',
      reopenedAt: '2026-05-25T00:00:00Z',
    })
    expect(result.kind).toBe('proceed-after-reopen')
  })

  it('proceeds when reopen is exactly equal to label-applied (edge case: tie → reopen wins)', () => {
    // Reasonable tie-break: equal timestamps mean the reopen event was at
    // least as recent as the attempt; favor proceeding rather than skipping
    // forever on a millisecond race.
    const ts = '2026-05-20T00:00:00Z'
    const result = decideIdempotency({ attemptedAt: ts, reopenedAt: ts })
    expect(result.kind).toBe('proceed-after-reopen')
  })
})
