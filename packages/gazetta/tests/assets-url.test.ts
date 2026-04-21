import { describe, expect, it } from 'vitest'
import { ASSETS_URL_PREFIX, buildAssetUrl, extFromMime } from '../src/assets/url.js'

describe('buildAssetUrl', () => {
  it('returns a root-relative URL when no siteUrl is given', () => {
    expect(buildAssetUrl({ name: 'hero', hash: 'a3b2c1d4', ext: 'jpg' })).toBe(`${ASSETS_URL_PREFIX}/hero-a3b2c1d4.jpg`)
  })

  it('prefixes with siteUrl when provided', () => {
    expect(
      buildAssetUrl({
        name: 'hero',
        hash: 'a3b2c1d4',
        ext: 'jpg',
        siteUrl: 'https://cdn.example.com',
      }),
    ).toBe('https://cdn.example.com/assets/hero-a3b2c1d4.jpg')
  })

  it('normalizes a trailing slash on siteUrl', () => {
    const withoutSlash = buildAssetUrl({
      name: 'hero',
      hash: 'a3b2c1d4',
      ext: 'jpg',
      siteUrl: 'https://cdn.example.com',
    })
    const withSlash = buildAssetUrl({
      name: 'hero',
      hash: 'a3b2c1d4',
      ext: 'jpg',
      siteUrl: 'https://cdn.example.com/',
    })
    expect(withoutSlash).toBe(withSlash)
  })

  it('handles path-style names (preserves slashes)', () => {
    expect(buildAssetUrl({ name: 'products/hero', hash: 'd5e6f7a8', ext: 'png' })).toBe(
      `${ASSETS_URL_PREFIX}/products/hero-d5e6f7a8.png`,
    )
  })
})

describe('extFromMime', () => {
  it('returns jpg for image/jpeg', () => {
    expect(extFromMime('image/jpeg')).toBe('jpg')
  })

  it('returns png for image/png', () => {
    expect(extFromMime('image/png')).toBe('png')
  })

  it('returns null for unknown MIMEs', () => {
    expect(extFromMime('image/webp')).toBeNull()
    expect(extFromMime('application/zip')).toBeNull()
    expect(extFromMime('')).toBeNull()
  })
})
