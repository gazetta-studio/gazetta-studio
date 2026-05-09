/**
 * Pin the archive-helper contract per `design-soft-delete.md` Q1 + Q2 + Q3.
 *
 * - isArchived / aliasTarget are pure predicates over manifest fields
 * - resolveFragmentArchiveAlias follows the alias chain with cycle
 *   detection + hop limit (defensive guards; Q3 flatten guarantees
 *   one-hop in practice)
 * - ArchivedNoAliasError thrown for archived-without-alias state
 *   (Q2 F1's split: alias = redirect; no alias = pure soft-delete →
 *   render-error / 410 surfaces)
 */
import { describe, it, expect } from 'vitest'
import { ArchivedNoAliasError, aliasTarget, isArchived, resolveFragmentArchiveAlias } from '../src/archive-helpers.js'
import type { ComponentManifest } from '../src/types.js'

const liveFragment = (template = 'tpl'): ComponentManifest => ({ template })
const archivedFragment = (aliasOf?: string): ComponentManifest => ({
  template: 'tpl',
  archived: true,
  ...(aliasOf !== undefined ? { aliasOf } : {}),
})

describe('isArchived', () => {
  it('returns false for live manifests', () => {
    expect(isArchived(liveFragment())).toBe(false)
  })

  it('returns false when archived is absent', () => {
    expect(isArchived({ template: 'x' })).toBe(false)
  })

  it('returns false when archived is explicitly false', () => {
    expect(isArchived({ template: 'x', archived: false })).toBe(false)
  })

  it('returns true when archived is true', () => {
    expect(isArchived({ template: 'x', archived: true })).toBe(true)
  })
})

describe('aliasTarget', () => {
  it('returns null for live manifests (regardless of aliasOf)', () => {
    expect(aliasTarget({ template: 'x' })).toBeNull()
    // Defensive: live with stale aliasOf still returns null
    expect(aliasTarget({ template: 'x', aliasOf: 'should-be-ignored' })).toBeNull()
  })

  it('returns null for archived manifests without aliasOf (pure soft-delete)', () => {
    expect(aliasTarget({ template: 'x', archived: true })).toBeNull()
  })

  it('returns the target name for archived manifests with aliasOf', () => {
    expect(aliasTarget({ template: 'x', archived: true, aliasOf: 'newname' })).toBe('newname')
  })
})

describe('resolveFragmentArchiveAlias', () => {
  it('returns the live fragment unchanged when not archived', () => {
    const live = liveFragment()
    const lookup = (n: string) => (n === 'header' ? live : null)
    const result = resolveFragmentArchiveAlias('header', lookup)
    expect(result?.resolvedName).toBe('header')
    expect(result?.manifest).toBe(live)
  })

  it('follows aliasOf one hop to the live target', () => {
    const newHeader = liveFragment('new-tpl')
    const oldHeader = archivedFragment('new-header')
    const lookup = (n: string) => {
      if (n === 'old-header') return oldHeader
      if (n === 'new-header') return newHeader
      return null
    }
    const result = resolveFragmentArchiveAlias('old-header', lookup)
    expect(result?.resolvedName).toBe('new-header')
    expect(result?.manifest).toBe(newHeader)
  })

  it('returns null when the lookup returns null at the start', () => {
    expect(resolveFragmentArchiveAlias('does-not-exist', () => null)).toBeNull()
  })

  it('returns null when the alias target does not exist (chain ends mid-resolution)', () => {
    const oldHeader = archivedFragment('missing-target')
    const lookup = (n: string) => (n === 'old-header' ? oldHeader : null)
    expect(resolveFragmentArchiveAlias('old-header', lookup)).toBeNull()
  })

  it('throws ArchivedNoAliasError when archived with no aliasOf', () => {
    const archivedNoAlias = archivedFragment(/* no alias */)
    const lookup = (n: string) => (n === 'old' ? archivedNoAlias : null)
    expect(() => resolveFragmentArchiveAlias('old', lookup)).toThrow(ArchivedNoAliasError)
  })

  it('throws ArchivedNoAliasError mid-chain (a → b → b is archived without alias)', () => {
    const a = archivedFragment('b')
    const b = archivedFragment(/* no alias */)
    const lookup = (n: string) => {
      if (n === 'a') return a
      if (n === 'b') return b
      return null
    }
    expect(() => resolveFragmentArchiveAlias('a', lookup)).toThrow(ArchivedNoAliasError)
  })

  it('detects cycles defensively (a → b → a)', () => {
    const a = archivedFragment('b')
    const b = archivedFragment('a')
    const lookup = (n: string) => {
      if (n === 'a') return a
      if (n === 'b') return b
      return null
    }
    expect(() => resolveFragmentArchiveAlias('a', lookup)).toThrow(/Circular/)
  })

  it('throws when chain exceeds MAX_ALIAS_HOPS (5) without landing on a live fragment', () => {
    // Each hop is archived with aliasOf pointing to the next; never
    // terminates at a live fragment within the 6-step budget (start +
    // 5 hops). The final node is never resolved. With aliasOf: a→b→c→d→e→f→g
    // we have 7 named items in the chain — exhausts the budget cleanly.
    const chain = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const fragments: Record<string, ComponentManifest> = {}
    for (let i = 0; i < chain.length - 1; i++) {
      fragments[chain[i]!] = archivedFragment(chain[i + 1])
    }
    // Last one also archived with alias to a phantom — chain never lands on live
    fragments[chain[chain.length - 1]!] = archivedFragment('phantom')
    const lookup = (n: string) => fragments[n] ?? null
    expect(() => resolveFragmentArchiveAlias('a', lookup)).toThrow(/exceeded.*hops/)
  })

  it('handles a chain where second hop is the live target (Q3 flatten happy path)', () => {
    // Q3 flatten guarantees chains of length 1 — old → live. Verify
    // the helper handles this exact common case.
    const live = liveFragment()
    const archived = archivedFragment('live-target')
    const lookup = (n: string) => {
      if (n === 'old') return archived
      if (n === 'live-target') return live
      return null
    }
    const result = resolveFragmentArchiveAlias('old', lookup)
    expect(result?.resolvedName).toBe('live-target')
    expect(result?.manifest).toBe(live)
  })

  it('ArchivedNoAliasError carries the fragment name for forensics', () => {
    const archived = archivedFragment(/* no alias */)
    const lookup = (n: string) => (n === 'lonely' ? archived : null)
    try {
      resolveFragmentArchiveAlias('lonely', lookup)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ArchivedNoAliasError)
      expect((err as ArchivedNoAliasError).fragmentName).toBe('lonely')
      expect((err as ArchivedNoAliasError).message).toMatch(/lonely/)
    }
  })

  it('error messages include contextPath when provided', () => {
    const archived = archivedFragment(/* no alias */)
    const lookup = (n: string) => (n === 'lonely' ? archived : null)
    try {
      resolveFragmentArchiveAlias('lonely', lookup, 'home → @lonely')
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toMatch(/home → @lonely/)
    }
  })
})
