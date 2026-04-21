import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { nodeReadableToWeb, webReadableToNode } from '../src/providers/_stream-interop.js'

describe('nodeReadableToWeb', () => {
  it('returns a standard ReadableStream<Uint8Array> from a Node Readable', async () => {
    const nodeStream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const webStream = nodeReadableToWeb(nodeStream)

    // Must be the standard lib-dom ReadableStream (not node:stream/web variant).
    expect(webStream).toBeInstanceOf(ReadableStream)

    const reader = webStream.getReader()
    const parts: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) parts.push(value)
    }

    const joined = Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf-8')
    expect(joined).toBe('hello world')
  })
})

describe('webReadableToNode', () => {
  it('returns a Node Readable from a standard ReadableStream<Uint8Array>', async () => {
    const webStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('foo '))
        c.enqueue(new TextEncoder().encode('bar'))
        c.close()
      },
    })
    const nodeStream = webReadableToNode(webStream)

    expect(nodeStream).toBeInstanceOf(Readable)

    const chunks: Buffer[] = []
    for await (const chunk of nodeStream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('foo bar')
  })
})

describe('round-trip', () => {
  it('web → node → web preserves bytes', async () => {
    const original = 'round-trip test payload'
    const first = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(original))
        c.close()
      },
    })

    const asNode = webReadableToNode(first)
    const backToWeb = nodeReadableToWeb(asNode)

    const reader = backToWeb.getReader()
    const parts: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) parts.push(value)
    }
    const joined = Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf-8')
    expect(joined).toBe(original)
  })
})
