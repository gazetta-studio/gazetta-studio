/**
 * Tests for `assets/manifest-locale.ts` — locale-variant readers +
 * validators dispatched by kind.
 *
 * Covers:
 *   - Dispatch table maps each kind to the right variant
 *   - Embedded/downloadable validators accept metadata-only AND
 *     bytes-override shapes; reject malformed
 *   - Font validator requires bytes + font-specific fields
 *   - Read returns null on missing; throws on corrupt
 */
import { describe, expect, it } from 'vitest'
import type { StorageProvider } from '../src/types.js'
import { localeManifestVariantFor } from '../src/assets/manifest-locale.js'
import { AssetManifestCorruptError } from '../src/assets/errors.js'
import { buildSelector } from '../src/schema/dimensions.js'
import type { FontLocaleAdditiveManifest, LocaleOverrideManifest } from '../src/schema/types.js'
import { memoryStorage as sharedMemoryStorage } from './_helpers/memory-storage.js'

function memoryStorage(files: Record<string, string>): StorageProvider {
  // Thin wrapper over the shared helper — pre-seeds with text entries so
  // each test reads "given these manifests on disk, …" without re-explaining
  // the mock construction.
  const s = sharedMemoryStorage()
  s.seed(files)
  return s
}

const frSelector = buildSelector({ locale: 'fr' })!

describe('localeManifestVariantFor', () => {
  it('returns embedded variant for kind="embedded"', () => {
    const v = localeManifestVariantFor('embedded')
    expect(typeof v.validate).toBe('function')
    expect(typeof v.read).toBe('function')
  })

  it('returns downloadable variant for kind="downloadable"', () => {
    const v = localeManifestVariantFor('downloadable')
    expect(typeof v.validate).toBe('function')
  })

  it('returns font variant for kind="font"', () => {
    const v = localeManifestVariantFor('font')
    expect(typeof v.validate).toBe('function')
  })
})

describe('embedded locale-override validator', () => {
  const variant = localeManifestVariantFor('embedded')

  it('accepts metadata-only override (no hash)', () => {
    const m: LocaleOverrideManifest = {
      version: 1,
      name: 'hero',
      alt: 'French alt',
    }
    expect(variant.validate(m)).toBe(true)
  })

  it('accepts bytes-override (hash + all byte fields)', () => {
    const m: LocaleOverrideManifest = {
      version: 1,
      name: 'hero',
      hash: 'd5e6f7a8',
      size: 80_000,
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      variants: [{ width: 800, path: 'hero-d5e6f7a8.fr-800w.jpg', size: 25_000 }],
      alt: 'Coucher de soleil',
    }
    expect(variant.validate(m)).toBe(true)
  })

  it('accepts manifest with focalPoint override', () => {
    const m = {
      version: 1,
      name: 'hero',
      focalPoint: { x: 0.3, y: 0.6 },
    }
    expect(variant.validate(m)).toBe(true)
  })

  it('rejects bytes-override missing size', () => {
    const m = {
      version: 1,
      name: 'hero',
      hash: 'd5e6f7a8',
      // no size
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      variants: [],
    }
    expect(variant.validate(m)).toBe(false)
  })

  it('rejects bytes-override missing variants', () => {
    const m = {
      version: 1,
      name: 'hero',
      hash: 'd5e6f7a8',
      size: 80_000,
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      // no variants
    }
    expect(variant.validate(m)).toBe(false)
  })

  it('rejects metadata-only with stray byte field (size present without hash)', () => {
    const m = {
      version: 1,
      name: 'hero',
      // no hash
      size: 80_000, // stray
    }
    expect(variant.validate(m)).toBe(false)
  })

  it('rejects malformed identity', () => {
    expect(variant.validate({ version: 2, name: 'hero' })).toBe(false)
    expect(variant.validate({ version: 1 /* no name */ })).toBe(false)
  })

  it('rejects malformed metadata fields', () => {
    expect(variant.validate({ version: 1, name: 'hero', alt: 42 })).toBe(false)
    expect(variant.validate({ version: 1, name: 'hero', focalPoint: { x: 'a', y: 0.5 } })).toBe(false)
  })

  it('accepts alt as null (explicit decorative override)', () => {
    expect(variant.validate({ version: 1, name: 'hero', alt: null })).toBe(true)
  })
})

describe('font locale-additive validator', () => {
  const variant = localeManifestVariantFor('font')

  const validFontVariant: FontLocaleAdditiveManifest = {
    version: 1,
    name: 'brand-sans',
    hash: 'b9c0d1e2',
    size: 50_000,
    mime: 'font/woff2',
    format: 'woff2',
    weight: 400,
    style: 'normal',
    unicodeRange: 'U+0600-06FF',
  }

  it('accepts a complete font variant', () => {
    expect(variant.validate(validFontVariant)).toBe(true)
  })

  it('accepts unicodeRange as null', () => {
    expect(variant.validate({ ...validFontVariant, unicodeRange: null })).toBe(true)
  })

  it('accepts variable weight', () => {
    expect(variant.validate({ ...validFontVariant, weight: 'variable' })).toBe(true)
  })

  it('rejects missing hash (fonts always have bytes)', () => {
    const m = { ...validFontVariant } as Partial<FontLocaleAdditiveManifest>
    delete m.hash
    expect(variant.validate(m)).toBe(false)
  })

  it('rejects unknown format', () => {
    expect(variant.validate({ ...validFontVariant, format: 'eot' })).toBe(false)
  })

  it('rejects unknown style', () => {
    expect(variant.validate({ ...validFontVariant, style: 'oblique' })).toBe(false)
  })

  it('rejects malformed weight', () => {
    expect(variant.validate({ ...validFontVariant, weight: 'bold' })).toBe(false)
  })

  it('rejects malformed unicodeRange (must be string or null)', () => {
    expect(variant.validate({ ...validFontVariant, unicodeRange: 42 })).toBe(false)
  })
})

describe('locale-variant read', () => {
  const variant = localeManifestVariantFor('embedded')

  it('returns null when file is missing', async () => {
    const storage = memoryStorage({})
    expect(await variant.read(storage, 'assets', 'hero', frSelector)).toBeNull()
  })

  it('returns parsed manifest when file exists and is valid', async () => {
    const m: LocaleOverrideManifest = { version: 1, name: 'hero', alt: 'fr alt' }
    const storage = memoryStorage({ 'assets/hero.asset.fr.json': JSON.stringify(m) })
    expect(await variant.read(storage, 'assets', 'hero', frSelector)).toEqual(m)
  })

  it('throws AssetManifestCorruptError on invalid JSON', async () => {
    const storage = memoryStorage({ 'assets/hero.asset.fr.json': 'not-json' })
    await expect(variant.read(storage, 'assets', 'hero', frSelector)).rejects.toBeInstanceOf(AssetManifestCorruptError)
  })

  it('throws AssetManifestCorruptError on shape mismatch', async () => {
    const storage = memoryStorage({
      'assets/hero.asset.fr.json': JSON.stringify({ version: 1, name: 'hero', size: 100 /* stray */ }),
    })
    await expect(variant.read(storage, 'assets', 'hero', frSelector)).rejects.toBeInstanceOf(AssetManifestCorruptError)
  })
})
