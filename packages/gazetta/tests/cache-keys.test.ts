import { describe, it, expect } from 'vitest'
import { CACHE_SCHEMA_VERSION, applyKeyPolicy, applyPrefixPolicy, encodeCacheKey, prefixOf } from '../src/cache/keys.js'

describe('encodeCacheKey', () => {
  it('joins components with colon', () => {
    expect(encodeCacheKey(['pages', 'detail', 'home'])).toBe('pages:detail:home')
  })

  it('encodes slashes as dots (per encodeRefName)', () => {
    // Page names with subfolders ('blog/[slug]') round-trip safely
    // because encodeRefName converts '/' to '.'.
    expect(encodeCacheKey(['pages', 'detail', 'blog/[slug]'])).toBe('pages:detail:blog.[slug]')
  })

  it('encodes scoped npm-style names', () => {
    // Plugin keys use the package name as a prefix per design-cache.md.
    expect(encodeCacheKey(['@gazetta/slack-notify', 'state'])).toBe('@gazetta.slack-notify:state')
  })

  it('throws when a component contains a dot', () => {
    // Dot is reserved for the slash encoding; encodeRefName rejects.
    expect(() => encodeCacheKey(['pages', 'has.dot'])).toThrow(/dot is reserved/)
  })

  it('throws on empty input', () => {
    expect(() => encodeCacheKey([])).toThrow(/at least one component/)
  })

  it('preserves hyphens, brackets, underscores, locale codes', () => {
    expect(encodeCacheKey(['pages', 'detail', 'home', 'en-US', 'role_editor', '[draft]'])).toBe(
      'pages:detail:home:en-US:role_editor:[draft]',
    )
  })
})

describe('prefixOf', () => {
  it('returns the first N components with trailing colon', () => {
    expect(prefixOf('pages:detail:home', 1)).toBe('pages:')
    expect(prefixOf('pages:detail:home', 2)).toBe('pages:detail:')
  })

  it('appends trailing colon to prevent sibling-prefix collisions', () => {
    // `'pages:'` matches `'pages:detail:home'` but not `'pages-archived:home'`.
    expect(prefixOf('pages:detail:home', 1)).toBe('pages:')
  })

  it('returns the full key plus colon when components exceeds key depth', () => {
    expect(prefixOf('pages:home', 5)).toBe('pages:home:')
  })

  it('throws when components is zero or negative', () => {
    expect(() => prefixOf('pages:home', 0)).toThrow()
    expect(() => prefixOf('pages:home', -1)).toThrow()
  })
})

describe('applyKeyPolicy', () => {
  it('prepends the cache schema version', () => {
    expect(applyKeyPolicy('pages:detail:home')).toBe(`${CACHE_SCHEMA_VERSION}:pages:detail:home`)
  })

  it('leaves short keys unchanged beyond the version prefix', () => {
    const wrapped = applyKeyPolicy('a:b:c')
    expect(wrapped.length).toBeLessThanOrEqual(255)
    expect(wrapped).toMatch(/^\d+:a:b:c$/)
  })

  it('hashes the overflow tail when the wrapped key exceeds 255 chars', () => {
    // Build a key just over the cap so we can verify the cut point.
    const big = encodeCacheKey(['pages', 'detail', 'a'.repeat(300)])
    const wrapped = applyKeyPolicy(big)
    expect(wrapped.length).toBeLessThanOrEqual(255)
    // Tail is an 8-char hex hash separated by ':'
    expect(wrapped).toMatch(/:[0-9a-f]{8}$/)
  })

  it('preserves the prefix up to the last colon boundary that fits', () => {
    // A key with multiple short components followed by one long
    // component. Prefix-invalidation on `pages:detail:` must still
    // work, so the kept prefix must include those components in full.
    const big = encodeCacheKey(['pages', 'detail', 'b'.repeat(300)])
    const wrapped = applyKeyPolicy(big)
    expect(wrapped.startsWith(`${CACHE_SCHEMA_VERSION}:pages:detail:`)).toBe(true)
  })

  it('produces stable output for the same input', () => {
    const k = encodeCacheKey(['pages', 'detail', 'c'.repeat(300)])
    expect(applyKeyPolicy(k)).toBe(applyKeyPolicy(k))
  })

  it('produces different outputs for different long inputs', () => {
    const a = encodeCacheKey(['pages', 'detail', 'd'.repeat(300)])
    const b = encodeCacheKey(['pages', 'detail', 'e'.repeat(300)])
    expect(applyKeyPolicy(a)).not.toBe(applyKeyPolicy(b))
  })
})

describe('applyPrefixPolicy', () => {
  it('prepends the cache schema version without hashing', () => {
    expect(applyPrefixPolicy('pages:')).toBe(`${CACHE_SCHEMA_VERSION}:pages:`)
  })

  it('matches what applyKeyPolicy produces for keys under the cap', () => {
    // Critical contract: invalidatePrefix('pages:') must match every
    // stored entry under that consumer prefix. Verify by hand-computing
    // the wrapped prefix and asserting that wrapped keys start with it.
    const wrappedPrefix = applyPrefixPolicy('pages:')
    const wrappedKey = applyKeyPolicy('pages:detail:home')
    expect(wrappedKey.startsWith(wrappedPrefix)).toBe(true)
  })

  it('matches long-key prefixes when the prefix is short', () => {
    const wrappedPrefix = applyPrefixPolicy('pages:detail:')
    const big = encodeCacheKey(['pages', 'detail', 'f'.repeat(300)])
    const wrappedKey = applyKeyPolicy(big)
    expect(wrappedKey.startsWith(wrappedPrefix)).toBe(true)
  })
})
