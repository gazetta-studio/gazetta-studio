import { describe, it, expect } from 'vitest'
import { timingSafeCompare } from '../src/admin-api/middleware/timing-safe-compare.js'

describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('Bearer secret123', 'Bearer secret123')).toBe(true)
  })

  it('returns false for same-length differing strings', () => {
    expect(timingSafeCompare('Bearer secret123', 'Bearer wrong456')).toBe(false)
  })

  it('returns false for different-length strings without throwing', () => {
    // node:crypto timingSafeEqual throws on different-length buffers — the helper
    // must pad or short-circuit so callers get a boolean rather than a RangeError.
    expect(() => timingSafeCompare('Bearer secret123', 'Bearer secret')).not.toThrow()
    expect(timingSafeCompare('Bearer secret123', 'Bearer secret')).toBe(false)
    expect(timingSafeCompare('short', 'much-longer-string-here')).toBe(false)
  })

  it('returns false when one input is empty', () => {
    expect(timingSafeCompare('', 'Bearer secret123')).toBe(false)
    expect(timingSafeCompare('Bearer secret123', '')).toBe(false)
  })

  it('returns true for empty/empty (boundary case)', () => {
    expect(timingSafeCompare('', '')).toBe(true)
  })

  it('handles unicode without truncation surprises', () => {
    expect(timingSafeCompare('Bearer 日本語', 'Bearer 日本語')).toBe(true)
    expect(timingSafeCompare('Bearer 日本語', 'Bearer 한국어')).toBe(false)
  })

  it('returns false for single-byte difference at start (canary against !== short-circuit)', () => {
    // With !== short-circuit, this would return false faster than a tail mismatch —
    // the timing-safe helper must compare every byte regardless of where the difference is.
    expect(timingSafeCompare('Xearer secret', 'Bearer secret')).toBe(false)
  })

  it('returns false for single-byte difference at end', () => {
    expect(timingSafeCompare('Bearer secreX', 'Bearer secret')).toBe(false)
  })
})
