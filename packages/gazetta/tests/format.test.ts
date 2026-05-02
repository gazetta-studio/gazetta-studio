/**
 * Unit tests for the shared display formatters in `gazetta/format`.
 * These are extracted from the CLI + admin (per the "3+ callers"
 * extraction rule); the tests live here because the module lives
 * in `packages/gazetta`.
 */
import { describe, expect, it } from 'vitest'
import { formatAltStatus, formatBytes, formatFocalPoint, shortDate } from '../src/format.js'

describe('formatBytes', () => {
  it('renders bytes below 1 KB as raw byte count', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('renders KB for ≥ 1 KB and < 1 MB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB')
  })

  it('renders MB for ≥ 1 MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MB')
  })
})

describe('formatAltStatus', () => {
  it("returns '(unset)' for null", () => {
    expect(formatAltStatus(null)).toBe('(unset)')
  })

  it("returns '(decorative)' for empty string", () => {
    expect(formatAltStatus('')).toBe('(decorative)')
  })

  it('returns the string when meaningful and short', () => {
    expect(formatAltStatus('Mountain sunset')).toBe('Mountain sunset')
  })

  it('truncates at maxLength when set', () => {
    expect(formatAltStatus('A'.repeat(100), 30)).toHaveLength(30)
    expect(formatAltStatus('A'.repeat(100), 30).endsWith('...')).toBe(true)
  })

  it('does not truncate when maxLength is Infinity (default)', () => {
    const long = 'A'.repeat(100)
    expect(formatAltStatus(long)).toBe(long)
  })
})

describe('formatFocalPoint', () => {
  it('renders normalized coords as percentages', () => {
    expect(formatFocalPoint({ x: 0.5, y: 0.5 })).toBe('50% × 50%')
    expect(formatFocalPoint({ x: 0.3, y: 0.7 })).toBe('30% × 70%')
  })

  it('rounds to whole percent', () => {
    expect(formatFocalPoint({ x: 0.426, y: 0.13 })).toBe('43% × 13%')
  })

  it('returns empty string for null/undefined', () => {
    expect(formatFocalPoint(null)).toBe('')
    expect(formatFocalPoint(undefined)).toBe('')
  })
})

describe('shortDate', () => {
  it('returns the yyyy-mm-dd prefix of an ISO date', () => {
    expect(shortDate('2026-04-22T14:23:05Z')).toBe('2026-04-22')
    expect(shortDate('2026-04-22T14:23:05.123Z')).toBe('2026-04-22')
  })

  it('passes through non-ISO inputs unchanged', () => {
    expect(shortDate('not-a-date')).toBe('not-a-date')
    expect(shortDate('')).toBe('')
  })
})
