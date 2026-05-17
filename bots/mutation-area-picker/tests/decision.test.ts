import { describe, expect, it } from 'vitest'
import { decide, type DecisionInput, type ScopedModule, type UnMutatedCandidate } from '../decision.js'

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    unMutated: [],
    scoped: [],
    currentRuntimeMinutes: 100,
    budgetMinutes: 105,
    inBootstrap: false,
    inclusionThreshold: 0.4,
    evictionThreshold: 0.7,
    ...overrides,
  }
}

function candidate(overrides: Partial<UnMutatedCandidate> = {}): UnMutatedCandidate {
  return {
    modulePath: 'src/archive/index.ts',
    inclusionScore: 0.6,
    estimatedRuntimeMinutes: 3,
    ...overrides,
  }
}

function scoped(overrides: Partial<ScopedModule> = {}): ScopedModule {
  return {
    modulePath: 'src/publish.ts',
    eviction: { evicts: false, score: 0.3, reason: 'kill ratio 70% below 85%' },
    estimatedRuntimeMinutes: 10,
    ...overrides,
  }
}

describe('decide — ADD path', () => {
  it('ADDs when budget headroom and top score clears threshold', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.7, estimatedRuntimeMinutes: 3 })],
        currentRuntimeMinutes: 100,
        budgetMinutes: 105,
      }),
    )
    expect(decision.action).toBe('add')
    if (decision.action === 'add') expect(decision.module).toBe('src/archive/index.ts')
  })

  it('picks the highest-scoring candidate when multiple available', () => {
    const decision = decide(
      input({
        unMutated: [
          candidate({ modulePath: 'src/low.ts', inclusionScore: 0.5 }),
          candidate({ modulePath: 'src/high.ts', inclusionScore: 0.9 }),
          candidate({ modulePath: 'src/mid.ts', inclusionScore: 0.7 }),
        ],
      }),
    )
    expect(decision.action).toBe('add')
    if (decision.action === 'add') expect(decision.module).toBe('src/high.ts')
  })

  it('does NOT ADD when top score is below threshold', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.3 })],
        inclusionThreshold: 0.4,
      }),
    )
    expect(decision.action).toBe('noop')
  })

  it('does NOT ADD when budget exceeded', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.7, estimatedRuntimeMinutes: 10 })],
        currentRuntimeMinutes: 100,
        budgetMinutes: 105,
      }),
    )
    expect(decision.action).toBe('noop')
  })
})

describe('decide — Bootstrap mode', () => {
  it('ADDs in bootstrap when budget headroom exists', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.7, estimatedRuntimeMinutes: 3 })],
        inBootstrap: true,
      }),
    )
    expect(decision.action).toBe('add')
  })

  it('NOOPs in bootstrap when no candidate clears threshold', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.3 })],
        inBootstrap: true,
      }),
    )
    expect(decision.action).toBe('noop')
  })

  it('NOOPs in bootstrap when over budget even if scoped would graduate', () => {
    // Bootstrap blocks eviction; bot must NOT swap/remove even when scoped graduate
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.9, estimatedRuntimeMinutes: 10 })],
        scoped: [scoped({ eviction: { evicts: true, score: 0.9, reason: null } })],
        currentRuntimeMinutes: 100,
        budgetMinutes: 105,
        inBootstrap: true,
      }),
    )
    expect(decision.action).toBe('noop')
    if (decision.action === 'noop') expect(decision.reasoning).toMatch(/Bootstrap mode/)
  })
})

describe('decide — SWAP path', () => {
  it('SWAPs when at budget AND scoped graduates AND un-mutated outranks', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ modulePath: 'src/new.ts', inclusionScore: 0.95 })],
        scoped: [scoped({ modulePath: 'src/old.ts', eviction: { evicts: true, score: 0.8, reason: null } })],
        currentRuntimeMinutes: 105,
        budgetMinutes: 105,
      }),
    )
    expect(decision.action).toBe('swap')
    if (decision.action === 'swap') {
      expect(decision.addModule).toBe('src/new.ts')
      expect(decision.removeModule).toBe('src/old.ts')
    }
  })

  it('does NOT swap when un-mutated does not outrank eviction score', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.5 })],
        scoped: [scoped({ eviction: { evicts: true, score: 0.8, reason: null } })],
        currentRuntimeMinutes: 105,
        budgetMinutes: 105,
      }),
    )
    // best-eviction graduated, no replacement candidate clears the bar → REMOVE
    expect(decision.action).toBe('remove')
  })
})

describe('decide — REMOVE path', () => {
  it('REMOVEs when scoped graduates but no good un-mutated to swap', () => {
    const decision = decide(
      input({
        unMutated: [], // no candidates at all
        scoped: [scoped({ modulePath: 'src/done.ts', eviction: { evicts: true, score: 0.85, reason: null } })],
        currentRuntimeMinutes: 105,
        budgetMinutes: 105,
      }),
    )
    expect(decision.action).toBe('remove')
    if (decision.action === 'remove') expect(decision.module).toBe('src/done.ts')
  })

  it('REMOVEs when un-mutated exists but scores below SWAP bar', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.5 })], // below eviction score 0.8
        scoped: [scoped({ eviction: { evicts: true, score: 0.8, reason: null } })],
        currentRuntimeMinutes: 105,
        budgetMinutes: 105,
      }),
    )
    expect(decision.action).toBe('remove')
  })
})

describe('decide — NOOP path', () => {
  it('NOOPs when no un-mutated candidates and no eviction-ripe scoped', () => {
    const decision = decide(input({ unMutated: [], scoped: [scoped()] }))
    expect(decision.action).toBe('noop')
  })

  it('NOOPs when top candidate below threshold AND no scoped graduates', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.3 })],
        scoped: [scoped({ eviction: { evicts: false, score: 0.4, reason: 'fix rate below' } })],
      }),
    )
    expect(decision.action).toBe('noop')
  })

  it('NOOP reasoning explains the closest-to-graduation scoped module', () => {
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.6, estimatedRuntimeMinutes: 10 })],
        scoped: [
          scoped({
            modulePath: 'src/almost.ts',
            eviction: { evicts: false, score: 0.6, reason: 'fix rate 65% below 70%' },
          }),
        ],
        currentRuntimeMinutes: 100,
        budgetMinutes: 105,
      }),
    )
    expect(decision.action).toBe('noop')
    if (decision.action === 'noop') {
      expect(decision.reasoning).toMatch(/src\/almost\.ts/)
      expect(decision.reasoning).toMatch(/0\.600|0\.6/)
    }
  })
})

describe('decide — eviction-threshold gate', () => {
  it('does NOT swap when graduated scoped is below evictionThreshold', () => {
    // Module's eviction.evicts is true (passes predicate) but its score is 0.65,
    // below the configured threshold 0.7. SWAP bar not cleared.
    const decision = decide(
      input({
        unMutated: [candidate({ inclusionScore: 0.95 })],
        scoped: [scoped({ eviction: { evicts: true, score: 0.65, reason: null } })],
        currentRuntimeMinutes: 105,
        budgetMinutes: 105,
        evictionThreshold: 0.7,
      }),
    )
    expect(decision.action).toBe('noop')
  })
})
