import { describe, it, expect } from 'vitest'
import { encodeCacheKey, prefixOf } from '../src/cache/keys.js'

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
