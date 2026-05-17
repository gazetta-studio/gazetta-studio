import { describe, expect, it } from 'vitest'
import { isSkipped, matchGlob, recordSkipListEntry, type SkipList } from '../skip-list.js'

const emptyList = (): SkipList => ({ version: 1, entries: [], rules: [] })

describe('isSkipped', () => {
  it('returns false for an empty list', () => {
    expect(
      isSkipped(emptyList(), {
        area: 'packages/gazetta/src/auth/',
        type: 'security',
        rule: 'design-auth-rbac.md#capability-gate',
      }),
    ).toBe(false)
  })

  it('matches an exact entry', () => {
    const list = recordSkipListEntry(
      emptyList(),
      { area: 'packages/gazetta/src/auth/', type: 'security', rule: 'design-auth-rbac.md' },
      { reason: 'maintainer-rejected', reasonNote: 'auth design under review' },
    )
    expect(
      isSkipped(list, {
        area: 'packages/gazetta/src/auth/',
        type: 'security',
        rule: 'design-auth-rbac.md',
      }),
    ).toBe(true)
  })

  it('does not match when area differs', () => {
    const list = recordSkipListEntry(
      emptyList(),
      { area: 'packages/gazetta/src/auth/', type: 'security', rule: 'design-auth-rbac.md' },
      { reason: 'wontfix' },
    )
    expect(
      isSkipped(list, {
        area: 'packages/gazetta/src/admin-api/',
        type: 'security',
        rule: 'design-auth-rbac.md',
      }),
    ).toBe(false)
  })

  it('matches a rule glob', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'skip-all-tests-in-helpers',
          scope: 'tests/_helpers/**',
          types: ['tests'],
          reason: 'wontfix',
          addedAt: new Date().toISOString(),
        },
      ],
    }
    expect(
      isSkipped(list, {
        area: 'tests/_helpers/synthetic-site.ts',
        type: 'tests',
        rule: 'testing-plan.md',
      }),
    ).toBe(true)
  })

  it('rule type filter restricts matches', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'skip-architecture-only',
          scope: 'packages/gazetta/src/**',
          types: ['architecture'],
          reason: 'wontfix',
          addedAt: new Date().toISOString(),
        },
      ],
    }
    // Architecture type: matches
    expect(
      isSkipped(list, {
        area: 'packages/gazetta/src/foo.ts',
        type: 'architecture',
        rule: 'design-X.md',
      }),
    ).toBe(true)
    // Security type: does NOT match (type filter excludes)
    expect(
      isSkipped(list, {
        area: 'packages/gazetta/src/foo.ts',
        type: 'security',
        rule: 'design-Y.md',
      }),
    ).toBe(false)
  })

  it('recordSkipListEntry is idempotent on duplicate fingerprint', () => {
    const fp = {
      area: 'packages/gazetta/src/foo.ts',
      type: 'security' as const,
      rule: 'design-X.md',
    }
    const first = recordSkipListEntry(emptyList(), fp, { reason: 'wontfix' })
    const second = recordSkipListEntry(first, fp, { reason: 'maintainer-rejected' })
    expect(second.entries).toHaveLength(1)
    // First write wins; the second is a no-op
    expect(second.entries[0]?.reason).toBe('wontfix')
  })
})

describe("matchGlob (mirror of dead-code-watcher's globMatches)", () => {
  it('matches exact path', () => {
    expect(matchGlob('packages/gazetta/src/foo.ts', 'packages/gazetta/src/foo.ts')).toBe(true)
  })

  it('* matches a single segment', () => {
    expect(matchGlob('packages/*/src/foo.ts', 'packages/gazetta/src/foo.ts')).toBe(true)
    // * does NOT cross slashes
    expect(matchGlob('packages/*/foo.ts', 'packages/gazetta/src/foo.ts')).toBe(false)
  })

  it('** matches across path separators', () => {
    expect(matchGlob('packages/**/foo.ts', 'packages/gazetta/src/foo.ts')).toBe(true)
    expect(matchGlob('packages/**/foo.ts', 'packages/foo.ts')).toBe(true)
  })

  it('does not match unrelated path', () => {
    expect(matchGlob('packages/gazetta/**', 'apps/admin/foo.ts')).toBe(false)
  })

  it('escapes regex metacharacters in pattern', () => {
    expect(matchGlob('foo.bar', 'foo.bar')).toBe(true)
    expect(matchGlob('foo.bar', 'fooXbar')).toBe(false)
  })

  it('? matches a single non-separator char', () => {
    expect(matchGlob('foo?.ts', 'foo1.ts')).toBe(true)
    expect(matchGlob('foo?.ts', 'foo12.ts')).toBe(false)
    expect(matchGlob('foo?.ts', 'foo/.ts')).toBe(false)
  })
})
