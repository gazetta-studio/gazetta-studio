/**
 * Tests for theme resolution in `themes.ts`.
 *
 * Covers:
 *   - isValidTheme — pattern, locale-collision rejection, casing
 *   - resolveSiteThemes — config validation, default inference, collision errors
 *   - resolveTargetThemes — inheritance vs override
 */
import { describe, expect, it } from 'vitest'
import type { SiteManifest } from '../src/types.js'
import { isValidTheme, normalizeTheme, resolveSiteThemes, resolveTargetThemes } from '../src/themes.js'

describe('isValidTheme', () => {
  it('accepts canonical theme names', () => {
    expect(isValidTheme('light')).toBe(true)
    expect(isValidTheme('dark')).toBe(true)
    expect(isValidTheme('high-contrast')).toBe(true)
    expect(isValidTheme('brand_a')).toBe(true)
  })

  it('rejects empty / whitespace', () => {
    expect(isValidTheme('')).toBe(false)
    expect(isValidTheme(' ')).toBe(false)
    expect(isValidTheme('\t')).toBe(false)
  })

  it('rejects names with dots (filename-suffix collision)', () => {
    expect(isValidTheme('foo.bar')).toBe(false)
    expect(isValidTheme('.dark')).toBe(false)
  })

  it('rejects mixed case (normalization is required)', () => {
    expect(isValidTheme('Dark')).toBe(false)
    expect(isValidTheme('LIGHT')).toBe(false)
  })

  it('rejects names that collide with valid BCP 47 locale codes', () => {
    expect(isValidTheme('en')).toBe(false)
    expect(isValidTheme('fr')).toBe(false)
    expect(isValidTheme('pt-br')).toBe(false)
  })

  it('rejects names starting with a digit or special char', () => {
    expect(isValidTheme('1dark')).toBe(false)
    expect(isValidTheme('-dark')).toBe(false)
    expect(isValidTheme('_dark')).toBe(false)
  })
})

describe('normalizeTheme', () => {
  it('lowercases', () => {
    expect(normalizeTheme('Dark')).toBe('dark')
    expect(normalizeTheme('HIGH_CONTRAST')).toBe('high_contrast')
  })
})

describe('resolveSiteThemes', () => {
  function site(themes?: SiteManifest['themes']): SiteManifest {
    return { name: 'test', themes }
  }

  it('returns null when themes config is absent', () => {
    expect(resolveSiteThemes(site())).toBeNull()
  })

  it('throws when supported list is empty', () => {
    expect(() => resolveSiteThemes(site({ supported: [] }))).toThrow(/non-empty/)
  })

  it('throws when supported list is not an array', () => {
    expect(() => resolveSiteThemes(site({ supported: 'light' as unknown as string[] }))).toThrow(/non-empty/)
  })

  it('infers default from first supported when default is unset', () => {
    const r = resolveSiteThemes(site({ supported: ['light', 'dark'] }))
    expect(r).toEqual({ supported: ['light', 'dark'], default: 'light' })
  })

  it('honors explicit default', () => {
    const r = resolveSiteThemes(site({ supported: ['light', 'dark'], default: 'dark' }))
    expect(r).toEqual({ supported: ['light', 'dark'], default: 'dark' })
  })

  it('throws when explicit default is not in supported', () => {
    expect(() => resolveSiteThemes(site({ supported: ['light', 'dark'], default: 'sepia' }))).toThrow(
      /themes\.default.*not in/i,
    )
  })

  it('rejects theme names that collide with locale codes', () => {
    expect(() => resolveSiteThemes(site({ supported: ['en'] }))).toThrow(/Invalid theme name/)
  })

  it('rejects malformed names that survive normalization', () => {
    expect(() => resolveSiteThemes(site({ supported: ['foo.bar'] }))).toThrow(/Invalid theme name/)
    expect(() => resolveSiteThemes(site({ supported: ['1dark'] }))).toThrow(/Invalid theme name/)
  })

  it('normalizes uppercase input to lowercase before validation', () => {
    // Site config can use any case in YAML; resolver normalizes.
    // `DARK` becomes `dark`, which is a valid theme name.
    const r = resolveSiteThemes(site({ supported: ['DARK'] }))
    expect(r).toEqual({ supported: ['dark'], default: 'dark' })
  })

  it('rejects duplicate names after normalization', () => {
    expect(() => resolveSiteThemes(site({ supported: ['dark', 'Dark'] }))).toThrow(/Duplicate/)
  })
})

describe('resolveTargetThemes', () => {
  it('inherits site themes when target has no override', () => {
    const siteThemes = { supported: ['light', 'dark'], default: 'light' }
    expect(resolveTargetThemes(siteThemes)).toBe(siteThemes)
  })

  it('inherits null when site has no themes', () => {
    expect(resolveTargetThemes(null)).toBeNull()
  })

  it('applies target override when provided', () => {
    const siteThemes = { supported: ['light', 'dark'], default: 'light' }
    const override = { supported: ['dark'], default: 'dark' }
    expect(resolveTargetThemes(siteThemes, override)).toEqual({ supported: ['dark'], default: 'dark' })
  })

  it('validates override config', () => {
    expect(() => resolveTargetThemes(null, { supported: ['en'] })).toThrow(/Invalid theme name/)
  })
})
