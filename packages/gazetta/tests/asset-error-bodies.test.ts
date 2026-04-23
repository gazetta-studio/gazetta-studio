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
  AssetMimeUnsupportedError,
  AssetProviderNotCapableError,
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

  it('AssetValidationError body is { code, message } with 400 status', () => {
    const err = new AssetValidationError('ASSET_NAME_INVALID', 'Name is not valid')
    expect(err.toResponseBody()).toEqual({
      code: 'ASSET_NAME_INVALID',
      message: 'Name is not valid',
    })
    expect(err.httpStatus).toBe(400)
  })

  it('AssetStorageError body is { code, message } with 500 status', () => {
    const err = new AssetStorageError('delete', 'assets/hero.jpg', new Error('EIO'))
    const body = err.toResponseBody()
    expect(body.code).toBe('ASSET_STORAGE_FAILURE')
    expect(body.message).toContain('assets/hero.jpg')
    expect(err.httpStatus).toBe(500)
  })

  it('AssetProviderNotCapableError carries httpStatus 501', () => {
    expect(new AssetProviderNotCapableError('reason').httpStatus).toBe(501)
  })

  it('AssetMimeUnsupportedError body is { code, message } with 500 status', () => {
    const err = new AssetMimeUnsupportedError('image/heic', 'hero')
    const body = err.toResponseBody()
    expect(body.code).toBe('ASSET_MIME_UNSUPPORTED')
    expect(body.message).toContain('image/heic')
    expect(err.httpStatus).toBe(500)
  })
})
