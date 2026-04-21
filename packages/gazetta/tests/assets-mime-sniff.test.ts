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

  it('returns application/xml for SVG (file-type does not map to image/svg+xml)', async () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    )
    const { mime } = await sniffMimeFromStream(streamOf(svg))
    // Documented behavior — callers that need `image/svg+xml` semantics
    // must re-map based on root-tag inspection or extension.
    expect(mime).toBe('application/xml')
  })
})
