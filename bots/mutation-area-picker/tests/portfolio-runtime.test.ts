import { describe, expect, it } from 'vitest'
import { computeStepDurationMinutes, derivePortfolioRuntimeMinutes } from '../portfolio-runtime.js'

/**
 * Regression test for issue #871: the bot's current portfolio runtime
 * was a frozen constant (`MUTATION_CURRENT_RUNTIME_MINUTES`, default
 * 105). The scoped-set estimate therefore always summed to that value
 * no matter how many modules were in the glob — the 150-min budget
 * check could never fire. The fix derives the runtime from recent
 * `Run Stryker` step durations.
 *
 * These tests pin the two pure functions. The GitHub API I/O stays
 * in the orchestrator (see signal-env.ts); here we unit-test the
 * duration-math and the "max of recent runs" statistic without
 * touching the network.
 */

describe('computeStepDurationMinutes', () => {
  it('returns the difference between two ISO timestamps in minutes', () => {
    // 2026-10-04 case from issue #871: 09:31:38Z → 11:30:00Z spans 118.37 min
    const minutes = computeStepDurationMinutes('2026-10-04T09:31:38Z', '2026-10-04T11:30:00Z')
    expect(minutes).toBeCloseTo(118.367, 2)
  })

  it('handles sub-minute precision', () => {
    const minutes = computeStepDurationMinutes('2026-10-04T09:00:00Z', '2026-10-04T09:00:30Z')
    expect(minutes).toBeCloseTo(0.5, 3)
  })

  it('returns null when startedAt is null', () => {
    expect(computeStepDurationMinutes(null, '2026-10-04T11:30:00Z')).toBeNull()
  })

  it('returns null when completedAt is null', () => {
    expect(computeStepDurationMinutes('2026-10-04T09:00:00Z', null)).toBeNull()
  })

  it('returns null when both are null', () => {
    expect(computeStepDurationMinutes(null, null)).toBeNull()
  })

  it('returns null when either timestamp is unparseable', () => {
    expect(computeStepDurationMinutes('not-a-date', '2026-10-04T09:00:00Z')).toBeNull()
    expect(computeStepDurationMinutes('2026-10-04T09:00:00Z', 'not-a-date')).toBeNull()
  })

  it('returns null when completed is before started (impossible state)', () => {
    // Defensive: a negative duration shouldn't be fed into calibration.
    expect(computeStepDurationMinutes('2026-10-04T10:00:00Z', '2026-10-04T09:00:00Z')).toBeNull()
  })
})

describe('derivePortfolioRuntimeMinutes', () => {
  it('returns the max of the given durations (conservative statistic)', () => {
    // Durations from issue #871: 132.2, 138.5, 126.1, 148.7, 98.2.
    // Max = 148.7 min. Chosen to prevent under-shooting the real cost
    // when the bot evaluates whether an ADD fits under budget.
    const result = derivePortfolioRuntimeMinutes([132.2, 138.5, 126.1, 148.7, 98.2])
    expect(result).toBe(148.7)
  })

  it('returns the single value when only one duration is given', () => {
    expect(derivePortfolioRuntimeMinutes([105])).toBe(105)
  })

  it('returns null when no durations are available', () => {
    expect(derivePortfolioRuntimeMinutes([])).toBeNull()
  })

  it('ignores null and non-finite entries', () => {
    // The orchestrator may call this with a sparse list — some runs
    // without a timestamped Stryker step still have slot in the array.
    const result = derivePortfolioRuntimeMinutes([132.2, Number.NaN, 98.2, Number.POSITIVE_INFINITY, 148.7])
    expect(result).toBe(148.7)
  })

  it('returns null when every entry is non-finite', () => {
    expect(derivePortfolioRuntimeMinutes([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull()
  })
})
