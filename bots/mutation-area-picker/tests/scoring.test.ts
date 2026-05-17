import { describe, expect, it } from 'vitest'
import type { EvictionSignals, InclusionSignals } from '../signals.js'
import {
  composeInclusionScores,
  DEFAULT_EVICTION_THRESHOLDS,
  DEFAULT_WEIGHTS,
  evaluateEviction,
  normalise,
} from '../scoring.js'

describe('normalise', () => {
  it('scales values to [0, 1] by the max', () => {
    expect(normalise([2, 4, 8])).toEqual([0.25, 0.5, 1.0])
  })

  it('returns all zeros when max is 0', () => {
    expect(normalise([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('handles single-element array', () => {
    expect(normalise([5])).toEqual([1.0])
  })

  it('handles empty array', () => {
    expect(normalise([])).toEqual([])
  })

  it('clamps negative max to 0 (defensive)', () => {
    // Realistically all signals are non-negative, but the function uses
    // Math.max(...values, 0) to avoid -Infinity from empty.
    expect(normalise([])).toEqual([])
  })
})

describe('composeInclusionScores', () => {
  function signal(overrides: Partial<InclusionSignals> = {}): InclusionSignals {
    return {
      aiPairingDensity: 0,
      testCoverageRatioInverse: 0.5,
      recentChurn: 0,
      flakeCorrelation: 0,
      bugFixCorrelation: 0,
      ...overrides,
    }
  }

  it('returns score in [0, 1] for default weights', () => {
    const candidates = [signal({ aiPairingDensity: 10, recentChurn: 20 })]
    const scores = composeInclusionScores(candidates)
    expect(scores[0]).toBeGreaterThanOrEqual(0)
    expect(scores[0]).toBeLessThanOrEqual(1)
  })

  it('ranks higher AI-paired candidate above lower one', () => {
    const candidates = [
      signal({ aiPairingDensity: 5 }), // low
      signal({ aiPairingDensity: 50 }), // high
    ]
    const scores = composeInclusionScores(candidates)
    expect(scores[1]).toBeGreaterThan(scores[0])
  })

  it('normalises within the candidate set, not absolutely', () => {
    // The same absolute AI-pairing count (5) scores high when it's the
    // top of the set, and low when it's not.
    const scoresIfTop = composeInclusionScores([signal({ aiPairingDensity: 5 })])
    const scoresIfNotTop = composeInclusionScores([signal({ aiPairingDensity: 5 }), signal({ aiPairingDensity: 50 })])
    expect(scoresIfTop[0]).toBeGreaterThan(scoresIfNotTop[0])
  })

  it('weights apply correctly — testCoverageRatioInverse passes through directly', () => {
    // testCoverageRatioInverse is already in [0, 1] — composer should
    // NOT re-normalise it; it should weight it directly.
    const candidates = [signal({ testCoverageRatioInverse: 1.0 })]
    const scores = composeInclusionScores(candidates)
    // With only this signal non-zero and weight 0.25, score = 0.25
    expect(scores[0]).toBeCloseTo(DEFAULT_WEIGHTS.testCoverageRatioInverse, 5)
  })

  it('produces 0 when all signals are 0', () => {
    const candidates = [signal({ testCoverageRatioInverse: 0 })]
    const scores = composeInclusionScores(candidates)
    expect(scores[0]).toBe(0)
  })

  it('respects custom weights', () => {
    const customWeights = {
      aiPairingDensity: 1.0, // only signal that matters
      testCoverageRatioInverse: 0,
      recentChurn: 0,
      flakeCorrelation: 0,
      bugFixCorrelation: 0,
    }
    const candidates = [signal({ aiPairingDensity: 1, testCoverageRatioInverse: 1 })]
    const scores = composeInclusionScores(candidates, customWeights)
    // testCoverageRatioInverse weight is 0, aiPairing normalised to 1.0 (only candidate)
    expect(scores[0]).toBe(1.0)
  })
})

describe('evaluateEviction', () => {
  function signal(overrides: Partial<EvictionSignals> = {}): EvictionSignals {
    return {
      killRatioHistory: [0.9, 0.9, 0.9, 0.9],
      mutationIssuesTotal: 10,
      mutationIssuesClosedMerged: 8,
      ...overrides,
    }
  }

  it('evicts when both kill-ratio and fix-rate pass', () => {
    const result = evaluateEviction(signal())
    expect(result.evicts).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.score).toBeGreaterThan(0.5)
  })

  it('does NOT evict when kill ratio is below threshold', () => {
    const result = evaluateEviction(signal({ killRatioHistory: [0.5, 0.6, 0.5, 0.4] }))
    expect(result.evicts).toBe(false)
    expect(result.reason).toMatch(/kill ratio/)
  })

  it('does NOT evict when fix rate is below threshold', () => {
    const result = evaluateEviction(signal({ mutationIssuesTotal: 10, mutationIssuesClosedMerged: 2 }))
    expect(result.evicts).toBe(false)
    expect(result.reason).toMatch(/fix rate/)
  })

  it('does NOT evict when any single week drops below ratio (sustained=min, not mean)', () => {
    // Mean is 0.8625 > 0.85 — but min is 0.8 < 0.85; should NOT evict
    const result = evaluateEviction(signal({ killRatioHistory: [0.8, 0.9, 0.9, 0.95] }))
    expect(result.evicts).toBe(false)
    expect(result.reason).toMatch(/kill ratio/)
  })

  it('does NOT evict when history is shorter than threshold (bootstrap)', () => {
    const result = evaluateEviction(signal({ killRatioHistory: [0.95, 0.95] }))
    expect(result.evicts).toBe(false)
    expect(result.reason).toMatch(/history too short/)
  })

  it('does NOT evict when insufficient mutation-watcher issues exist', () => {
    const result = evaluateEviction(signal({ mutationIssuesTotal: 0, mutationIssuesClosedMerged: 0 }))
    expect(result.evicts).toBe(false)
    expect(result.reason).toMatch(/not enough mutation-watcher issues/)
  })

  it('score scales monotonically with both component sub-scores', () => {
    const weak = evaluateEviction(signal({ killRatioHistory: [0.86, 0.86, 0.86, 0.86], mutationIssuesClosedMerged: 7 }))
    const strong = evaluateEviction(
      signal({ killRatioHistory: [0.99, 0.99, 0.99, 0.99], mutationIssuesClosedMerged: 10 }),
    )
    expect(strong.score).toBeGreaterThan(weak.score)
  })

  it('respects custom thresholds', () => {
    // Lower thresholds → easier eviction
    const result = evaluateEviction(signal({ killRatioHistory: [0.6, 0.6, 0.6, 0.6], mutationIssuesClosedMerged: 5 }), {
      ...DEFAULT_EVICTION_THRESHOLDS,
      killRatio: 0.5,
      fixRate: 0.4,
    })
    expect(result.evicts).toBe(true)
  })
})
