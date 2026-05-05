/**
 * Property-based tests for the sidecar-name codec in hash.ts.
 *
 * The sidecar filenames are the persistent shape we write to disk, so
 * the encode/decode contract has to hold across every name a real site
 * might throw at it (fragments with subfolders, templates with weird
 * characters, unicode, empty-ish). Example tests catch the obvious
 * cases; `fast-check` probes the edge space.
 *
 * Properties covered:
 *   1. encodeRefName / decodeRefName round-trip for arbitrary strings
 *   2. hash sidecar regex never collides with pub sidecar regex
 *   3. compactTimestamp / pubSidecar round-trip
 *
 * Reverse-dep relationships now live in `.gazetta/{relation}/{target}/{source}`
 * per-edge sidecars (see dep-sidecars.ts) — there's no longer a per-item
 * filename codec for `.uses-*` or `.tpl-*`. Those tests have been removed
 * along with the encoders.
 *
 * Not covered here: hashManifest key-order invariance is example-tested
 * in hash.test.ts already.
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  encodeRefName,
  decodeRefName,
  sidecarNameFor,
  parseSidecarName,
  pubSidecarNameFor,
  parsePubSidecarName,
  compactTimestamp,
  parseCompactTimestamp,
} from '../src/hash.js'

/**
 * Reference names are fragment/template ids authored in site.config.ts
 * / component lists. Per operations.md they're lowercase-kebab-case,
 * optionally subfolder-qualified with `/` (e.g. `buttons/primary`).
 * The encoder's `/` ↔ `.` scheme is invertible only when the input
 * has no `.` — encodeRefName validates that, and this arbitrary stays
 * within the valid domain.
 */
const refNameArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter(s => !/[\x00-\x1f]/.test(s))
  .filter(s => !s.includes('.'))

describe('encodeRefName / decodeRefName', () => {
  it('round-trips arbitrary ref names', () => {
    fc.assert(
      fc.property(refNameArb, name => {
        expect(decodeRefName(encodeRefName(name))).toBe(name)
      }),
    )
  })

  it('replaces every forward slash with a dot', () => {
    expect(encodeRefName('a/b/c')).toBe('a.b.c')
    fc.assert(
      fc.property(refNameArb, name => {
        expect(encodeRefName(name)).not.toMatch(/\//)
      }),
    )
  })

  it('preserves underscores — they are valid in ref names', () => {
    expect(encodeRefName('my_fragment')).toBe('my_fragment')
    expect(decodeRefName(encodeRefName('a_b/c_d'))).toBe('a_b/c_d')
  })

  it('throws on names containing a dot (reserved for path encoding)', () => {
    expect(() => encodeRefName('foo.bar')).toThrow(/dot/i)
    expect(() => encodeRefName('.')).toThrow()
    expect(() => encodeRefName('a/b.c')).toThrow()
  })
})

describe('hash sidecar', () => {
  it('hash sidecar filenames never parse as pub', () => {
    const hexArb = fc.stringMatching(/^[0-9a-f]{8}$/, { minLength: 8, maxLength: 8 })
    fc.assert(
      fc.property(hexArb, hex => {
        const fname = sidecarNameFor(hex)
        expect(parsePubSidecarName(fname)).toBeNull()
        expect(parseSidecarName(fname)).toBe(hex)
      }),
    )
  })
})

describe('pub sidecar', () => {
  it('compactTimestamp round-trips through parseCompactTimestamp', () => {
    const date = new Date('2026-04-17T22:05:30Z')
    const compact = compactTimestamp(date)
    expect(compact).toBe('20260417T220530Z')
    expect(parseCompactTimestamp(compact)).toBe('2026-04-17T22:05:30Z')
  })

  it('pubSidecarNameFor generates correct filename', () => {
    const date = new Date('2026-04-17T22:00:00Z')
    expect(pubSidecarNameFor(date, false)).toBe('.pub-20260417T220000Z')
    expect(pubSidecarNameFor(date, true)).toBe('.pub-20260417T220000Z-noindex')
  })

  it('parsePubSidecarName round-trips', () => {
    const date = new Date('2026-04-17T22:00:00Z')
    const name = pubSidecarNameFor(date, false)
    const parsed = parsePubSidecarName(name)
    expect(parsed).toEqual({ lastPublished: '2026-04-17T22:00:00Z', noindex: false })
  })

  it('parsePubSidecarName detects noindex', () => {
    const parsed = parsePubSidecarName('.pub-20260417T220000Z-noindex')
    expect(parsed).toEqual({ lastPublished: '2026-04-17T22:00:00Z', noindex: true })
  })

  it('parsePubSidecarName rejects non-pub sidecars', () => {
    expect(parsePubSidecarName('.abcd1234.hash')).toBeNull()
    expect(parsePubSidecarName('random.txt')).toBeNull()
  })

  it('pub sidecar does not collide with hash sidecar', () => {
    const pubName = pubSidecarNameFor(new Date('2026-04-17T22:00:00Z'))
    expect(parseSidecarName(pubName)).toBeNull()
    expect(parsePubSidecarName(pubName)).not.toBeNull()
  })
})
