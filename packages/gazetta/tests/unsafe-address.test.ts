/** Reading a plain-text value as a browser reads an address (design-content-trust.md Q2). */
import { describe, expect, it } from 'vitest'
import { normalizeAddress, unsafeAddressScheme } from '../src/unsafe-address.js'
import { isSafeDataImage, SAFE_DATA_IMAGE_TYPES } from '../src/safe-data-images.js'

describe('normalizeAddress', () => {
  it.each([
    ['&#106;avascript:x', 'javascript:x'],
    ['&#x6A;avascript:x', 'javascript:x'],
    ['&#106avascript:x', 'javascript:x'],
    ['javascript&colon;x', 'javascript:x'],
    ['java&Tab;script:x', 'javascript:x'],
    ['java\tscr\nipt:\rx', 'javascript:x'],
    [' \u0001\u001fjavascript:x', 'javascript:x'],
    ['&unknown;x', '&unknown;x'],
  ])('reads %j as %j', (value, expected) => {
    expect(normalizeAddress(value)).toBe(expected)
  })
})

describe('unsafeAddressScheme', () => {
  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['JaVaScRiPt:x', 'javascript:'],
    ['java\tscript:x', 'javascript:'],
    ['&#106;avascript:x', 'javascript:'],
    [' \u0001javascript:x', 'javascript:'],
    ['VBScript:x', 'vbscript:'],
    ['data:text/html,<script>', 'data:'],
    ['data:image/svg+xml;base64,PHN2Zz4=', 'data:'],
    ['data:image/svg+xml,%3Csvg', 'data:'],
    ['DATA:text/plain,hi', 'data:'],
  ])('refuses %j as %j', (value, scheme) => {
    expect(unsafeAddressScheme(value)).toBe(scheme)
  })

  it.each([
    'data:image/png;base64,AAAA',
    'data:image/jpeg;base64,AAAA',
    'data:image/gif;base64,AAAA',
    'data:image/webp,%3Csvg',
    'data:image/avif;base64,AAAA',
    'DATA:IMAGE/PNG;BASE64,AAAA',
    'https://example.com/a',
    '/relative/path',
    'mailto:a@example.com',
    'Plain text: with a colon',
    'a < b',
  ])('allows %j', value => {
    expect(unsafeAddressScheme(value)).toBeNull()
  })
})

describe('isSafeDataImage', () => {
  it.each(SAFE_DATA_IMAGE_TYPES)('allows %s, base64 or percent-encoded', type => {
    expect(isSafeDataImage(`data:image/${type};base64,AAAA`)).toBe(true)
    expect(isSafeDataImage(`data:image/${type},%00`)).toBe(true)
  })

  it('leaves out svg+xml', () => {
    expect(isSafeDataImage('data:image/svg+xml;base64,AAAA')).toBe(false)
  })
})
