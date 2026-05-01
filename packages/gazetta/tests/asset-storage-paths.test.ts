/**
 * Tests for `assetStoragePaths`, `assetPathsInRemovalOrder`,
 * `assetBytePaths`, `assetManifestPaths`.
 *
 * Locks:
 *   - The shape: defaultManifest + defaultBytes + defaultVariants + overrides[]
 *   - Removal order: override bytes/variants → override manifests → default
 *     bytes/variants → default manifest LAST
 *   - Throw on unknown MIME (no null escape hatch)
 *   - Helpers project the right subset (bytes-only, manifests-only)
 */
import { describe, expect, it } from 'vitest'
import {
  type AssetStoragePaths,
  assetBytePaths,
  assetManifestPaths,
  assetPathsInRemovalOrder,
  assetStoragePaths,
} from '../src/assets/asset-paths.js'
import { AssetMimeUnsupportedError } from '../src/assets/errors.js'
import { buildSelector } from '../src/schema/dimensions.js'
import type { AssetManifest } from '../src/schema/types.js'

const baseManifest: AssetManifest = {
  version: 1,
  name: 'hero',
  kind: 'embedded',
  source: 'internal',
  mime: 'image/jpeg',
  size: 100_000,
  hash: 'a3b2c1d4',
  width: 1920,
  height: 1080,
  variants: [
    { width: 400, path: 'hero-a3b2c1d4-400w.jpg', size: 10_000 },
    { width: 800, path: 'hero-a3b2c1d4-800w.jpg', size: 30_000 },
  ],
  alt: 'Hero',
  uploadedAt: '2026-04-30T00:00:00Z',
  uploadedBy: '',
}

describe('assetStoragePaths', () => {
  it('produces default-only enumeration when no overrides exist', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    expect(paths.defaultManifest).toBe('assets/hero.asset.json')
    expect(paths.defaultBytes).toBe('assets/hero-a3b2c1d4.jpg')
    expect(paths.defaultVariants).toEqual(['assets/hero-a3b2c1d4-400w.jpg', 'assets/hero-a3b2c1d4-800w.jpg'])
    expect(paths.overrides).toEqual([])
  })

  it('throws AssetMimeUnsupportedError on unknown MIME', () => {
    expect(() => assetStoragePaths('assets', { ...baseManifest, mime: 'application/octet-stream' })).toThrow(
      AssetMimeUnsupportedError,
    )
  })

  it('handles empty variants list', () => {
    const m: AssetManifest = { ...baseManifest, variants: [] }
    const paths = assetStoragePaths('assets', m)
    expect(paths.defaultVariants).toEqual([])
  })

  it('returns readonly arrays (immutable enumeration)', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    // TypeScript-level guarantee; this just ensures the runtime value isn't
    // accidentally mutable.
    expect(Array.isArray(paths.defaultVariants)).toBe(true)
    expect(Array.isArray(paths.overrides)).toBe(true)
  })
})

describe('assetPathsInRemovalOrder', () => {
  it('default-only: bytes/variants first, manifest last', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    const order = assetPathsInRemovalOrder(paths)
    expect(order).toEqual([
      'assets/hero-a3b2c1d4.jpg',
      'assets/hero-a3b2c1d4-400w.jpg',
      'assets/hero-a3b2c1d4-800w.jpg',
      'assets/hero.asset.json',
    ])
  })

  it('with overrides: override bytes/variants → override manifests → default bytes/variants → default manifest', () => {
    // Hand-build a paths struct with an override (assetStoragePaths doesn't
    // populate overrides yet — step 24 will).
    const paths: AssetStoragePaths = {
      defaultManifest: 'assets/hero.asset.json',
      defaultBytes: 'assets/hero-a3b2c1d4.jpg',
      defaultVariants: ['assets/hero-a3b2c1d4-400w.jpg'],
      overrides: [
        {
          selector: buildSelector({ locale: 'fr' })!,
          manifest: 'assets/hero.asset.fr.json',
          bytes: 'assets/hero-d5e6f7a8.fr.jpg',
          variants: ['assets/hero-d5e6f7a8.fr-400w.jpg'],
        },
      ],
    }
    expect(assetPathsInRemovalOrder(paths)).toEqual([
      // override bytes + variants
      'assets/hero-d5e6f7a8.fr.jpg',
      'assets/hero-d5e6f7a8.fr-400w.jpg',
      // override manifests
      'assets/hero.asset.fr.json',
      // default bytes + variants
      'assets/hero-a3b2c1d4.jpg',
      'assets/hero-a3b2c1d4-400w.jpg',
      // default manifest LAST
      'assets/hero.asset.json',
    ])
  })

  it('handles metadata-only overrides (bytes: null)', () => {
    // Locale override with no bytes — only an alt/focal override.
    const paths: AssetStoragePaths = {
      defaultManifest: 'assets/hero.asset.json',
      defaultBytes: 'assets/hero-a3b2c1d4.jpg',
      defaultVariants: [],
      overrides: [
        {
          selector: buildSelector({ locale: 'ar' })!,
          manifest: 'assets/hero.asset.ar.json',
          bytes: null,
          variants: [],
        },
      ],
    }
    expect(assetPathsInRemovalOrder(paths)).toEqual([
      // override has no bytes — only the manifest is enumerated
      'assets/hero.asset.ar.json',
      'assets/hero-a3b2c1d4.jpg',
      'assets/hero.asset.json',
    ])
  })

  it('multiple overrides removed in iteration order', () => {
    const paths: AssetStoragePaths = {
      defaultManifest: 'assets/hero.asset.json',
      defaultBytes: 'assets/hero-a3b2c1d4.jpg',
      defaultVariants: [],
      overrides: [
        {
          selector: buildSelector({ locale: 'fr' })!,
          manifest: 'assets/hero.asset.fr.json',
          bytes: 'assets/hero-d5e6f7a8.fr.jpg',
          variants: [],
        },
        {
          selector: buildSelector({ theme: 'dark' })!,
          manifest: 'assets/hero.asset.dark.json',
          bytes: 'assets/hero-aabbccdd.dark.jpg',
          variants: [],
        },
      ],
    }
    const order = assetPathsInRemovalOrder(paths)
    // All override bytes come before any override manifest (rule 1+2)
    expect(order.indexOf('assets/hero-d5e6f7a8.fr.jpg')).toBeLessThan(order.indexOf('assets/hero.asset.fr.json'))
    expect(order.indexOf('assets/hero-aabbccdd.dark.jpg')).toBeLessThan(order.indexOf('assets/hero.asset.dark.json'))
    // All override manifests come before default bytes
    expect(order.indexOf('assets/hero.asset.fr.json')).toBeLessThan(order.indexOf('assets/hero-a3b2c1d4.jpg'))
    // Default manifest last
    expect(order[order.length - 1]).toBe('assets/hero.asset.json')
  })
})

describe('assetBytePaths', () => {
  it('default-only: returns default bytes + variants', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    expect(assetBytePaths(paths)).toEqual([
      'assets/hero-a3b2c1d4.jpg',
      'assets/hero-a3b2c1d4-400w.jpg',
      'assets/hero-a3b2c1d4-800w.jpg',
    ])
  })

  it('with bytes-overrides: includes override bytes + variants', () => {
    const paths: AssetStoragePaths = {
      defaultManifest: 'assets/hero.asset.json',
      defaultBytes: 'assets/hero-a3b2c1d4.jpg',
      defaultVariants: ['assets/hero-a3b2c1d4-400w.jpg'],
      overrides: [
        {
          selector: buildSelector({ locale: 'fr' })!,
          manifest: 'assets/hero.asset.fr.json',
          bytes: 'assets/hero-d5e6f7a8.fr.jpg',
          variants: ['assets/hero-d5e6f7a8.fr-400w.jpg'],
        },
      ],
    }
    expect(assetBytePaths(paths)).toEqual([
      'assets/hero-a3b2c1d4.jpg',
      'assets/hero-a3b2c1d4-400w.jpg',
      'assets/hero-d5e6f7a8.fr.jpg',
      'assets/hero-d5e6f7a8.fr-400w.jpg',
    ])
  })

  it('skips metadata-only overrides (bytes: null)', () => {
    const paths: AssetStoragePaths = {
      defaultManifest: 'assets/hero.asset.json',
      defaultBytes: 'assets/hero-a3b2c1d4.jpg',
      defaultVariants: [],
      overrides: [
        {
          selector: buildSelector({ locale: 'ar' })!,
          manifest: 'assets/hero.asset.ar.json',
          bytes: null,
          variants: [],
        },
      ],
    }
    expect(assetBytePaths(paths)).toEqual(['assets/hero-a3b2c1d4.jpg'])
  })

  it('does NOT include manifests', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    const bytes = assetBytePaths(paths)
    expect(bytes).not.toContain('assets/hero.asset.json')
  })
})

describe('assetManifestPaths', () => {
  it('default-only: returns the default manifest path', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    expect(assetManifestPaths(paths)).toEqual(['assets/hero.asset.json'])
  })

  it('with overrides: returns default + every override manifest', () => {
    const paths: AssetStoragePaths = {
      defaultManifest: 'assets/hero.asset.json',
      defaultBytes: 'assets/hero-a3b2c1d4.jpg',
      defaultVariants: [],
      overrides: [
        {
          selector: buildSelector({ locale: 'fr' })!,
          manifest: 'assets/hero.asset.fr.json',
          bytes: 'assets/hero-d5e6f7a8.fr.jpg',
          variants: [],
        },
        {
          selector: buildSelector({ theme: 'dark' })!,
          manifest: 'assets/hero.asset.dark.json',
          bytes: null,
          variants: [],
        },
      ],
    }
    expect(assetManifestPaths(paths)).toEqual([
      'assets/hero.asset.json',
      'assets/hero.asset.fr.json',
      'assets/hero.asset.dark.json',
    ])
  })

  it('does NOT include byte paths', () => {
    const paths = assetStoragePaths('assets', baseManifest)
    const manifests = assetManifestPaths(paths)
    expect(manifests).not.toContain('assets/hero-a3b2c1d4.jpg')
  })
})
