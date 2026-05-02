/**
 * Unit tests for the upload-preprocessor abstraction. Verifies the
 * dispatch / pass-through / error-wrapping behavior independently of
 * the real SVG preprocessor.
 */
import { describe, expect, it, vi } from 'vitest'
import { AssetPreprocessError } from '../src/assets/errors.js'
import { runPreprocessors, type UploadPreprocessor } from '../src/assets/preprocess.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function bytes(s: string): Uint8Array {
  return enc.encode(s)
}

describe('runPreprocessors', () => {
  it('passes bytes through unchanged when no preprocessor matches', async () => {
    const noop: UploadPreprocessor = {
      name: 'noop',
      matches: () => false,
      preprocess: vi.fn(),
    }
    const input = bytes('hello')
    const result = await runPreprocessors(input, 'application/octet-stream', [noop])

    expect(result.bytes).toBe(input) // same reference, no copy
    expect(result.warnings).toEqual([])
    expect(noop.preprocess).not.toHaveBeenCalled()
  })

  it('passes through with empty registry', async () => {
    const input = bytes('hello')
    const result = await runPreprocessors(input, 'image/jpeg', [])
    expect(result.bytes).toBe(input)
  })

  it('runs the first matching preprocessor', async () => {
    const upper: UploadPreprocessor = {
      name: 'upper',
      matches: m => m === 'text/plain',
      preprocess: input => ({
        bytes: enc.encode(dec.decode(input).toUpperCase()),
        warnings: [],
      }),
    }
    const result = await runPreprocessors(bytes('hi'), 'text/plain', [upper])
    expect(dec.decode(result.bytes)).toBe('HI')
  })

  it('only runs the first matching preprocessor when multiple match', async () => {
    const first: UploadPreprocessor = {
      name: 'first',
      matches: () => true,
      preprocess: () => ({ bytes: bytes('first'), warnings: [] }),
    }
    const second: UploadPreprocessor = {
      name: 'second',
      matches: () => true,
      preprocess: vi.fn(),
    }

    const result = await runPreprocessors(bytes('input'), 'any/mime', [first, second])
    expect(dec.decode(result.bytes)).toBe('first')
    expect(second.preprocess).not.toHaveBeenCalled()
  })

  it('forwards AssetPreprocessError unchanged', async () => {
    const bad: UploadPreprocessor = {
      name: 'bad',
      matches: () => true,
      preprocess: () => {
        throw new AssetPreprocessError('test', 'reason')
      },
    }
    await expect(runPreprocessors(bytes('x'), 'any/mime', [bad])).rejects.toBeInstanceOf(AssetPreprocessError)
  })

  it('wraps unexpected errors in AssetPreprocessError', async () => {
    const broken: UploadPreprocessor = {
      name: 'broken',
      matches: () => true,
      preprocess: () => {
        throw new Error('something else')
      },
    }

    try {
      await runPreprocessors(bytes('x'), 'any/mime', [broken])
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AssetPreprocessError)
      expect((err as AssetPreprocessError).format).toBe('broken')
      expect((err as AssetPreprocessError).reason).toBe('unexpected')
    }
  })

  it('forwards warnings from the matching preprocessor', async () => {
    const noisy: UploadPreprocessor = {
      name: 'noisy',
      matches: () => true,
      preprocess: () => ({
        bytes: bytes('out'),
        warnings: [{ code: 'svg-large-base64', sizeBytes: 200_000, threshold: 100_000 }],
      }),
    }
    const result = await runPreprocessors(bytes('x'), 'any/mime', [noisy])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ code: 'svg-large-base64' })
  })
})
