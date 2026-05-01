/**
 * Tests for `selector-chain.ts` — the cross-dimension fallback chain.
 *
 * Locks the locale-priority ordering in tests so a future "let me change
 * to theme-priority by accident" PR fails loudly.
 *
 * Covers:
 *   - Single-dimension sites (only locale, only theme)
 *   - Cross-product order (locale outer, theme inner)
 *   - Default exclusion (no all-defaults selector in the chain)
 *   - Locale fallback chain integration
 *   - Active === default → empty axis on that dimension
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedLocales } from '../src/locale.js'
import { crossDimensionFallbackChain } from '../src/selector-chain.js'
import type { ResolvedThemes } from '../src/themes.js'

const locales: ResolvedLocales = {
  supported: ['en', 'fr', 'pt-br', 'pt'],
  default: 'en',
  defaultPrefix: false,
  detection: false,
  fallbacks: { 'pt-br': 'pt' },
}

const themes: ResolvedThemes = {
  supported: ['light', 'dark'],
  default: 'light',
}

function chainAsArrays(chain: ReadonlyArray<ReadonlyMap<string, string>>): Array<Record<string, string>> {
  return chain.map(s => Object.fromEntries(s))
}

describe('crossDimensionFallbackChain', () => {
  describe('no dimensions active', () => {
    it('empty when neither locale nor theme is set', () => {
      expect(crossDimensionFallbackChain({ locales: null, themes: null })).toEqual([])
    })

    it('empty when active matches defaults on both axes', () => {
      expect(crossDimensionFallbackChain({ locale: 'en', theme: 'light', locales, themes })).toEqual([])
    })
  })

  describe('locale only', () => {
    it('empty when site has no locales config', () => {
      expect(crossDimensionFallbackChain({ locale: 'fr', locales: null, themes: null })).toEqual([])
    })

    it('lists active locale when non-default', () => {
      expect(chainAsArrays(crossDimensionFallbackChain({ locale: 'fr', locales, themes: null }))).toEqual([
        { locale: 'fr' },
      ])
    })

    it('walks the fallback chain', () => {
      expect(chainAsArrays(crossDimensionFallbackChain({ locale: 'pt-br', locales, themes: null }))).toEqual([
        { locale: 'pt-br' },
        { locale: 'pt' },
      ])
    })

    it('empty chain when active locale equals default', () => {
      expect(crossDimensionFallbackChain({ locale: 'en', locales, themes: null })).toEqual([])
    })
  })

  describe('theme only', () => {
    it('empty when site has no themes config', () => {
      expect(crossDimensionFallbackChain({ theme: 'dark', locales: null, themes: null })).toEqual([])
    })

    it('lists active theme when non-default', () => {
      expect(chainAsArrays(crossDimensionFallbackChain({ theme: 'dark', locales: null, themes }))).toEqual([
        { theme: 'dark' },
      ])
    })

    it('empty chain when active theme equals default', () => {
      expect(crossDimensionFallbackChain({ theme: 'light', locales: null, themes })).toEqual([])
    })
  })

  describe('both dimensions, locale-priority cross-product', () => {
    it('orders locale outer, theme inner (locked: locale-priority)', () => {
      // Active (fr, dark), site default (en, light) → produces:
      //   1. (fr, dark)             — most specific
      //   2. (fr, light)            — locale match, default theme
      //   3. (default-locale, dark) — only theme match
      //   (default, default) excluded — that's the base manifest
      expect(chainAsArrays(crossDimensionFallbackChain({ locale: 'fr', theme: 'dark', locales, themes }))).toEqual([
        { locale: 'fr', theme: 'dark' },
        { locale: 'fr' },
        { theme: 'dark' },
      ])
    })

    it('walks locale fallback chain across both axes', () => {
      // Active (pt-br, dark) with pt-br → pt fallback. Locale axis is
      // [pt-br, pt, null]; theme axis is [dark, null]. Cross-product is
      // 6 cells minus the all-default → 5 selectors.
      expect(chainAsArrays(crossDimensionFallbackChain({ locale: 'pt-br', theme: 'dark', locales, themes }))).toEqual([
        { locale: 'pt-br', theme: 'dark' },
        { locale: 'pt-br' },
        { locale: 'pt', theme: 'dark' },
        { locale: 'pt' },
        { theme: 'dark' },
      ])
    })

    it('drops locale dimension when active locale equals default', () => {
      // Active (en, dark) — locale axis is [null] only; theme axis is [dark, null].
      // Cross-product: { theme: 'dark' } and the all-default (excluded).
      expect(chainAsArrays(crossDimensionFallbackChain({ locale: 'en', theme: 'dark', locales, themes }))).toEqual([
        { theme: 'dark' },
      ])
    })

    it('drops theme dimension when active theme equals default', () => {
      // Active (fr, light) — theme axis is [null]; locale axis is [fr, null].
      // Cross-product: { locale: 'fr' } and the all-default (excluded).
      expect(chainAsArrays(crossDimensionFallbackChain({ locale: 'fr', theme: 'light', locales, themes }))).toEqual([
        { locale: 'fr' },
      ])
    })
  })
})
