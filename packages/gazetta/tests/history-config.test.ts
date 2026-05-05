/**
 * Unit tests for the history config helpers on TargetConfig.
 */
import { describe, it, expect } from 'vitest'
import type { TargetConfig } from '../src/types.js'
import { isHistoryEnabled, getHistoryRetention, DEFAULT_HISTORY_RETENTION } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function T(history?: TargetConfig['history']): TargetConfig {
  return { storage: memoryStorage(), history }
}

describe('isHistoryEnabled', () => {
  it('defaults to true when no history config is set', () => {
    expect(isHistoryEnabled(T())).toBe(true)
  })
  it('defaults to true when history config is present but enabled is omitted', () => {
    expect(isHistoryEnabled(T({ retention: 100 }))).toBe(true)
  })
  it('false when explicitly disabled', () => {
    expect(isHistoryEnabled(T({ enabled: false }))).toBe(false)
  })
  it('true when explicitly enabled', () => {
    expect(isHistoryEnabled(T({ enabled: true }))).toBe(true)
  })
})

describe('getHistoryRetention', () => {
  it(`defaults to ${DEFAULT_HISTORY_RETENTION} when unset`, () => {
    expect(getHistoryRetention(T())).toBe(DEFAULT_HISTORY_RETENTION)
    expect(getHistoryRetention(T({ enabled: true }))).toBe(DEFAULT_HISTORY_RETENTION)
  })
  it('uses the configured retention when set', () => {
    expect(getHistoryRetention(T({ retention: 100 }))).toBe(100)
    expect(getHistoryRetention(T({ retention: 5 }))).toBe(5)
  })
  it('clamps 0 and negatives to 1 (use enabled:false to disable)', () => {
    expect(getHistoryRetention(T({ retention: 0 }))).toBe(1)
    expect(getHistoryRetention(T({ retention: -5 }))).toBe(1)
  })
})
