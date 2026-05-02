/**
 * Tests for `assets/manifest-default.ts` — the default-manifest reader
 * and validator.
 *
 * Covers:
 *   - isDefaultManifest: identity fields, kind discriminator, byte-field
 *     rules, common metadata
 *   - readDefaultManifest: throws on missing/corrupt; reads valid manifest
 */
import { describe, expect, it } from 'vitest'
import { isDefaultManifest, readDefaultManifest } from '../src/assets/manifest-default.js'
import { AssetManifestCorruptError, AssetManifestNotFoundError } from '../src/assets/errors.js'
import type { AssetManifest } from '../src/schema/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const validEmbedded: AssetManifest = {
  version: 1,
  name: 'hero',
  kind: 'embedded',
  source: 'internal',
  mime: 'image/jpeg',
  size: 100_000,
  hash: 'a3b2c1d4',
  width: 1920,
  height: 1080,
  variants: [{ width: 800, path: 'hero-a3b2c1d4-800w.jpg', size: 30_000 }],
  alt: 'Hero',
  uploadedAt: '2026-04-30T00:00:00Z',
  uploadedBy: '',
}

describe('isDefaultManifest', () => {
  it('accepts a valid embedded manifest', () => {
    expect(isDefaultManifest(validEmbedded)).toBe(true)
  })

  it('accepts a valid downloadable manifest', () => {
    expect(isDefaultManifest({ ...validEmbedded, kind: 'downloadable' })).toBe(true)
  })

  it('accepts a valid font manifest', () => {
    expect(isDefaultManifest({ ...validEmbedded, kind: 'font' })).toBe(true)
  })

  it('rejects null / non-object', () => {
    expect(isDefaultManifest(null)).toBe(false)
    expect(isDefaultManifest(undefined)).toBe(false)
    expect(isDefaultManifest(42)).toBe(false)
    expect(isDefaultManifest('string')).toBe(false)
    expect(isDefaultManifest([])).toBe(false)
  })

  it('rejects unknown version', () => {
    expect(isDefaultManifest({ ...validEmbedded, version: 2 })).toBe(false)
    expect(isDefaultManifest({ ...validEmbedded, version: 0 })).toBe(false)
  })

  it('rejects unknown kind', () => {
    expect(isDefaultManifest({ ...validEmbedded, kind: 'unknown' })).toBe(false)
    expect(isDefaultManifest({ ...validEmbedded, kind: 'image' })).toBe(false)
  })

  it('rejects missing identity fields', () => {
    const noName = { ...validEmbedded } as Partial<AssetManifest>
    delete noName.name
    expect(isDefaultManifest(noName)).toBe(false)
  })

  it('rejects non-internal source (external punted to future step)', () => {
    expect(isDefaultManifest({ ...validEmbedded, source: 'external-direct' })).toBe(false)
  })

  it('rejects missing byte-describing fields', () => {
    const noHash = { ...validEmbedded } as Partial<AssetManifest>
    delete noHash.hash
    expect(isDefaultManifest(noHash)).toBe(false)

    const noSize = { ...validEmbedded } as Partial<AssetManifest>
    delete noSize.size
    expect(isDefaultManifest(noSize)).toBe(false)
  })

  it('accepts width/height as null (non-image asset)', () => {
    expect(isDefaultManifest({ ...validEmbedded, width: null, height: null })).toBe(true)
  })

  it('rejects malformed variants', () => {
    expect(isDefaultManifest({ ...validEmbedded, variants: 'not-an-array' })).toBe(false)
    expect(isDefaultManifest({ ...validEmbedded, variants: [{ width: 'not-a-number', path: 'x', size: 1 }] })).toBe(
      false,
    )
    expect(isDefaultManifest({ ...validEmbedded, variants: [{ width: 800, path: 'x' /* missing size */ }] })).toBe(
      false,
    )
  })

  it('accepts empty variants array', () => {
    expect(isDefaultManifest({ ...validEmbedded, variants: [] })).toBe(true)
  })

  it('accepts alt as null', () => {
    expect(isDefaultManifest({ ...validEmbedded, alt: null })).toBe(true)
  })

  it('rejects alt as number/object', () => {
    expect(isDefaultManifest({ ...validEmbedded, alt: 42 })).toBe(false)
  })
})

/**
 * Helper: build a memory storage pre-populated from a path → text map.
 * Centralizes the seed pattern — tests below say "what's stored" rather
 * than carrying mock-construction noise.
 */
function storageWith(files: Record<string, string>) {
  const s = memoryStorage()
  s.seed(files)
  return s
}

describe('readDefaultManifest', () => {
  it('throws AssetManifestNotFoundError when file is missing', async () => {
    const storage = storageWith({})
    await expect(readDefaultManifest(storage, 'assets', 'ghost')).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('throws AssetManifestCorruptError on invalid JSON', async () => {
    const storage = storageWith({ 'assets/hero.asset.json': 'not-json{{{' })
    await expect(readDefaultManifest(storage, 'assets', 'hero')).rejects.toBeInstanceOf(AssetManifestCorruptError)
  })

  it('throws AssetManifestCorruptError on shape mismatch', async () => {
    const storage = storageWith({ 'assets/hero.asset.json': JSON.stringify({ version: 1, name: 'hero' }) })
    await expect(readDefaultManifest(storage, 'assets', 'hero')).rejects.toBeInstanceOf(AssetManifestCorruptError)
  })

  it('reads and returns a valid manifest', async () => {
    const storage = storageWith({ 'assets/hero.asset.json': JSON.stringify(validEmbedded) })
    const m = await readDefaultManifest(storage, 'assets', 'hero')
    expect(m).toEqual(validEmbedded)
  })
})
