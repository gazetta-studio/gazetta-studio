/**
 * Tests for selector-aware filename composers in `assets/manifest.ts`.
 *
 * Locks the storage filename scheme:
 *   default              → `{name}.asset.json` / `{name}-{hash}.{ext}`
 *   locale variant       → `{name}.asset.{locale}.json` / `{name}-{hash}.{locale}.{ext}`
 *   theme variant        → `{name}.asset.{theme}.json` / `{name}-{hash}.{theme}.{ext}`
 *   locale + theme       → `{name}.asset.{locale}.{theme}.json` / `{name}-{hash}.{locale}.{theme}.{ext}`
 *
 * The order in selector composition follows DIMENSION_ORDER (locale before theme).
 * Width suffix on variants comes AFTER the selector suffix.
 */
import { describe, expect, it } from 'vitest'
import { assetBytesPath, assetVariantBytesPath, manifestPath } from '../src/assets/manifest.js'
import { buildSelector } from '../src/schema/dimensions.js'

describe('manifestPath', () => {
  it('returns default manifest filename when selector is null/omitted', () => {
    expect(manifestPath('hero')).toBe('hero.asset.json')
    expect(manifestPath('hero', null)).toBe('hero.asset.json')
  })

  it('appends locale suffix', () => {
    expect(manifestPath('hero', buildSelector({ locale: 'fr' }))).toBe('hero.asset.fr.json')
  })

  it('appends theme suffix', () => {
    expect(manifestPath('hero', buildSelector({ theme: 'dark' }))).toBe('hero.asset.dark.json')
  })

  it('appends locale and theme in DIMENSION_ORDER (locale before theme)', () => {
    expect(manifestPath('hero', buildSelector({ locale: 'fr', theme: 'dark' }))).toBe('hero.asset.fr.dark.json')
  })

  it('preserves DIMENSION_ORDER regardless of selector construction', () => {
    // Construct selector with theme first
    const sel: ReadonlyMap<'locale' | 'theme', string> = new Map([
      ['theme', 'dark'],
      ['locale', 'fr'],
    ])
    expect(manifestPath('hero', sel)).toBe('hero.asset.fr.dark.json')
  })
})

describe('assetBytesPath', () => {
  it('returns default bytes path when selector is null/omitted', () => {
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg')).toBe('hero-a3b2c1d4.jpg')
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg', null)).toBe('hero-a3b2c1d4.jpg')
  })

  it('accepts ext with or without leading dot', () => {
    expect(assetBytesPath('hero', 'a3b2c1d4', '.jpg')).toBe('hero-a3b2c1d4.jpg')
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg')).toBe('hero-a3b2c1d4.jpg')
  })

  it('appends locale suffix', () => {
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg', buildSelector({ locale: 'fr' }))).toBe('hero-a3b2c1d4.fr.jpg')
  })

  it('appends theme suffix', () => {
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg', buildSelector({ theme: 'dark' }))).toBe('hero-a3b2c1d4.dark.jpg')
  })

  it('appends locale and theme', () => {
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg', buildSelector({ locale: 'fr', theme: 'dark' }))).toBe(
      'hero-a3b2c1d4.fr.dark.jpg',
    )
  })
})

describe('assetVariantBytesPath', () => {
  it('returns default variant path when selector is null/omitted', () => {
    expect(assetVariantBytesPath('hero', 'a3b2c1d4', 'jpg', 800)).toBe('hero-a3b2c1d4-800w.jpg')
    expect(assetVariantBytesPath('hero', 'a3b2c1d4', 'jpg', 800, null)).toBe('hero-a3b2c1d4-800w.jpg')
  })

  it('appends width suffix AFTER selector suffix', () => {
    // Variant ladder belongs to a specific bytes set — selector identifies
    // which override; width identifies which rung of the ladder for that override.
    expect(assetVariantBytesPath('hero', 'a3b2c1d4', 'jpg', 800, buildSelector({ locale: 'fr' }))).toBe(
      'hero-a3b2c1d4.fr-800w.jpg',
    )
  })

  it('appends locale + theme + width in correct order', () => {
    expect(assetVariantBytesPath('hero', 'a3b2c1d4', 'jpg', 1200, buildSelector({ locale: 'fr', theme: 'dark' }))).toBe(
      'hero-a3b2c1d4.fr.dark-1200w.jpg',
    )
  })

  it('all four widths produce distinct paths', () => {
    const paths = [400, 800, 1200, 1600].map(w => assetVariantBytesPath('hero', 'a3b2c1d4', 'jpg', w))
    expect(new Set(paths).size).toBe(4)
  })
})
