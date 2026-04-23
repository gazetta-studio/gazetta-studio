/**
 * Unit tests for the variant generator. Real sharp (same pattern as
 * image-metadata.test.ts) on small fixture buffers — fast and truthful.
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { generateVariants, VARIANT_WIDTHS } from '../src/assets/variants.js'

async function jpeg(width: number, height = 16): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

async function png(width: number, height = 16): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

describe('generateVariants', () => {
  it('returns one variant per target width ≤ source width', async () => {
    // 1000px source — should yield 400w and 800w (both ≤ 1000), skip 1200/1600.
    const source = await jpeg(1000)
    const variants = await generateVariants(source)

    expect(variants.map(v => v.width)).toEqual([400, 800])
  })

  it('returns all four widths for a source wider than the largest target', async () => {
    const source = await jpeg(2000)
    const variants = await generateVariants(source)

    expect(variants.map(v => v.width)).toEqual([...VARIANT_WIDTHS])
  })

  it('returns no variants for a source smaller than the smallest target', async () => {
    // 100px source is below the 400w floor; no upscaling per contract.
    const source = await jpeg(100)
    const variants = await generateVariants(source)

    expect(variants).toEqual([])
  })

  it('produces real JPEG bytes each variant can be re-read by sharp', async () => {
    const source = await jpeg(1000)
    const variants = await generateVariants(source)

    for (const v of variants) {
      const meta = await sharp(v.bytes).metadata()
      expect(meta.width).toBe(v.width)
      expect(meta.format).toBe('jpeg')
    }
  })

  it('keeps PNG source as PNG output', async () => {
    const source = await png(900)
    const variants = await generateVariants(source)
    expect(variants.map(v => v.width)).toEqual([400, 800])
    for (const v of variants) {
      const meta = await sharp(v.bytes).metadata()
      expect(meta.format).toBe('png')
    }
  })

  it('throws on unreadable input (not a real image)', async () => {
    const junk = new TextEncoder().encode('this is not an image')
    await expect(generateVariants(junk)).rejects.toThrow()
  })

  it('variants are ordered ascending by width (matches AssetManifest contract)', async () => {
    const source = await jpeg(2000)
    const variants = await generateVariants(source)
    const widths = variants.map(v => v.width)
    const sorted = [...widths].sort((a, b) => a - b)
    expect(widths).toEqual(sorted)
  })
})
