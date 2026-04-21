import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { extractImageDimensions } from '../src/assets/image-metadata.js'

describe('extractImageDimensions', () => {
  it('returns width and height for a JPEG', async () => {
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 100, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .jpeg()
        .toBuffer(),
    )
    const dims = await extractImageDimensions(bytes)
    expect(dims).toEqual({ width: 100, height: 50 })
  })

  it('returns width and height for a PNG', async () => {
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 42, height: 84, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    )
    const dims = await extractImageDimensions(bytes)
    expect(dims).toEqual({ width: 42, height: 84 })
  })

  it('returns null on non-image bytes', async () => {
    const garbage = new TextEncoder().encode('this is clearly not an image')
    const dims = await extractImageDimensions(garbage)
    expect(dims).toBeNull()
  })

  it('returns null on empty input', async () => {
    const dims = await extractImageDimensions(new Uint8Array())
    expect(dims).toBeNull()
  })
})
