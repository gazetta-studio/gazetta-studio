import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { sniffMimeFromStream } from '../src/assets/mime-sniff.js'

/** Minimal 1×1 JPEG bytes, produced by sharp. */
async function tinyJpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer(),
  )
}

/** Minimal 1×1 PNG bytes, produced by sharp. */
async function tinyPng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer(),
  )
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) parts.push(value)
  }
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

describe('sniffMimeFromStream', () => {
  it('detects JPEG from magic bytes', async () => {
    const bytes = await tinyJpeg()
    const { mime, ext } = await sniffMimeFromStream(streamOf(bytes))
    expect(mime).toBe('image/jpeg')
    expect(ext).toBe('jpg')
  })

  it('detects PNG from magic bytes', async () => {
    const bytes = await tinyPng()
    const { mime, ext } = await sniffMimeFromStream(streamOf(bytes))
    expect(mime).toBe('image/png')
    expect(ext).toBe('png')
  })

  it('returns null MIME and ext when input has no magic-byte match', async () => {
    const garbage = new TextEncoder().encode('this is plain text, no magic bytes')
    const { mime, ext } = await sniffMimeFromStream(streamOf(garbage))
    expect(mime).toBeNull()
    expect(ext).toBeNull()
  })

  it('returns a stream that replays the original bytes in order', async () => {
    const bytes = await tinyJpeg()
    const { stream } = await sniffMimeFromStream(streamOf(bytes))
    const replayed = await drainStream(stream)
    expect(Buffer.from(replayed).equals(Buffer.from(bytes))).toBe(true)
  })

  it('promotes file-type XML detection to image/svg+xml when the root is <svg>', async () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    )
    const { mime, ext } = await sniffMimeFromStream(streamOf(svg))
    // file-type returns `application/xml` for any XML; sniffMimeFromStream
    // peeks the head and promotes to `image/svg+xml` when the root is `<svg>`.
    expect(mime).toBe('image/svg+xml')
    expect(ext).toBe('svg')
  })

  it('returns image/svg+xml even without an XML prolog', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
    const { mime } = await sniffMimeFromStream(streamOf(svg))
    expect(mime).toBe('image/svg+xml')
  })

  it('does not promote arbitrary XML (non-SVG root) to image/svg+xml', async () => {
    const xml = new TextEncoder().encode('<?xml version="1.0"?><rss><channel/></rss>')
    const { mime } = await sniffMimeFromStream(streamOf(xml))
    expect(mime).not.toBe('image/svg+xml')
  })
})
