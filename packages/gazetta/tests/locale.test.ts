import { describe, it, expect } from 'vitest'
import {
  isValidLocale,
  normalizeLocale,
  resolveSiteLocales,
  resolveTargetLocales,
  localeFromFilename,
  localeFilename,
  resolveLocaleFallback,
  localeFallbackChain,
  localeRoutePrefix,
} from '../src/locale.js'
import { resolveSeoTags, type SeoContext } from '../src/seo.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

describe('isValidLocale', () => {
  it('accepts simple locale codes', () => {
    expect(isValidLocale('fr')).toBe(true)
    expect(isValidLocale('en')).toBe(true)
    expect(isValidLocale('de')).toBe(true)
  })

  it('accepts region codes', () => {
    expect(isValidLocale('en-gb')).toBe(true)
    expect(isValidLocale('pt-br')).toBe(true)
    expect(isValidLocale('zh-hans')).toBe(true)
  })

  it('accepts uppercase (case-insensitive check)', () => {
    expect(isValidLocale('FR')).toBe(true)
    expect(isValidLocale('EN-GB')).toBe(true)
    expect(isValidLocale('pt-BR')).toBe(true)
  })

  it('rejects path traversal', () => {
    expect(isValidLocale('../etc')).toBe(false)
    expect(isValidLocale('fr/../en')).toBe(false)
    expect(isValidLocale('..')).toBe(false)
  })

  it('rejects dots', () => {
    expect(isValidLocale('fr.json')).toBe(false)
    expect(isValidLocale('en.gb')).toBe(false)
  })

  it('rejects scripts and special chars', () => {
    expect(isValidLocale('<script>')).toBe(false)
    expect(isValidLocale('fr;drop')).toBe(false)
    expect(isValidLocale('fr/en')).toBe(false)
  })

  it('rejects empty and whitespace', () => {
    expect(isValidLocale('')).toBe(false)
    expect(isValidLocale(' ')).toBe(false)
    expect(isValidLocale('  fr  ')).toBe(false)
  })

  it('rejects single char', () => {
    expect(isValidLocale('f')).toBe(false)
  })

  it('rejects overly long codes', () => {
    expect(isValidLocale('a'.repeat(128))).toBe(false)
  })

  it('rejects null bytes', () => {
    expect(isValidLocale('fr\x00xx')).toBe(false)
  })
})

describe('normalizeLocale', () => {
  it('lowercases simple codes', () => {
    expect(normalizeLocale('EN')).toBe('en')
    expect(normalizeLocale('Fr')).toBe('fr')
  })

  it('lowercases region codes', () => {
    expect(normalizeLocale('en-GB')).toBe('en-gb')
    expect(normalizeLocale('pt-BR')).toBe('pt-br')
  })

  it('passes through already-lowercase', () => {
    expect(normalizeLocale('fr')).toBe('fr')
  })
})

describe('resolveSiteLocales', () => {
  it('returns null when no locales config', () => {
    expect(resolveSiteLocales({ name: 'test' })).toBeNull()
  })

  it('returns null for empty supported list', () => {
    expect(resolveSiteLocales({ name: 'test', locales: { supported: [] } })).toBeNull()
  })

  it('uses explicit locale as default', () => {
    const result = resolveSiteLocales({ name: 'test', locale: 'fr', locales: { supported: ['en', 'fr'] } })
    expect(result?.default).toBe('fr')
  })

  it('falls back to first in supported when locale not set', () => {
    const result = resolveSiteLocales({ name: 'test', locales: { supported: ['fr', 'en'] } })
    expect(result?.default).toBe('fr')
  })

  it('normalizes locale codes', () => {
    const result = resolveSiteLocales({ name: 'test', locales: { supported: ['en-GB', 'pt-BR'] } })
    expect(result?.supported).toEqual(['en-gb', 'pt-br'])
    expect(result?.default).toBe('en-gb')
  })

  it('defaults for detection and defaultPrefix', () => {
    const result = resolveSiteLocales({ name: 'test', locales: { supported: ['en', 'fr'] } })
    expect(result?.detection).toBe(false)
    expect(result?.defaultPrefix).toBe(false)
  })

  it('respects explicit detection and defaultPrefix', () => {
    const result = resolveSiteLocales({
      name: 'test',
      locales: { supported: ['en', 'fr'], detection: true, defaultPrefix: true },
    })
    expect(result?.detection).toBe(true)
    expect(result?.defaultPrefix).toBe(true)
  })

  it('normalizes fallback keys and values', () => {
    const result = resolveSiteLocales({
      name: 'test',
      locales: { supported: ['en', 'pt', 'pt-BR'], fallbacks: { 'pt-BR': 'pt' } },
    })
    expect(result?.fallbacks).toEqual({ 'pt-br': 'pt' })
  })
})

describe('resolveTargetLocales', () => {
  const site: SiteManifest = { name: 'test', locale: 'en', locales: { supported: ['en', 'fr', 'de'] } }

  it('returns null when site has no i18n', () => {
    expect(resolveTargetLocales({} as TargetConfig, { name: 'test' })).toBeNull()
  })

  it('inherits site locales when target has no override', () => {
    const result = resolveTargetLocales({ storage: memoryStorage() }, site)
    expect(result?.supported).toEqual(['en', 'fr', 'de'])
    expect(result?.default).toBe('en')
  })

  it('narrows locales with target override', () => {
    const result = resolveTargetLocales({ storage: memoryStorage(), locales: ['de', 'en'] }, site)
    expect(result?.supported).toEqual(['de', 'en'])
    expect(result?.default).toBe('en')
  })

  it('overrides default locale', () => {
    const result = resolveTargetLocales({ storage: memoryStorage(), locales: ['de', 'en'], locale: 'de' }, site)
    expect(result?.default).toBe('de')
  })

  it('infers default for single-locale target', () => {
    const result = resolveTargetLocales({ storage: memoryStorage(), locales: ['fr'] }, site)
    expect(result?.default).toBe('fr')
    expect(result?.detection).toBe(false)
  })

  it('inherits detection from site', () => {
    const siteWithDetection: SiteManifest = {
      name: 'test',
      locales: { supported: ['en', 'fr'], detection: true },
    }
    const result = resolveTargetLocales({ storage: memoryStorage() }, siteWithDetection)
    expect(result?.detection).toBe(true)
  })

  it('target overrides detection', () => {
    const siteWithDetection: SiteManifest = {
      name: 'test',
      locales: { supported: ['en', 'fr'], detection: true },
    }
    const result = resolveTargetLocales({ storage: memoryStorage(), detection: false }, siteWithDetection)
    expect(result?.detection).toBe(false)
  })
})

describe('localeFromFilename', () => {
  it('returns null for default locale file', () => {
    expect(localeFromFilename('page.json', 'page')).toBeNull()
    expect(localeFromFilename('fragment.json', 'fragment')).toBeNull()
  })

  it('extracts simple locale', () => {
    expect(localeFromFilename('page.fr.json', 'page')).toBe('fr')
    expect(localeFromFilename('fragment.de.json', 'fragment')).toBe('de')
  })

  it('extracts region locale', () => {
    expect(localeFromFilename('page.en-gb.json', 'page')).toBe('en-gb')
    expect(localeFromFilename('page.pt-br.json', 'page')).toBe('pt-br')
  })

  it('returns null for unrelated files', () => {
    expect(localeFromFilename('index.html', 'page')).toBeNull()
    expect(localeFromFilename('styles.css', 'page')).toBeNull()
  })
})

describe('localeFilename', () => {
  it('returns base.json for null locale', () => {
    expect(localeFilename('page', null)).toBe('page.json')
  })

  it('returns base.locale.json for locale', () => {
    expect(localeFilename('page', 'fr')).toBe('page.fr.json')
    expect(localeFilename('fragment', 'en-gb')).toBe('fragment.en-gb.json')
  })

  it('normalizes locale to lowercase', () => {
    expect(localeFilename('page', 'EN-GB')).toBe('page.en-gb.json')
  })
})

describe('resolveLocaleFallback', () => {
  const resolved = {
    supported: ['en', 'fr', 'pt', 'pt-br'],
    default: 'en',
    defaultPrefix: false,
    detection: false,
    fallbacks: { 'pt-br': 'pt' },
  }

  it('returns the locale if available', () => {
    expect(resolveLocaleFallback('fr', new Set(['en', 'fr']), resolved)).toBe('fr')
  })

  it('walks fallback chain', () => {
    expect(resolveLocaleFallback('pt-br', new Set(['en', 'pt']), resolved)).toBe('pt')
  })

  it('falls back to default when chain exhausted', () => {
    expect(resolveLocaleFallback('de', new Set(['en', 'fr']), resolved)).toBe('en')
  })

  it('normalizes input locale', () => {
    expect(resolveLocaleFallback('FR', new Set(['en', 'fr']), resolved)).toBe('fr')
  })
})

describe('localeRoutePrefix', () => {
  const resolved = {
    supported: ['en', 'fr'],
    default: 'en',
    defaultPrefix: false,
    detection: false,
    fallbacks: {},
  }

  it('returns empty for default locale', () => {
    expect(localeRoutePrefix('en', resolved)).toBe('')
  })

  it('returns /locale for non-default', () => {
    expect(localeRoutePrefix('fr', resolved)).toBe('/fr')
  })

  it('returns /locale for default when defaultPrefix is true', () => {
    const withPrefix = { ...resolved, defaultPrefix: true }
    expect(localeRoutePrefix('en', withPrefix)).toBe('/en')
  })

  it('normalizes locale', () => {
    expect(localeRoutePrefix('FR', resolved)).toBe('/fr')
  })
})

describe('hreflang in resolveSeoTags', () => {
  const baseSeo: SeoContext = { siteUrl: 'https://example.com', locale: 'en' }

  it('emits hreflang tags when alternates have 2+ entries', () => {
    const seo: SeoContext = {
      ...baseSeo,
      hreflangAlternates: { en: 'https://example.com/about', fr: 'https://example.com/fr/about' },
      defaultLocale: 'en',
    }
    const result = resolveSeoTags({ seo, route: '/about' })
    expect(result).toContain('hreflang="en"')
    expect(result).toContain('href="https://example.com/about"')
    expect(result).toContain('hreflang="fr"')
    expect(result).toContain('href="https://example.com/fr/about"')
  })

  it('emits x-default pointing to default locale', () => {
    const seo: SeoContext = {
      ...baseSeo,
      hreflangAlternates: { en: 'https://example.com/about', fr: 'https://example.com/fr/about' },
      defaultLocale: 'en',
    }
    const result = resolveSeoTags({ seo, route: '/about' })
    expect(result).toContain('hreflang="x-default"')
    expect(result).toContain('href="https://example.com/about"')
  })

  it('omits hreflang when only one alternate', () => {
    const seo: SeoContext = {
      ...baseSeo,
      hreflangAlternates: { en: 'https://example.com/about' },
      defaultLocale: 'en',
    }
    const result = resolveSeoTags({ seo, route: '/about' })
    expect(result).not.toContain('hreflang')
  })

  it('omits hreflang when no alternates', () => {
    const result = resolveSeoTags({ seo: baseSeo, route: '/about' })
    expect(result).not.toContain('hreflang')
  })

  it('includes self-referencing alternate', () => {
    const seo: SeoContext = {
      ...baseSeo,
      locale: 'fr',
      hreflangAlternates: { en: 'https://example.com/about', fr: 'https://example.com/fr/about' },
      defaultLocale: 'en',
    }
    const result = resolveSeoTags({ seo, route: '/fr/about' })
    // Both locales present — including the current page's own locale
    expect(result).toContain('hreflang="fr"')
    expect(result).toContain('hreflang="en"')
  })

  it('escapes locale codes in hreflang', () => {
    const seo: SeoContext = {
      ...baseSeo,
      hreflangAlternates: { 'en-gb': 'https://example.com/about', fr: 'https://example.com/fr/about' },
      defaultLocale: 'en-gb',
    }
    const result = resolveSeoTags({ seo, route: '/about' })
    expect(result).toContain('hreflang="en-gb"')
  })
})

describe('localeFallbackChain', () => {
  const resolved = {
    supported: ['en', 'fr', 'pt-br', 'pt'],
    default: 'en',
    defaultPrefix: false,
    detection: false,
    fallbacks: { 'pt-br': 'pt' },
  }

  it('returns empty when active equals default', () => {
    expect(localeFallbackChain('en', resolved)).toEqual([])
  })

  it('returns [active] when no fallback is configured', () => {
    expect(localeFallbackChain('fr', resolved)).toEqual(['fr'])
  })

  it('walks the fallback chain, excluding default', () => {
    expect(localeFallbackChain('pt-br', resolved)).toEqual(['pt-br', 'pt'])
  })

  it('stops at default — default is the floor, never in chain', () => {
    const r = {
      ...resolved,
      // Build a chain that explicitly leads to default; chain must not include 'en'.
      fallbacks: { fr: 'en' },
    }
    expect(localeFallbackChain('fr', r)).toEqual(['fr'])
  })

  it('handles cycles defensively (never re-adds a locale)', () => {
    const r = {
      ...resolved,
      fallbacks: { 'pt-br': 'pt', pt: 'pt-br' }, // cyclic
    }
    // Should walk pt-br → pt and stop (pt-br already seen, also chain length bound).
    expect(localeFallbackChain('pt-br', r)).toEqual(['pt-br', 'pt'])
  })

  it('normalizes input to lowercase', () => {
    expect(localeFallbackChain('PT-BR', resolved)).toEqual(['pt-br', 'pt'])
  })
})
