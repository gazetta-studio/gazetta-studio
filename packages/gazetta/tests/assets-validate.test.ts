import { describe, expect, it } from 'vitest'
import { AssetValidationError } from '../src/assets/errors.js'
import { ALLOWED_MIMES, ASSET_MAX_BYTES, DEFAULT_ASSET_MAX_BYTES, validateUpload } from '../src/assets/validate.js'

function ok(c: { name: string; claimedSize: number; sniffedMime: string | null }) {
  expect(() => validateUpload(c)).not.toThrow()
}

function throws(c: { name: string; claimedSize: number; sniffedMime: string | null }, code: string) {
  try {
    validateUpload(c)
    throw new Error('expected throw')
  } catch (err) {
    expect(err).toBeInstanceOf(AssetValidationError)
    expect((err as AssetValidationError).code).toBe(code)
  }
}

describe('validateUpload — names', () => {
  it('accepts a simple lowercase name', () => {
    ok({ name: 'hero', claimedSize: 1000, sniffedMime: 'image/jpeg' })
  })

  it('accepts name with digits, hyphens, underscores, and an extension', () => {
    ok({ name: 'hero-v2_final.jpg', claimedSize: 1000, sniffedMime: 'image/jpeg' })
  })

  it('rejects empty names', () => {
    throws({ name: '', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_NAME_INVALID')
  })

  it('rejects names over 200 chars', () => {
    throws({ name: 'a'.repeat(201), claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_NAME_INVALID')
  })

  it('rejects uppercase characters', () => {
    throws({ name: 'Hero', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_NAME_INVALID')
  })

  it('rejects spaces', () => {
    throws({ name: 'my hero', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_NAME_INVALID')
  })

  it('rejects path traversal — parent segments', () => {
    throws({ name: '../etc/passwd', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_PATH_TRAVERSAL')
  })

  it('rejects path traversal — leading slash', () => {
    throws({ name: '/tmp/pwn', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_PATH_TRAVERSAL')
  })

  it('rejects path traversal — backslash', () => {
    throws({ name: 'foo\\bar', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_PATH_TRAVERSAL')
  })

  it('rejects reserved prefix .', () => {
    throws({ name: '.DS_Store', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_NAME_RESERVED')
  })

  it('rejects reserved suffix .asset.json', () => {
    throws({ name: 'foo.asset.json', claimedSize: 1000, sniffedMime: 'image/jpeg' }, 'ASSET_NAME_RESERVED')
  })
})

describe('validateUpload — sizes', () => {
  it('rejects zero size', () => {
    throws({ name: 'hero', claimedSize: 0, sniffedMime: 'image/jpeg' }, 'ASSET_SIZE_EXCEEDED')
  })

  it('rejects negative size', () => {
    throws({ name: 'hero', claimedSize: -1, sniffedMime: 'image/jpeg' }, 'ASSET_SIZE_EXCEEDED')
  })

  it(`rejects size over the ${ASSET_MAX_BYTES}-byte limit`, () => {
    throws({ name: 'hero', claimedSize: ASSET_MAX_BYTES + 1, sniffedMime: 'image/jpeg' }, 'ASSET_SIZE_EXCEEDED')
  })

  it('accepts size at the limit exactly', () => {
    ok({ name: 'hero', claimedSize: ASSET_MAX_BYTES, sniffedMime: 'image/jpeg' })
  })
})

describe('validateUpload — MIME', () => {
  it('accepts allowed MIMEs', () => {
    for (const mime of ALLOWED_MIMES) {
      ok({ name: 'hero', claimedSize: 1000, sniffedMime: mime })
    }
  })

  it('rejects MIMEs outside the allowlist', () => {
    throws({ name: 'hero', claimedSize: 1000, sniffedMime: 'image/webp' }, 'ASSET_MIME_MISMATCH')
    throws({ name: 'hero', claimedSize: 1000, sniffedMime: 'application/zip' }, 'ASSET_MIME_MISMATCH')
  })

  it('rejects when MIME could not be sniffed (null)', () => {
    throws({ name: 'hero', claimedSize: 1000, sniffedMime: null }, 'ASSET_MIME_MISMATCH')
  })
})

describe('validateUpload — per-target policy', () => {
  it('uses DEFAULT_ASSET_MAX_BYTES when no policy is provided', () => {
    expect(() =>
      validateUpload({ name: 'hero', claimedSize: DEFAULT_ASSET_MAX_BYTES, sniffedMime: 'image/jpeg' }),
    ).not.toThrow()
    expect(() =>
      validateUpload({ name: 'hero', claimedSize: DEFAULT_ASSET_MAX_BYTES + 1, sniffedMime: 'image/jpeg' }),
    ).toThrow(AssetValidationError)
  })

  it('uses DEFAULT when policy is empty object', () => {
    expect(() =>
      validateUpload({ name: 'hero', claimedSize: DEFAULT_ASSET_MAX_BYTES, sniffedMime: 'image/jpeg' }, {}),
    ).not.toThrow()
  })

  it('honors a smaller per-target cap', () => {
    const policy = { maxBytes: 1024 * 1024 } // 1 MB
    expect(() =>
      validateUpload({ name: 'hero', claimedSize: 1024 * 1024, sniffedMime: 'image/jpeg' }, policy),
    ).not.toThrow()
    expect(() =>
      validateUpload({ name: 'hero', claimedSize: 1024 * 1024 + 1, sniffedMime: 'image/jpeg' }, policy),
    ).toThrow(AssetValidationError)
  })

  it('honors a larger per-target cap (raised limit for self-hosted)', () => {
    const policy = { maxBytes: 500 * 1024 * 1024 } // 500 MB
    expect(() =>
      validateUpload({ name: 'hero', claimedSize: 200 * 1024 * 1024, sniffedMime: 'image/jpeg' }, policy),
    ).not.toThrow()
  })

  it('error reports the policy limit, not the default', () => {
    const policy = { maxBytes: 1024 }
    try {
      validateUpload({ name: 'hero', claimedSize: 2048, sniffedMime: 'image/jpeg' }, policy)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AssetValidationError)
      const msg = (err as AssetValidationError).message
      expect(msg).toContain('1024')
    }
  })

  it('ASSET_MAX_BYTES export still works (deprecated alias)', () => {
    expect(ASSET_MAX_BYTES).toBe(DEFAULT_ASSET_MAX_BYTES)
  })
})
