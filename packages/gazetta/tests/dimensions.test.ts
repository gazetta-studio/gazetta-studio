/**
 * Tests for the dimensional schema primitives in `schema/dimensions.ts`.
 *
 * Covers:
 *   - DIMENSION_ORDER constant (locked: locale before theme)
 *   - buildSelector — non-empty filtering, null when all dimensions absent
 *   - selectorSuffix — deterministic order regardless of Map insertion
 *   - selectorsEqual — value comparison ignoring iteration order
 *   - isNonEmptySelector — type guard
 */
import { describe, expect, it } from 'vitest'
import {
  DIMENSION_ORDER,
  buildSelector,
  isNonEmptySelector,
  selectorSuffix,
  selectorsEqual,
} from '../src/schema/dimensions.js'

describe('DIMENSION_ORDER', () => {
  it('is locked to locale before theme', () => {
    expect(DIMENSION_ORDER).toEqual(['locale', 'theme'])
  })
})

describe('buildSelector', () => {
  it('returns null when no dimensions are set', () => {
    expect(buildSelector({})).toBeNull()
  })

  it('returns null when only undefined values are passed', () => {
    expect(buildSelector({ locale: undefined, theme: undefined })).toBeNull()
  })

  it('builds a single-dimension selector', () => {
    const sel = buildSelector({ locale: 'fr' })
    expect(sel).not.toBeNull()
    expect(sel!.get('locale')).toBe('fr')
    expect(sel!.has('theme')).toBe(false)
  })

  it('builds a multi-dimension selector', () => {
    const sel = buildSelector({ locale: 'fr', theme: 'dark' })
    expect(sel).not.toBeNull()
    expect(sel!.get('locale')).toBe('fr')
    expect(sel!.get('theme')).toBe('dark')
  })

  it('preserves DIMENSION_ORDER when iterating', () => {
    // Pass theme before locale to test that buildSelector doesn't preserve
    // input order — it walks DIMENSION_ORDER.
    const sel = buildSelector({ theme: 'dark', locale: 'fr' })
    expect(sel).not.toBeNull()
    expect([...sel!.keys()]).toEqual(['locale', 'theme'])
  })
})

describe('selectorSuffix', () => {
  it('returns empty string for null selector', () => {
    expect(selectorSuffix(null)).toBe('')
  })

  it('returns single-dimension suffix', () => {
    expect(selectorSuffix(buildSelector({ locale: 'fr' }))).toBe('.fr')
    expect(selectorSuffix(buildSelector({ theme: 'dark' }))).toBe('.dark')
  })

  it('returns multi-dimension suffix in DIMENSION_ORDER', () => {
    expect(selectorSuffix(buildSelector({ locale: 'fr', theme: 'dark' }))).toBe('.fr.dark')
  })

  it('produces same suffix regardless of construction order', () => {
    const a = buildSelector({ locale: 'fr', theme: 'dark' })
    // Manually build with reverse insertion order
    const b: ReadonlyMap<'locale' | 'theme', string> = new Map([
      ['theme', 'dark'],
      ['locale', 'fr'],
    ])
    expect(selectorSuffix(a)).toBe(selectorSuffix(b))
    expect(selectorSuffix(b)).toBe('.fr.dark')
  })
})

describe('selectorsEqual', () => {
  it('considers null === null', () => {
    expect(selectorsEqual(null, null)).toBe(true)
  })

  it('considers null and any non-null selector unequal', () => {
    expect(selectorsEqual(null, buildSelector({ locale: 'fr' }))).toBe(false)
    expect(selectorsEqual(buildSelector({ locale: 'fr' }), null)).toBe(false)
  })

  it('compares value equality, ignoring iteration order', () => {
    const a = buildSelector({ locale: 'fr', theme: 'dark' })
    const b: ReadonlyMap<'locale' | 'theme', string> = new Map([
      ['theme', 'dark'],
      ['locale', 'fr'],
    ])
    expect(selectorsEqual(a, b)).toBe(true)
  })

  it('returns false for different sizes', () => {
    expect(selectorsEqual(buildSelector({ locale: 'fr' }), buildSelector({ locale: 'fr', theme: 'dark' }))).toBe(false)
  })

  it('returns false for same keys, different values', () => {
    expect(selectorsEqual(buildSelector({ locale: 'fr' }), buildSelector({ locale: 'de' }))).toBe(false)
  })
})

describe('isNonEmptySelector', () => {
  it('returns false for null', () => {
    expect(isNonEmptySelector(null)).toBe(false)
  })

  it('returns true for any non-null selector with values', () => {
    expect(isNonEmptySelector(buildSelector({ locale: 'fr' }))).toBe(true)
  })
})
