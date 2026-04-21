import { describe, expect, it } from 'vitest'
import { ASSET_HASH_LENGTH, hashBytes, hashStream } from '../src/assets/hash.js'

describe('hashBytes', () => {
  it(`returns an ${ASSET_HASH_LENGTH}-char hex prefix`, () => {
    const hash = hashBytes(new TextEncoder().encode('hello'))
    expect(hash).toHaveLength(ASSET_HASH_LENGTH)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic for the same input', () => {
    const bytes = new TextEncoder().encode('same bytes')
    expect(hashBytes(bytes)).toBe(hashBytes(bytes))
  })

  it('produces different hashes for different input', () => {
    const a = hashBytes(new TextEncoder().encode('alpha'))
    const b = hashBytes(new TextEncoder().encode('beta'))
    expect(a).not.toBe(b)
  })
})

describe('hashStream', () => {
  it('hashes the same as hashBytes for identical input', async () => {
    const bytes = new TextEncoder().encode('streaming input')
    const fromBuffer = hashBytes(bytes)

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes)
        c.close()
      },
    })
    const fromStream = await hashStream(stream)

    expect(fromStream).toBe(fromBuffer)
  })

  it('handles multi-chunk input', async () => {
    const combined = new TextEncoder().encode('part1-part2-part3')
    const expected = hashBytes(combined)

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('part1-'))
        c.enqueue(encoder.encode('part2-'))
        c.enqueue(encoder.encode('part3'))
        c.close()
      },
    })

    expect(await hashStream(stream)).toBe(expected)
  })

  it('handles empty streams (empty-string hash prefix)', async () => {
    const empty = new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    })
    const result = await hashStream(empty)
    expect(result).toHaveLength(ASSET_HASH_LENGTH)
    expect(result).toBe(hashBytes(new Uint8Array()))
  })
})
