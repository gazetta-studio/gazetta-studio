/**
 * Cut 6 tests: capability matching + role resolution.
 *
 * Two halves:
 *   1. capabilityGrants — pure wildcard expansion. Pin every shape:
 *      `*` grants everything; `<prefix>:*` grants under-prefix only;
 *      exact match.
 *   2. resolveRole — group-claim → role → capability chain. Pin
 *      first-match-wins ordering, defaultRole fallback, null on
 *      no-match-and-no-default, custom roles overriding built-ins
 *      (rejected at validation time).
 */
import { describe, expect, it } from 'vitest'
import { BUILT_IN_ROLES, capabilityGrants, expandRole, resolveRole, validateCustomRoles } from '../src/auth/index.js'

describe('capabilityGrants (Cut 6)', () => {
  it('root wildcard * grants any capability', () => {
    expect(capabilityGrants(['*'], 'read:pages')).toBe(true)
    expect(capabilityGrants(['*'], 'edit:pages')).toBe(true)
    expect(capabilityGrants(['*'], 'delete:pages')).toBe(true)
    expect(capabilityGrants(['*'], '@my-org/search:rebuild-index')).toBe(true)
  })

  it('prefix wildcard read:* grants any read capability', () => {
    expect(capabilityGrants(['read:*'], 'read:pages')).toBe(true)
    expect(capabilityGrants(['read:*'], 'read:fragments')).toBe(true)
    expect(capabilityGrants(['read:*'], 'read:audit-log')).toBe(true)
  })

  it('prefix wildcard does NOT cross prefixes', () => {
    expect(capabilityGrants(['read:*'], 'edit:pages')).toBe(false)
    expect(capabilityGrants(['edit:*'], 'read:pages')).toBe(false)
    expect(capabilityGrants(['read:*'], 'delete:pages')).toBe(false)
  })

  it('exact match grants the specific capability', () => {
    expect(capabilityGrants(['read:pages'], 'read:pages')).toBe(true)
    expect(capabilityGrants(['read:pages'], 'read:fragments')).toBe(false)
  })

  it('returns false when capability set is empty', () => {
    expect(capabilityGrants([], 'read:pages')).toBe(false)
  })

  it('returns false when required capability is empty', () => {
    expect(capabilityGrants(['*'], '')).toBe(false)
  })

  it('multi-cap principal: any match grants', () => {
    expect(capabilityGrants(['read:pages', 'edit:fragments'], 'edit:fragments')).toBe(true)
    expect(capabilityGrants(['read:pages', 'edit:fragments'], 'delete:pages')).toBe(false)
  })

  it('plugin-scoped wildcard works', () => {
    expect(capabilityGrants(['@my-org/search:*'], '@my-org/search:rebuild-index')).toBe(true)
    expect(capabilityGrants(['@my-org/search:*'], '@other-org/search:rebuild-index')).toBe(false)
  })

  it('admin role (BUILT_IN_ROLES.admin) grants everything', () => {
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'read:pages')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'configure:site')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'publish:production')).toBe(true)
  })

  it('editor role grants read + edit + non-prod publish but NOT prod publish', () => {
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'read:pages')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'edit:pages')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'publish:non-production')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'publish:production')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'delete:pages')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'configure:site')).toBe(false)
  })

  it('viewer role grants only reads', () => {
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'read:pages')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'edit:pages')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'publish:non-production')).toBe(false)
  })
})

describe('expandRole (Cut 6)', () => {
  it('expands built-in roles', () => {
    expect(expandRole('admin')).toEqual(['*'])
    expect(expandRole('editor')).toEqual(['read:*', 'edit:*', 'publish:non-production'])
    expect(expandRole('viewer')).toEqual(['read:*'])
  })

  it('expands custom roles when supplied', () => {
    const custom = { translator: ['read:pages', 'edit:locale-variants'] }
    expect(expandRole('translator', custom)).toEqual(['read:pages', 'edit:locale-variants'])
  })

  it('custom roles take precedence when matching a built-in name (operator-error case)', () => {
    // The validateCustomRoles step is supposed to catch this; if it
    // somehow gets through, the custom definition wins. Documents
    // the precedence so future maintainers know what happens.
    const custom = { admin: ['read:pages'] }
    expect(expandRole('admin', custom)).toEqual(['read:pages'])
  })

  it('returns null for unknown role', () => {
    expect(expandRole('nonexistent')).toBeNull()
    expect(expandRole('translator')).toBeNull() // no customRoles supplied
  })
})

describe('resolveRole (Cut 6)', () => {
  it('resolves first-matching group via roleMapping', () => {
    const result = resolveRole({
      groups: ['gazetta-editors'],
      mapping: {
        claim: 'groups',
        map: { 'gazetta-admins': 'admin', 'gazetta-editors': 'editor' },
      },
    })
    expect(result?.name).toBe('editor')
    expect(result?.capabilities).toContain('edit:*')
  })

  it('first-match-wins follows config-array order', () => {
    // Admin appears first in the map; user has both groups.
    const result = resolveRole({
      groups: ['gazetta-editors', 'gazetta-admins'],
      mapping: {
        claim: 'groups',
        map: { 'gazetta-admins': 'admin', 'gazetta-editors': 'editor' },
      },
    })
    expect(result?.name).toBe('admin')
  })

  it('falls back to defaultRole when no group matches', () => {
    const result = resolveRole({
      groups: ['unrelated-group'],
      mapping: {
        claim: 'groups',
        map: { 'gazetta-admins': 'admin' },
        defaultRole: 'viewer',
      },
    })
    expect(result?.name).toBe('viewer')
  })

  it('returns null when defaultRole is explicitly null and no match', () => {
    const result = resolveRole({
      groups: ['unrelated-group'],
      mapping: {
        claim: 'groups',
        map: { 'gazetta-admins': 'admin' },
        defaultRole: null,
      },
    })
    expect(result).toBeNull()
  })

  it('returns null when no mapping is supplied', () => {
    const result = resolveRole({ groups: ['gazetta-admins'] })
    expect(result).toBeNull()
  })

  it('returns null when resolved role name is unknown', () => {
    const result = resolveRole({
      groups: ['some-group'],
      mapping: {
        claim: 'groups',
        map: { 'some-group': 'super-admin-doesnt-exist' },
      },
    })
    expect(result).toBeNull()
  })

  it('resolves custom roles', () => {
    const result = resolveRole({
      groups: ['translators'],
      mapping: {
        claim: 'groups',
        map: { translators: 'translator' },
      },
      customRoles: { translator: ['read:pages', 'edit:locale-variants'] },
    })
    expect(result?.name).toBe('translator')
    expect(result?.capabilities).toEqual(['read:pages', 'edit:locale-variants'])
  })

  it('returns null when groups is empty and no defaultRole', () => {
    const result = resolveRole({
      groups: [],
      mapping: { claim: 'groups', map: { 'gazetta-admins': 'admin' } },
    })
    expect(result).toBeNull()
  })
})

describe('validateCustomRoles (Cut 6)', () => {
  it('returns empty array for valid custom roles', () => {
    const issues = validateCustomRoles({
      translator: ['read:pages', 'edit:locale-variants'],
      auditor: ['read:*', 'read:audit-log'],
    })
    expect(issues).toEqual([])
  })

  it('flags conflict with built-in admin role', () => {
    const issues = validateCustomRoles({ admin: ['read:pages'] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('admin')
    expect(issues[0]).toContain('built-in')
  })

  it('flags conflict with built-in editor role', () => {
    const issues = validateCustomRoles({ editor: ['*'] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('editor')
  })

  it('flags conflict with built-in viewer role', () => {
    const issues = validateCustomRoles({ viewer: ['*'] })
    expect(issues).toHaveLength(1)
  })

  it('reports multiple conflicts', () => {
    const issues = validateCustomRoles({
      admin: ['x'],
      editor: ['y'],
      translator: ['read:pages'],
    })
    expect(issues).toHaveLength(2)
  })

  it('returns empty for empty custom-roles map', () => {
    expect(validateCustomRoles({})).toEqual([])
  })
})
