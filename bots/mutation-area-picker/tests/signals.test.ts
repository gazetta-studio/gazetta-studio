import { describe, expect, it } from 'vitest'
import { collectEvictionSignals, collectInclusionSignals, pathToBasename, type SignalEnv } from '../signals.js'

/**
 * Fixture env that returns deterministic values per module path.
 * Tests pass a Map or an object describing the per-module values
 * the bot should observe.
 */
function fixtureEnv(fixtures: {
  commits?: Record<string, number>
  aiPaired?: Record<string, number>
  lines?: Record<string, number>
  relatedTests?: Record<string, string[]>
  flakes?: Record<string, number>
  fixPRs?: Record<string, number>
  mutationIssues?: Record<string, { total: number; closedMerged: number }>
}): SignalEnv {
  return {
    countCommitsTouching: async (p, _) => fixtures.commits?.[p] ?? 0,
    countAIPairedCommitsTouching: async (p, _) => fixtures.aiPaired?.[p] ?? 0,
    countLines: async p => fixtures.lines?.[p] ?? 0,
    findRelatedTestFiles: async basename => fixtures.relatedTests?.[basename] ?? [],
    findFlakeIssuesMentioning: async p => fixtures.flakes?.[p] ?? 0,
    countRecentFixPRsTouching: async (p, _) => fixtures.fixPRs?.[p] ?? 0,
    countMutationIssues: async (p, _) => fixtures.mutationIssues?.[p] ?? { total: 0, closedMerged: 0 },
  }
}

describe('pathToBasename', () => {
  it('strips directory and extension', () => {
    expect(pathToBasename('packages/gazetta/src/archive/index.ts')).toBe('index')
    expect(pathToBasename('packages/gazetta/src/publish.ts')).toBe('publish')
    expect(pathToBasename('foo.bar.ts')).toBe('foo.bar')
  })

  it('handles paths without extension', () => {
    expect(pathToBasename('src/foo')).toBe('foo')
  })

  it('handles bare filename', () => {
    expect(pathToBasename('foo.ts')).toBe('foo')
  })
})

describe('collectInclusionSignals', () => {
  it('returns all five signals from fixture data', async () => {
    const env = fixtureEnv({
      aiPaired: { 'src/foo.ts': 12 },
      commits: { 'src/foo.ts': 45 },
      lines: { 'src/foo.ts': 200, '/repo/tests/foo.test.ts': 60 },
      relatedTests: { foo: ['/repo/tests/foo.test.ts'] },
      flakes: { 'src/foo.ts': 2 },
      fixPRs: { 'src/foo.ts': 3 },
    })
    const result = await collectInclusionSignals(env, 'src/foo.ts', 'src/foo.ts')
    expect(result.aiPairingDensity).toBe(12)
    expect(result.recentChurn).toBe(45)
    expect(result.flakeCorrelation).toBe(2)
    expect(result.bugFixCorrelation).toBe(3)
    // testCoverageRatioInverse: ratio = 60/200 = 0.3 → inverse = 1/(1+0.3) ≈ 0.769
    expect(result.testCoverageRatioInverse).toBeCloseTo(0.769, 2)
  })

  it('high coverage produces low inverse score (good test coverage = low priority)', async () => {
    const env = fixtureEnv({
      lines: { 'src/foo.ts': 100, '/repo/tests/foo.test.ts': 500 },
      relatedTests: { foo: ['/repo/tests/foo.test.ts'] },
    })
    const result = await collectInclusionSignals(env, 'src/foo.ts', 'src/foo.ts')
    // ratio = 500/100 = 5 → inverse = 1/(1+5) ≈ 0.167 — low score, well-covered
    expect(result.testCoverageRatioInverse).toBeCloseTo(0.167, 2)
  })

  it('zero tests produces high inverse score (no coverage = high priority)', async () => {
    const env = fixtureEnv({
      lines: { 'src/foo.ts': 100 },
      relatedTests: { foo: [] },
    })
    const result = await collectInclusionSignals(env, 'src/foo.ts', 'src/foo.ts')
    // ratio = 0 → inverse = 1/(1+0) = 1.0 — maximum priority
    expect(result.testCoverageRatioInverse).toBe(1.0)
  })

  it('zero src lines produces 1.0 (degenerate but safe)', async () => {
    const env = fixtureEnv({})
    const result = await collectInclusionSignals(env, 'src/empty.ts', 'src/empty.ts')
    expect(result.testCoverageRatioInverse).toBe(1.0)
  })

  it('sums LOC across multiple test files', async () => {
    const env = fixtureEnv({
      lines: {
        'src/foo.ts': 100,
        '/repo/tests/foo.test.ts': 40,
        '/repo/tests/foo-extra.test.ts': 60,
      },
      relatedTests: { foo: ['/repo/tests/foo.test.ts', '/repo/tests/foo-extra.test.ts'] },
    })
    const result = await collectInclusionSignals(env, 'src/foo.ts', 'src/foo.ts')
    // ratio = 100/100 = 1.0 → inverse = 0.5
    expect(result.testCoverageRatioInverse).toBe(0.5)
  })

  it('missing signals default to 0', async () => {
    const env = fixtureEnv({}) // empty fixtures
    const result = await collectInclusionSignals(env, 'src/unknown.ts', 'src/unknown.ts')
    expect(result.aiPairingDensity).toBe(0)
    expect(result.recentChurn).toBe(0)
    expect(result.flakeCorrelation).toBe(0)
    expect(result.bugFixCorrelation).toBe(0)
    expect(result.testCoverageRatioInverse).toBe(1.0) // zero src LOC default
  })
})

describe('collectEvictionSignals', () => {
  it('passes through mutation-issue stats and slices kill-ratio history', async () => {
    const env = fixtureEnv({
      mutationIssues: { 'src/scoped.ts': { total: 10, closedMerged: 8 } },
    })
    const history = [0.7, 0.8, 0.85, 0.88, 0.9] // 5 entries
    const result = await collectEvictionSignals(env, 'src/scoped.ts', history)
    // Default config keeps last 4 weeks
    expect(result.killRatioHistory).toEqual([0.8, 0.85, 0.88, 0.9])
    expect(result.mutationIssuesTotal).toBe(10)
    expect(result.mutationIssuesClosedMerged).toBe(8)
  })

  it('handles shorter-than-window history (bootstrap)', async () => {
    const env = fixtureEnv({
      mutationIssues: { 'src/scoped.ts': { total: 0, closedMerged: 0 } },
    })
    const history = [0.7, 0.75] // only 2 weeks
    const result = await collectEvictionSignals(env, 'src/scoped.ts', history)
    expect(result.killRatioHistory).toEqual([0.7, 0.75])
  })

  it('handles empty history', async () => {
    const env = fixtureEnv({})
    const result = await collectEvictionSignals(env, 'src/scoped.ts', [])
    expect(result.killRatioHistory).toEqual([])
    expect(result.mutationIssuesTotal).toBe(0)
    expect(result.mutationIssuesClosedMerged).toBe(0)
  })

  it('respects custom killRatioWeeks config', async () => {
    const env = fixtureEnv({})
    const history = [0.7, 0.8, 0.85, 0.88, 0.9]
    const result = await collectEvictionSignals(env, 'src/scoped.ts', history, {
      issueWindowDays: 90,
      killRatioWeeks: 2,
    })
    expect(result.killRatioHistory).toEqual([0.88, 0.9])
  })
})
