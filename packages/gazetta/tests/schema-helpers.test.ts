/**
 * Runtime tests for the asset schema helpers. Each helper must:
 * - accept well-formed reference data
 * - reject malformed data (missing `_asset`, out-of-range focal point, wrong types)
 * - attach its options as metadata readable via Zod's `.meta()`
 */
import { describe, expect, it } from 'vitest'
import { downloadable, embeddedAsset, fontAsset } from '../src/schema/helpers.js'

describe('embeddedAsset', () => {
  it('accepts a minimal reference', () => {
    const schema = embeddedAsset({ accept: ['image'] })
    const parsed = schema.parse({ _asset: 'hero' })
    expect(parsed._asset).toBe('hero')
  })

  it('accepts a reference with alt and focal-point overrides', () => {
    const schema = embeddedAsset()
    const parsed = schema.parse({
      _asset: 'hero',
      alt: 'Mountain sunset',
      focalPoint: { x: 0.5, y: 0.35 },
    })
    expect(parsed.alt).toBe('Mountain sunset')
    expect(parsed.focalPoint).toEqual({ x: 0.5, y: 0.35 })
  })

  it('rejects a reference without _asset', () => {
    const schema = embeddedAsset()
    expect(() => schema.parse({ alt: 'no asset name' })).toThrow()
  })

  it('rejects a focal point outside the 0–1 range', () => {
    const schema = embeddedAsset()
    expect(() => schema.parse({ _asset: 'hero', focalPoint: { x: 1.5, y: 0.5 } })).toThrow()
    expect(() => schema.parse({ _asset: 'hero', focalPoint: { x: -0.1, y: 0.5 } })).toThrow()
  })

  it('exposes options via .meta()', () => {
    const schema = embeddedAsset({ accept: ['image'], altRequired: true })
    const meta = schema.meta()
    expect(meta?.assetOptions).toEqual({ accept: ['image'], altRequired: true })
  })

  it('defaults to empty options when none are provided', () => {
    const schema = embeddedAsset()
    expect(schema.meta()?.assetOptions).toEqual({})
  })
})

describe('downloadable', () => {
  it('accepts a minimal reference', () => {
    const schema = downloadable()
    expect(schema.parse({ _asset: 'brochure' })._asset).toBe('brochure')
  })

  it('accepts title and description overrides', () => {
    const schema = downloadable()
    const parsed = schema.parse({
      _asset: 'brochure',
      title: 'Brand Guidelines 2026',
      description: 'Visual identity + voice',
    })
    expect(parsed.title).toBe('Brand Guidelines 2026')
    expect(parsed.description).toBe('Visual identity + voice')
  })

  it('rejects a reference without _asset', () => {
    const schema = downloadable()
    expect(() => schema.parse({ title: 'orphan' })).toThrow()
  })

  it('exposes options via .meta()', () => {
    const schema = downloadable({ accept: ['document'], descriptionOverride: false })
    expect(schema.meta()?.assetOptions).toEqual({
      accept: ['document'],
      descriptionOverride: false,
    })
  })
})

describe('fontAsset', () => {
  it('accepts a minimal reference', () => {
    const schema = fontAsset()
    expect(schema.parse({ _asset: 'brand-sans' })._asset).toBe('brand-sans')
  })

  it('rejects a reference without _asset', () => {
    const schema = fontAsset()
    expect(() => schema.parse({})).toThrow()
  })

  it('exposes options via .meta()', () => {
    const schema = fontAsset({ accept: ['woff2'], variable: true })
    expect(schema.meta()?.assetOptions).toEqual({ accept: ['woff2'], variable: true })
  })
})

describe('integration — using helpers inside a larger Zod schema', () => {
  it('validates a realistic page content shape', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      hero: embeddedAsset({ accept: ['image'] }),
      whitepaper: downloadable().optional(),
      bodyFont: fontAsset(),
      title: z.string(),
    })

    const parsed = schema.parse({
      hero: { _asset: 'home-hero', alt: 'Office space' },
      bodyFont: { _asset: 'brand-sans' },
      title: 'Welcome',
    })

    expect(parsed.hero._asset).toBe('home-hero')
    expect(parsed.whitepaper).toBeUndefined()
    expect(parsed.bodyFont._asset).toBe('brand-sans')
  })

  it('rejects a content shape with a malformed asset reference', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      hero: embeddedAsset({ accept: ['image'] }),
    })

    expect(() => schema.parse({ hero: { alt: 'missing _asset' } })).toThrow()
  })
})
