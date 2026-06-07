/**
 * Cut 2 of review-workflow (issue #516).
 *
 * Pins the capability vocabulary additions wired into RBAC:
 *
 *   - `review:submit`     — submit content for review
 *   - `review:approve`    — approve OR reject pending reviews
 *   - `publish:request`   — request a publish to a target
 *   - `publish:approve`   — approve a pending publish request
 *
 * Three acceptance halves:
 *
 *   1. Default-role capability presence. `editor` gains `review:submit`;
 *      new `reviewer` role aliases `['review:approve']`; new `publisher`
 *      role aliases `['publish:request', 'publish:approve']`.
 *   2. Unknown-capability rejection at config load. A custom role
 *      declaring a syntactically-valid but undefined capability like
 *      `review:foo` is rejected by `AuthConfigSchema` — the closed
 *      built-in capability set is the source of truth, plugin-scoped
 *      capabilities (`@org/...`) pass through.
 *   3. End-to-end resolution against role mappings. The group-claim →
 *      role → capability set chain delivers the new capabilities so
 *      `capabilityGrants(principal.capabilities, 'review:submit')`
 *      resolves correctly. (The acceptance bullet writes this as
 *      `principal.has('review:submit')`; the project's grant check
 *      lives on the free function rather than a method, but the
 *      semantics are identical.)
 */
import { describe, expect, it } from 'vitest'
import { AuthConfigSchema, BUILT_IN_ROLES, capabilityGrants, expandRole, resolveRole } from '../src/auth/index.js'

describe('default-role capability presence (Cut 2 of review-workflow)', () => {
  it('editor role gains review:submit (in addition to existing capabilities)', () => {
    const editor = BUILT_IN_ROLES.editor
    expect(editor).toContain('review:submit')
    // Existing capabilities preserved — additive change.
    expect(editor).toContain('read:*')
    expect(editor).toContain('edit:*')
    expect(editor).toContain('publish:non-production')
  })

  it('editor does NOT gain review:approve (that is the reviewer role)', () => {
    const editor = BUILT_IN_ROLES.editor
    expect(editor).not.toContain('review:approve')
  })

  it('reviewer is a built-in role aliasing [review:approve]', () => {
    const reviewer = BUILT_IN_ROLES.reviewer
    expect(reviewer).toBeDefined()
    expect(reviewer).toContain('review:approve')
  })

  it('publisher is a built-in role aliasing [publish:request, publish:approve]', () => {
    const publisher = BUILT_IN_ROLES.publisher
    expect(publisher).toBeDefined()
    expect(publisher).toContain('publish:request')
    expect(publisher).toContain('publish:approve')
  })

  it('admin role still grants everything via root wildcard, including new capabilities', () => {
    // capabilityGrants is the authoritative check; admin's '*' must
    // cover the four new capabilities so the role-resolver doesn't
    // silently deny escalations to admin.
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'review:submit')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'review:approve')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'publish:request')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.admin, 'publish:approve')).toBe(true)
  })

  it('viewer role still does NOT grant any of the new capabilities', () => {
    // viewer is read-only; the review-workflow additions don't
    // accidentally widen its scope. Guards against a future refactor
    // that would unify viewer with read:*-plus-something.
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'review:submit')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'review:approve')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'publish:request')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'publish:approve')).toBe(false)
  })

  it('expandRole resolves the new built-in roles', () => {
    expect(expandRole('reviewer')).toEqual(['review:approve'])
    expect(expandRole('publisher')).toEqual(['publish:request', 'publish:approve'])
  })
})

describe('unknown-capability rejection at config load (Cut 2 of review-workflow)', () => {
  it('AuthConfigSchema rejects a custom role declaring an undefined review:* capability', () => {
    // `review:foo` is syntactically valid (`<prefix>:<rest>`) but is
    // not a known built-in capability. The schema must reject — the
    // built-in capability set is closed.
    const result = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        custom: { capabilities: ['review:foo'] },
      },
    })
    expect(result.success).toBe(false)
  })

  it('AuthConfigSchema rejects a custom role declaring an undefined publish:* capability', () => {
    // Same shape, in the `publish:` namespace — the closed set is
    // enforced for every reserved built-in prefix.
    const result = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        custom: { capabilities: ['publish:tomorrow'] },
      },
    })
    expect(result.success).toBe(false)
  })

  it('AuthConfigSchema accepts a custom role declaring only known built-in capabilities', () => {
    // Sanity: a well-formed config passes. Guards against a
    // schema-too-strict regression.
    const result = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        approver: { capabilities: ['read:pages', 'review:approve', 'publish:approve'] },
      },
    })
    expect(result.success).toBe(true)
  })

  it('AuthConfigSchema accepts a plugin-scoped capability (@org/...) untouched', () => {
    // Plugin-supplied capabilities use scoped prefixes; the closed
    // built-in check must NOT reject them. Per design-auth-rbac.md
    // Q3 — "Plugin-contributed capabilities follow the same vocabulary
    // shape; reserved-prefix conventions documented in the plugin
    // design pass."
    const result = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        searcher: { capabilities: ['@my-org/search:rebuild-index', '@my-org/search:*'] },
      },
    })
    expect(result.success).toBe(true)
  })

  it('AuthConfigSchema still accepts root and prefix wildcards', () => {
    // Wildcards are always known.
    const result = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        superuser: { capabilities: ['*'] },
        wideReader: { capabilities: ['read:*'] },
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('principal capability resolution against role mappings (Cut 2 of review-workflow)', () => {
  it('editor mapped from upstream group ends up with review:submit', () => {
    // Group-claim → role → capability set. The test simulates the
    // full chain: upstream populates groups; mapping picks the
    // Gazetta role; expansion returns the role's capabilities; the
    // grant check answers principal.has('review:submit').
    const resolved = resolveRole({
      groups: ['gazetta-editors'],
      mapping: { claim: 'groups', map: { 'gazetta-editors': 'editor' } },
    })
    expect(resolved?.name).toBe('editor')
    expect(capabilityGrants(resolved!.capabilities, 'review:submit')).toBe(true)
    // editor still doesn't approve.
    expect(capabilityGrants(resolved!.capabilities, 'review:approve')).toBe(false)
  })

  it('reviewer mapped from upstream group ends up with review:approve', () => {
    const resolved = resolveRole({
      groups: ['gazetta-reviewers'],
      mapping: { claim: 'groups', map: { 'gazetta-reviewers': 'reviewer' } },
    })
    expect(resolved?.name).toBe('reviewer')
    expect(capabilityGrants(resolved!.capabilities, 'review:approve')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'review:submit')).toBe(false)
  })

  it('publisher mapped from upstream group ends up with publish:request AND publish:approve', () => {
    const resolved = resolveRole({
      groups: ['gazetta-publishers'],
      mapping: { claim: 'groups', map: { 'gazetta-publishers': 'publisher' } },
    })
    expect(resolved?.name).toBe('publisher')
    expect(capabilityGrants(resolved!.capabilities, 'publish:request')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'publish:approve')).toBe(true)
  })

  it('admin mapped from upstream group grants every new capability via root wildcard', () => {
    const resolved = resolveRole({
      groups: ['gazetta-admins'],
      mapping: { claim: 'groups', map: { 'gazetta-admins': 'admin' } },
    })
    expect(resolved?.name).toBe('admin')
    expect(capabilityGrants(resolved!.capabilities, 'review:submit')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'review:approve')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'publish:request')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'publish:approve')).toBe(true)
  })

  it('viewer mapped from upstream group does NOT grant any new capability', () => {
    const resolved = resolveRole({
      groups: ['gazetta-viewers'],
      mapping: { claim: 'groups', map: { 'gazetta-viewers': 'viewer' } },
    })
    expect(resolved?.name).toBe('viewer')
    expect(capabilityGrants(resolved!.capabilities, 'review:submit')).toBe(false)
    expect(capabilityGrants(resolved!.capabilities, 'review:approve')).toBe(false)
    expect(capabilityGrants(resolved!.capabilities, 'publish:request')).toBe(false)
    expect(capabilityGrants(resolved!.capabilities, 'publish:approve')).toBe(false)
  })
})
