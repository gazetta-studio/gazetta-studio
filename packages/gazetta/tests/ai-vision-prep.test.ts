/**
 * Unit tests for `ai/vision-prep.ts` — image preprocessing for vision
 * provider calls. Covers:
 *
 *   - JPEG path: resize when oversized, pass-through when small
 *   - PNG with alpha: preserve PNG, don't flatten to JPEG
 *   - SVG: rasterize to PNG at maxEdge
 *   - Animated source: use poster bytes directly, skip rasterization
 *   - maxEdge override: per-call override of the default 768
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { MAX_EDGE, prepareForVision } from '../src/ai/vision-prep.js'

async function makeJpeg(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 100, b: 100 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

async function makePngWithAlpha(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

const SVG_BYTES = new Uint8Array(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>',
    'utf-8',
  ),
)

describe('prepareForVision — default MAX_EDGE', () => {
  it('exports MAX_EDGE = 768', () => {
    expect(MAX_EDGE).toBe(768)
  })
})

describe('prepareForVision — JPEG', () => {
  it('resizes a 2000×1500 JPEG to fit within 768', async () => {
    const bytes = await makeJpeg(2000, 1500)
    const result = await prepareForVision({ bytes, mime: 'image/jpeg' })
    expect(result.mime).toBe('image/jpeg')

    const meta = await sharp(result.bytes).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768)
    // Aspect ratio should be preserved (2000/1500 = 4/3).
    expect(meta.width).toBe(768)
    expect(meta.height).toBe(576)
  })

  it('passes through a JPEG already smaller than maxEdge', async () => {
    const bytes = await makeJpeg(400, 300)
    const result = await prepareForVision({ bytes, mime: 'image/jpeg' })
    // Pass-through: same bytes, same MIME.
    expect(result.bytes).toBe(bytes)
    expect(result.mime).toBe('image/jpeg')
  })

  it('passes through a JPEG exactly at maxEdge', async () => {
    const bytes = await makeJpeg(768, 768)
    const result = await prepareForVision({ bytes, mime: 'image/jpeg' })
    expect(result.bytes).toBe(bytes)
  })
})

describe('prepareForVision — PNG with alpha', () => {
  it('preserves PNG (no flatten to JPEG) when source has alpha', async () => {
    const bytes = await makePngWithAlpha(2000, 2000)
    const result = await prepareForVision({ bytes, mime: 'image/png' })
    expect(result.mime).toBe('image/png')

    const meta = await sharp(result.bytes).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768)
    expect(meta.hasAlpha).toBe(true)
  })

  it('passes through a small alpha PNG', async () => {
    const bytes = await makePngWithAlpha(400, 400)
    const result = await prepareForVision({ bytes, mime: 'image/png' })
    expect(result.bytes).toBe(bytes)
    expect(result.mime).toBe('image/png')
  })
})

describe('prepareForVision — SVG', () => {
  it('rasterizes SVG to PNG at maxEdge', async () => {
    const result = await prepareForVision({ bytes: SVG_BYTES, mime: 'image/svg+xml' })
    expect(result.mime).toBe('image/png')

    const meta = await sharp(result.bytes).metadata()
    // Width/height bounded by maxEdge.
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768)
    // Output is real PNG (sharp can read it back).
    expect(meta.format).toBe('png')
  })

  it('rasterizes SVG even when SVG is small', async () => {
    // SVG has no inherent pixel size; we always rasterize.
    const result = await prepareForVision({ bytes: SVG_BYTES, mime: 'image/svg+xml' })
    expect(result.mime).toBe('image/png')
    expect(result.bytes).not.toBe(SVG_BYTES)
  })
})

describe('prepareForVision — animated/poster path', () => {
  it('uses posterBytes directly when provided', async () => {
    const sourceBytes = await makeJpeg(2000, 1500)
    const posterBytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
    const result = await prepareForVision({
      bytes: sourceBytes,
      mime: 'image/gif',
      posterBytes: new Uint8Array(posterBytes),
    })
    // Result is the poster bytes verbatim, marked as PNG.
    expect(result.bytes).toEqual(new Uint8Array(posterBytes))
    expect(result.mime).toBe('image/png')
  })

  it('does not rasterize when posterBytes provided, even for SVG', async () => {
    // posterBytes always wins — caller's responsibility to pass the
    // right bytes for the source.
    const posterBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic
    const result = await prepareForVision({
      bytes: SVG_BYTES,
      mime: 'image/svg+xml',
      posterBytes,
    })
    expect(result.bytes).toBe(posterBytes)
    expect(result.mime).toBe('image/png')
  })
})

describe('prepareForVision — maxEdge override', () => {
  it('respects per-call maxEdge override', async () => {
    const bytes = await makeJpeg(2000, 2000)
    const result = await prepareForVision({ bytes, mime: 'image/jpeg', maxEdge: 1024 })
    const meta = await sharp(result.bytes).metadata()
    expect(meta.width).toBe(1024)
    expect(meta.height).toBe(1024)
  })

  it('passes through when source ≤ override maxEdge', async () => {
    const bytes = await makeJpeg(900, 900)
    const result = await prepareForVision({ bytes, mime: 'image/jpeg', maxEdge: 1024 })
    expect(result.bytes).toBe(bytes)
  })

  it('honors small maxEdge for cost-extreme cases', async () => {
    const bytes = await makeJpeg(2000, 2000)
    const result = await prepareForVision({ bytes, mime: 'image/jpeg', maxEdge: 256 })
    const meta = await sharp(result.bytes).metadata()
    expect(meta.width).toBe(256)
  })
})
