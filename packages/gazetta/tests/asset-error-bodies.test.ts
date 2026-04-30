/**
 * Unit tests for `AssetError.toResponseBody()`.
 *
 * Each subclass is responsible for producing a wire-format body that
 * parses through the corresponding Zod schema. This test is the drift
 * detector: if a subclass adds a field and the schema doesn't, or vice
 * versa, the parse fails and the test fires.
 *
 * Kept pure-unit (no HTTP round-trip) because the polymorphism is the
 * contract — the route mapper just calls `toResponseBody()` and serializes.
 */
import { describe, expect, it } from 'vitest'
import {
  AssetInUseError,
  AssetManifestCorruptError,
  AssetManifestNotFoundError,
  AssetMimeMismatchError,
  AssetMimeUnsupportedError,
  AssetNameInvalidError,
  AssetNameReservedError,
  AssetPathTraversalError,
  AssetSizeExceededError,
  AssetStorageError,
  AssetValidationError,
} from '../src/assets/errors.js'
import { AssetInUseResponseSchema } from '../src/admin-api/schemas/assets.js'

describe('AssetError.toResponseBody()', () => {
  it('AssetInUseError body validates against AssetInUseResponseSchema', () => {
    const err = new AssetInUseError('hero', [
      { source: 'page', path: 'pages/home/page.json', componentPath: 'hero' },
      { source: 'fragment', path: 'fragments/promo/fragment.json', componentPath: 'image' },
    ])
    const body = err.toResponseBody()
    // If these drift, AssetInUseResponseSchema.parse throws.
    const parsed = AssetInUseResponseSchema.parse(body)
    expect(parsed.code).toBe('ASSET_IN_USE')
    expect(parsed.assetName).toBe('hero')
    expect(parsed.refs).toHaveLength(2)
  })

  it('AssetInUseError carries httpStatus 409', () => {
    expect(new AssetInUseError('x', []).httpStatus).toBe(409)
  })

  it('AssetManifestNotFoundError body is { code, message } with 404 status', () => {
    const err = new AssetManifestNotFoundError('hero')
    expect(err.toResponseBody()).toEqual({
      code: 'ASSET_MANIFEST_NOT_FOUND',
      message: 'Asset not found: hero',
    })
    expect(err.httpStatus).toBe(404)
  })

  it('AssetManifestCorruptError body is { code, message } with 500 status', () => {
    const err = new AssetManifestCorruptError('assets/hero.asset.json', new Error('bad JSON'))
    const body = err.toResponseBody()
    expect(body.code).toBe('ASSET_MANIFEST_CORRUPT')
    expect(body.message).toContain('assets/hero.asset.json')
    expect(err.httpStatus).toBe(500)
  })

  it('AssetNameInvalidError body is { code, message } with 400 status', () => {
    const err = new AssetNameInvalidError('My Name', 'Name is not valid')
    expect(err.toResponseBody()).toEqual({ code: 'ASSET_NAME_INVALID', message: 'Name is not valid' })
    expect(err.httpStatus).toBe(400)
    // Every validation subclass inherits the umbrella identity.
    expect(err).toBeInstanceOf(AssetValidationError)
  })

  it('AssetPathTraversalError body is { code, message } with 400 status', () => {
    const err = new AssetPathTraversalError('../etc/passwd')
    expect(err.toResponseBody().code).toBe('ASSET_PATH_TRAVERSAL')
    expect(err.httpStatus).toBe(400)
    expect(err).toBeInstanceOf(AssetValidationError)
  })

  it('AssetNameReservedError records the reserved token + position', () => {
    const err = new AssetNameReservedError('hero.asset.json', '.asset.json', 'suffix')
    expect(err.reservedToken).toBe('.asset.json')
    expect(err.position).toBe('suffix')
    expect(err.toResponseBody().code).toBe('ASSET_NAME_RESERVED')
    expect(err).toBeInstanceOf(AssetValidationError)
  })

  it('AssetSizeExceededError carries claimedSize + maxBytes', () => {
    const err = new AssetSizeExceededError(100_000_000, 50_000_000)
    expect(err.claimedSize).toBe(100_000_000)
    expect(err.maxBytes).toBe(50_000_000)
    expect(err.toResponseBody().code).toBe('ASSET_SIZE_EXCEEDED')
    expect(err.httpStatus).toBe(400)
    expect(err).toBeInstanceOf(AssetValidationError)
  })

  it('AssetMimeMismatchError builds its own message from the sniffed MIME', () => {
    const err = new AssetMimeMismatchError('image/webp', ['image/jpeg', 'image/png'])
    expect(err.sniffedMime).toBe('image/webp')
    expect(err.allowedMimes).toEqual(['image/jpeg', 'image/png'])
    expect(err.message).toContain('image/webp')
    expect(err.message).toContain('image/jpeg')
    expect(err.toResponseBody().code).toBe('ASSET_MIME_MISMATCH')
    expect(err).toBeInstanceOf(AssetValidationError)
  })

  it('AssetMimeMismatchError message differs when no MIME could be detected', () => {
    const err = new AssetMimeMismatchError(null, ['image/jpeg'])
    expect(err.message).toContain('Could not detect MIME type')
  })

  it('AssetStorageError body is { code, message } with 500 status', () => {
    const err = new AssetStorageError('delete', 'assets/hero.jpg', new Error('EIO'))
    const body = err.toResponseBody()
    expect(body.code).toBe('ASSET_STORAGE_FAILURE')
    expect(body.message).toContain('assets/hero.jpg')
    expect(err.httpStatus).toBe(500)
  })

  it('AssetMimeUnsupportedError body is { code, message } with 500 status', () => {
    const err = new AssetMimeUnsupportedError('image/heic', 'hero')
    const body = err.toResponseBody()
    expect(body.code).toBe('ASSET_MIME_UNSUPPORTED')
    expect(body.message).toContain('image/heic')
    expect(err.httpStatus).toBe(500)
  })
})
