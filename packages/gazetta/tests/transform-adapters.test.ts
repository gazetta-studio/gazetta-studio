/**
 * Tests for `transforms/{adapter,sharp,cloudflare,factories,index}.ts`.
 *
 * Locks the contract so future adapter swaps don't accidentally
 * regress URL composition, srcset semantics, or cache policy.
 *
 * Covers:
 *   - sharp adapter: origin URLs, srcset from variants, immutable cache
 *   - cloudflare adapter: cdn-cgi/image URL composition, on-the-fly
 *     srcset ladder, Vary: Accept on cache policy
 *   - operator-facing factories (`sharpAdapter()`, `cloudflareAdapter({...})`)
 *     produce instances matching the internal contract
 *   - per Path X (design-provider-config.md), there is no central factory
 *     dispatch — operators construct adapter instances inline at the
 *     `transforms:` field; `target.transforms` IS the constructed adapter.
 */
import { describe, expect, it } from 'vitest'
import { sharpAdapter, cloudflareAdapter } from '../src/transforms/factories.js'
import { createCloudflareAdapter, defaultSharpAdapter } from '../src/transforms/index.js'
import type { AssetUrlInput } from '../src/transforms/adapter.js'
import { buildSelector } from '../src/schema/dimensions.js'

const baseInput: AssetUrlInput = {
  name: 'hero',
  hash: 'a3b2c1d4',
  ext: 'jpg',
  selector: null,
  siteUrl: undefined,
  variants: [
    { width: 400, path: 'hero-a3b2c1d4-400w.jpg', size: 10_000 },
    { width: 800, path: 'hero-a3b2c1d4-800w.jpg', size: 30_000 },
  ],
  width: 1920,
  height: 1080,
}

describe('sharpAdapter (operator-facing factory)', () => {
  const adapter = sharpAdapter()

  it('builds primary URL as origin path', () => {
    expect(adapter.primaryUrl(baseInput)).toBe('/assets/hero-a3b2c1d4.jpg')
  })

  it('respects siteUrl for absolute URLs', () => {
    expect(adapter.primaryUrl({ ...baseInput, siteUrl: 'https://cdn.example.com' })).toBe(
      'https://cdn.example.com/assets/hero-a3b2c1d4.jpg',
    )
  })

  it('builds primary URL with selector suffix', () => {
    expect(adapter.primaryUrl({ ...baseInput, selector: buildSelector({ locale: 'fr' }) })).toBe(
      '/assets/hero-a3b2c1d4.fr.jpg',
    )
  })

  it('builds srcset from manifest variants', () => {
    expect(adapter.srcset(baseInput)).toBe('/assets/hero-a3b2c1d4-400w.jpg 400w, /assets/hero-a3b2c1d4-800w.jpg 800w')
  })

  it('returns null srcset when variants is empty', () => {
    expect(adapter.srcset({ ...baseInput, variants: [] })).toBeNull()
  })

  it('returns immutable cache policy', () => {
    expect(adapter.cachePolicy(baseInput)).toEqual({
      cacheControl: 'public, max-age=31536000, immutable',
    })
  })

  it('has stable name', () => {
    expect(adapter.name).toBe('sharp')
  })

  it('defaultSharpAdapter (internal singleton) matches the factory output', () => {
    expect(defaultSharpAdapter.name).toBe('sharp')
    expect(defaultSharpAdapter.primaryUrl(baseInput)).toBe(adapter.primaryUrl(baseInput))
  })

  it('repeat factory calls return independent instances with same behavior', () => {
    const a = sharpAdapter()
    const b = sharpAdapter()
    expect(a).not.toBe(b)
    expect(a.primaryUrl(baseInput)).toBe(b.primaryUrl(baseInput))
  })
})

describe('cloudflareAdapter (operator-facing factory)', () => {
  const adapter = cloudflareAdapter({ zone: 'cdn.example.com' })
  const inputWithSiteUrl: AssetUrlInput = { ...baseInput, siteUrl: 'https://cdn.example.com' }

  it('throws on construction without a zone', () => {
    expect(() => cloudflareAdapter({ zone: '' })).toThrow(/zone/)
    // Type-cast to bypass the type check — runtime validation should catch it.
    expect(() => cloudflareAdapter({ zone: undefined as unknown as string })).toThrow(/zone/)
  })

  it('strips https:// prefix and trailing slash from zone input', () => {
    const adapter1 = cloudflareAdapter({ zone: 'https://cdn.example.com/' })
    expect(adapter1.primaryUrl(inputWithSiteUrl)).toBe(
      'https://cdn.example.com/cdn-cgi/image/format=auto/https://cdn.example.com/assets/hero-a3b2c1d4.jpg',
    )
  })

  it('builds primary URL via /cdn-cgi/image/format=auto', () => {
    expect(adapter.primaryUrl(inputWithSiteUrl)).toBe(
      'https://cdn.example.com/cdn-cgi/image/format=auto/https://cdn.example.com/assets/hero-a3b2c1d4.jpg',
    )
  })

  it('throws when called without siteUrl (CDN needs absolute origin)', () => {
    expect(() => adapter.primaryUrl(baseInput)).toThrow(/siteUrl/i)
  })

  it('builds srcset with on-the-fly width transforms', () => {
    const srcset = adapter.srcset(inputWithSiteUrl)
    expect(srcset).toContain('width=400')
    expect(srcset).toContain('width=800')
    expect(srcset).toContain('width=1200')
    expect(srcset).toContain('width=1600')
    expect(srcset).toContain('400w,')
    expect(srcset).toContain('1600w')
  })

  it('skips ladder widths above source width (no upscaling)', () => {
    const srcset = adapter.srcset({ ...inputWithSiteUrl, width: 600 })
    // Only 400w should be in the ladder (800/1200/1600 > 600).
    expect(srcset).toContain('400w')
    expect(srcset).not.toContain('800w')
    expect(srcset).not.toContain('1200w')
  })

  it('returns null srcset for non-image extensions', () => {
    expect(adapter.srcset({ ...inputWithSiteUrl, ext: 'pdf' })).toBeNull()
    expect(adapter.srcset({ ...inputWithSiteUrl, ext: 'woff2' })).toBeNull()
  })

  it('returns null srcset when no ladder width fits', () => {
    expect(adapter.srcset({ ...inputWithSiteUrl, width: 100 })).toBeNull()
  })

  it('selector suffix flows into the origin URL fetched by Cloudflare', () => {
    const url = adapter.primaryUrl({ ...inputWithSiteUrl, selector: buildSelector({ locale: 'fr' }) })
    expect(url).toContain('/assets/hero-a3b2c1d4.fr.jpg')
  })

  it('returns Vary: Accept in cache policy (format=auto returns different bytes per browser)', () => {
    expect(adapter.cachePolicy(baseInput)).toEqual({
      cacheControl: 'public, max-age=31536000, immutable',
      vary: 'Accept',
    })
  })

  it('has stable name', () => {
    expect(adapter.name).toBe('cloudflare')
  })

  it('internal createCloudflareAdapter delegates the same way', () => {
    // The operator-facing factory wraps the internal one — both produce
    // equivalent adapters from the same options.
    const internal = createCloudflareAdapter({ zone: 'cdn.example.com' })
    expect(internal.name).toBe('cloudflare')
    expect(internal.primaryUrl(inputWithSiteUrl)).toBe(adapter.primaryUrl(inputWithSiteUrl))
  })
})
