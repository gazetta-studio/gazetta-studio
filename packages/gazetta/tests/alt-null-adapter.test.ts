/**
 * Unit tests for `alt/null-adapter.ts` — verifies LSP: the null adapter
 * honors the `AltTextAdapter` contract (full surface, not stubs that
 * throw `not implemented`).
 *
 * The null adapter is the safe default returned by the factory when
 * no adapter is configured. `supports()` always returns false; the
 * suggester checks `supports` first, so `generate` is never reached
 * in practice — but it's defined and throws a typed error if it IS
 * reached, as a defense-in-depth signal that something has gone wrong.
 */
import { describe, expect, it } from 'vitest'
import { AIAdapterUnavailableError } from '../src/ai/errors.js'
import { type AltGenerateInput, DEFAULT_ALT_REQUEST } from '../src/alt/adapter.js'
import { nullAltAdapter } from '../src/alt/null-adapter.js'

describe('nullAltAdapter', () => {
  it('has a stable name for diagnostics', () => {
    expect(nullAltAdapter.name).toBe('null')
  })

  describe('supports', () => {
    it('returns false for image MIMEs', () => {
      expect(nullAltAdapter.supports('image/jpeg')).toBe(false)
      expect(nullAltAdapter.supports('image/png')).toBe(false)
      expect(nullAltAdapter.supports('image/svg+xml')).toBe(false)
      expect(nullAltAdapter.supports('image/gif')).toBe(false)
    })

    it('returns false for non-image MIMEs', () => {
      expect(nullAltAdapter.supports('audio/mpeg')).toBe(false)
      expect(nullAltAdapter.supports('application/pdf')).toBe(false)
    })

    it('returns false for malformed input', () => {
      expect(nullAltAdapter.supports('')).toBe(false)
    })
  })

  describe('generate', () => {
    const input: AltGenerateInput = {
      bytes: new Uint8Array([0]),
      mime: 'image/jpeg',
      request: { ...DEFAULT_ALT_REQUEST },
      prompt: 'test',
    }

    it('throws AIAdapterUnavailableError when called', async () => {
      await expect(nullAltAdapter.generate(input)).rejects.toBeInstanceOf(AIAdapterUnavailableError)
    })

    it('error message guides the operator to the configuration', async () => {
      try {
        await nullAltAdapter.generate(input)
      } catch (err) {
        if (err instanceof AIAdapterUnavailableError) {
          expect(err.message.toLowerCase()).toContain('altText'.toLowerCase())
          expect(err.message.toLowerCase()).toContain('site.config.ts'.toLowerCase())
        } else {
          throw new Error('expected AIAdapterUnavailableError')
        }
      }
    })

    it('error has 503 httpStatus', async () => {
      try {
        await nullAltAdapter.generate(input)
      } catch (err) {
        if (err instanceof AIAdapterUnavailableError) {
          expect(err.httpStatus).toBe(503)
        } else {
          throw err
        }
      }
    })
  })
})
