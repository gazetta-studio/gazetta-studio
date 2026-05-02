/**
 * Unit tests for the analyzer abstraction + the static + animated
 * image analyzers. Pure (no storage I/O) — analyzers take bytes,
 * return manifest enrichment + supplementary files.
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { runAnalyzers, type UploadAnalyzer } from '../src/assets/analyze.js'
import { animatedImageAnalyzer, staticImageAnalyzer } from '../src/assets/analyze-image.js'

/**
 * A minimal hand-crafted 2-frame animated GIF (1×1 pixels, 100ms
 * per frame). Avoids depending on a binary fixture file or sharp's
 * GIF-output animation API (which doesn't reliably produce animated
 * output from `pageHeight` slicing on the current sharp version).
 */
const ANIMATED_GIF_BYTES = (() => {
  const bytes = Buffer.from(
    'GIF89a' +
      '\x01\x00\x01\x00' +
      '\x80\x00\x00' +
      '\x00\x00\x00\xff\x00\x00' +
      '\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00' +
      '\x21\xf9\x04\x00\x0a\x00\x00\x00' +
      '\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00' +
      '\x02\x02\x44\x01\x00' +
      '\x21\xf9\x04\x00\x0a\x00\x00\x00' +
      '\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00' +
      '\x02\x02\x4c\x01\x00' +
      '\x3b',
    'binary',
  )
  return new Uint8Array(bytes)
})()

const STATIC_INPUT = (mime: string, bytes: Uint8Array) => ({
  bytes,
  assetName: 'hero',
  hash: 'abc12345',
  ext: mime.split('/')[1] ?? '',
  mime,
})

async function jpegBytes(width = 100, height = 50): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

describe('staticImageAnalyzer', () => {
  it('matches image/* except SVG', () => {
    expect(staticImageAnalyzer.matches('image/jpeg')).toBe(true)
    expect(staticImageAnalyzer.matches('image/png')).toBe(true)
    expect(staticImageAnalyzer.matches('image/gif')).toBe(true)
    expect(staticImageAnalyzer.matches('image/svg+xml')).toBe(false)
    expect(staticImageAnalyzer.matches('application/pdf')).toBe(false)
    expect(staticImageAnalyzer.matches(null)).toBe(false)
  })

  it('extracts width/height from a JPEG', async () => {
    const bytes = await jpegBytes(200, 150)
    const result = await staticImageAnalyzer.analyze(STATIC_INPUT('image/jpeg', bytes))
    expect(result.manifestPatch).toEqual({ width: 200, height: 150 })
    expect(result.supplementaryFiles).toBeUndefined()
  })

  it("returns null dims when sharp can't decode", async () => {
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const result = await staticImageAnalyzer.analyze(STATIC_INPUT('image/jpeg', garbage))
    expect(result.manifestPatch).toEqual({ width: null, height: null })
  })
})

describe('animatedImageAnalyzer', () => {
  it('matches GIF / PNG / WebP / AVIF', () => {
    expect(animatedImageAnalyzer.matches('image/gif')).toBe(true)
    expect(animatedImageAnalyzer.matches('image/png')).toBe(true)
    expect(animatedImageAnalyzer.matches('image/webp')).toBe(true)
    expect(animatedImageAnalyzer.matches('image/avif')).toBe(true)
    expect(animatedImageAnalyzer.matches('image/jpeg')).toBe(false)
    expect(animatedImageAnalyzer.matches('image/svg+xml')).toBe(false)
  })

  it('returns no enrichment for a static GIF', async () => {
    // A 1-frame GIF won't trip the `pages > 1` check.
    const staticGif = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .gif()
      .toBuffer()
    const result = await animatedImageAnalyzer.analyze(STATIC_INPUT('image/gif', new Uint8Array(staticGif)))
    expect(result.manifestPatch).toBeUndefined()
    expect(result.supplementaryFiles).toBeUndefined()
  })

  it('detects animation, sets fields, and produces a poster for a 2-frame GIF', async () => {
    const result = await animatedImageAnalyzer.analyze(STATIC_INPUT('image/gif', ANIMATED_GIF_BYTES))
    expect(result.manifestPatch).toMatchObject({
      animated: true,
      frames: 2,
      duration: 200, // 100ms × 2 frames
    })
    expect(result.manifestPatch?.poster).toBe('hero-abc12345-poster.png')
    expect(result.supplementaryFiles).toHaveLength(1)
    expect(result.supplementaryFiles?.[0].path).toBe('hero-abc12345-poster.png')
    // Poster should be a real PNG (sharp output).
    expect(result.supplementaryFiles?.[0].bytes.byteLength).toBeGreaterThan(0)
  })

  it("returns no enrichment when sharp can't decode", async () => {
    const garbage = new Uint8Array([0x00, 0x00])
    const result = await animatedImageAnalyzer.analyze(STATIC_INPUT('image/gif', garbage))
    expect(result.manifestPatch).toBeUndefined()
    expect(result.supplementaryFiles).toBeUndefined()
  })
})

describe('runAnalyzers', () => {
  it('returns empty result when no analyzer matches', async () => {
    const result = await runAnalyzers(STATIC_INPUT('audio/mp3', new Uint8Array([0xff, 0xfb])), [])
    expect(result.manifestPatch).toBeUndefined()
    expect(result.supplementaryFiles).toBeUndefined()
  })

  it('merges manifest patches across multiple matching analyzers', async () => {
    const widthAnalyzer: UploadAnalyzer = {
      name: 'a',
      matches: () => true,
      analyze: vi.fn(async () => ({ manifestPatch: { width: 100, height: 100 } })),
    }
    const animatedAnalyzer: UploadAnalyzer = {
      name: 'b',
      matches: () => true,
      analyze: vi.fn(async () => ({ manifestPatch: { animated: true, frames: 5 } })),
    }
    const result = await runAnalyzers(STATIC_INPUT('image/gif', new Uint8Array([0])), [widthAnalyzer, animatedAnalyzer])
    expect(result.manifestPatch).toEqual({ width: 100, height: 100, animated: true, frames: 5 })
  })

  it('concatenates supplementary files across analyzers', async () => {
    const a: UploadAnalyzer = {
      name: 'a',
      matches: () => true,
      analyze: async () => ({
        supplementaryFiles: [{ path: 'a.png', bytes: new Uint8Array([1]) }],
      }),
    }
    const b: UploadAnalyzer = {
      name: 'b',
      matches: () => true,
      analyze: async () => ({
        supplementaryFiles: [{ path: 'b.png', bytes: new Uint8Array([2]) }],
      }),
    }
    const result = await runAnalyzers(STATIC_INPUT('image/gif', new Uint8Array()), [a, b])
    expect(result.supplementaryFiles).toEqual([
      { path: 'a.png', bytes: new Uint8Array([1]) },
      { path: 'b.png', bytes: new Uint8Array([2]) },
    ])
  })

  it('skips non-matching analyzers', async () => {
    const matched = vi.fn(async () => ({ manifestPatch: { width: 1, height: 1 } }))
    const skipped = vi.fn()
    await runAnalyzers(STATIC_INPUT('image/jpeg', new Uint8Array()), [
      { name: 'matched', matches: () => true, analyze: matched },
      { name: 'skipped', matches: () => false, analyze: skipped },
    ])
    expect(matched).toHaveBeenCalled()
    expect(skipped).not.toHaveBeenCalled()
  })

  it('uses defaultAnalyzers when no registry is passed', async () => {
    // The default registry includes static + animated analyzers.
    // For an animated GIF, the result should include both width
    // (from static) and animated (from animated).
    const result = await runAnalyzers(STATIC_INPUT('image/gif', ANIMATED_GIF_BYTES))
    expect(result.manifestPatch?.width).toBe(1)
    expect(result.manifestPatch?.height).toBe(1)
    expect(result.manifestPatch?.animated).toBe(true)
    expect(result.manifestPatch?.frames).toBe(2)
    expect(result.supplementaryFiles).toHaveLength(1)
  })
})
