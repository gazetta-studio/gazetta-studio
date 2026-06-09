/**
 * Review-workflow Cut 2 — capability vocabulary tests.
 *
 * Pins three contracts:
 *   1. Default roles carry the new review/publish capabilities
 *      (editor + reviewer + publisher).
 *   2. Unknown reserved-prefix capabilities (`review:foo`) are
 *      rejected at config load via the Zod refinement.
 *   3. A principal's capability check resolves review:* + publish:*
 *      via the role-mapping → expandRole → capabilityGrants chain.
 */
import { describe, expect, it } from 'vitest'
import {
  AuthConfigSchema,
  BUILT_IN_ROLES,
  capabilityGrants,
  expandRole,
  isKnownCapability,
  KNOWN_CAPABILITIES,
  resolveRole,
} from '../src/auth/index.js'

describe('Default roles — review/publish capability presence (Cut 2)', () => {
  it('editor gains review:submit (can submit own edits for review)', () => {
    expect(BUILT_IN_ROLES.editor).toContain('review:submit')
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'review:submit')).toBe(true)
    // Editor does NOT gain review:approve — separation of concerns
    expect(BUILT_IN_ROLES.editor).not.toContain('review:approve')
    expect(capabilityGrants(BUILT_IN_ROLES.editor, 'review:approve')).toBe(false)
  })

  it('reviewer exists with review:approve + read:* (must see content to approve)', () => {
    expect(BUILT_IN_ROLES.reviewer).toBeDefined()
    expect(BUILT_IN_ROLES.reviewer).toContain('review:approve')
    expect(BUILT_IN_ROLES.reviewer).toContain('read:*')
    // Reviewer cannot edit, publish, or submit reviews
    expect(capabilityGrants(BUILT_IN_ROLES.reviewer, 'edit:pages')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.reviewer, 'publish:non-production')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.reviewer, 'review:submit')).toBe(false)
    // ...but CAN read content they need to review
    expect(capabilityGrants(BUILT_IN_ROLES.reviewer, 'read:pages')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.reviewer, 'read:fragments')).toBe(true)
  })

  it('publisher exists with publish:request + publish:approve + read:*', () => {
    expect(BUILT_IN_ROLES.publisher).toBeDefined()
    expect(BUILT_IN_ROLES.publisher).toContain('publish:request')
    expect(BUILT_IN_ROLES.publisher).toContain('publish:approve')
    expect(BUILT_IN_ROLES.publisher).toContain('read:*')
    expect(capabilityGrants(BUILT_IN_ROLES.publisher, 'publish:request')).toBe(true)
    expect(capabilityGrants(BUILT_IN_ROLES.publisher, 'publish:approve')).toBe(true)
    // Publisher does not implicitly gain publish:production / publish:non-production
    // (those are environment-scoped publish capabilities, distinct from
    // the request/approve gate). Operators wanting "publisher can also
    // publish anywhere" compose a custom role with both.
    expect(capabilityGrants(BUILT_IN_ROLES.publisher, 'publish:production')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.publisher, 'publish:non-production')).toBe(false)
    // Cannot edit or submit reviews
    expect(capabilityGrants(BUILT_IN_ROLES.publisher, 'edit:pages')).toBe(false)
    expect(capabilityGrants(BUILT_IN_ROLES.publisher, 'review:submit')).toBe(false)
  })

  it('admin (root wildcard) still grants every new capability', () => {
    for (const cap of ['review:submit', 'review:approve', 'publish:request', 'publish:approve'] as const) {
      expect(capabilityGrants(BUILT_IN_ROLES.admin, cap)).toBe(true)
    }
  })

  it('viewer (read-only) gains none of the new capabilities', () => {
    for (const cap of ['review:submit', 'review:approve', 'publish:request', 'publish:approve'] as const) {
      expect(capabilityGrants(BUILT_IN_ROLES.viewer, cap)).toBe(false)
    }
  })

  it('publish:* wildcard grants publish:request + publish:approve (custom-role shorthand)', () => {
    // Operators writing a "release-manager" custom role can use the
    // wildcard to grant every publish:* capability at once.
    expect(capabilityGrants(['publish:*'], 'publish:request')).toBe(true)
    expect(capabilityGrants(['publish:*'], 'publish:approve')).toBe(true)
    expect(capabilityGrants(['publish:*'], 'publish:production')).toBe(true)
  })

  it('review:* wildcard grants review:submit + review:approve (custom-role shorthand)', () => {
    expect(capabilityGrants(['review:*'], 'review:submit')).toBe(true)
    expect(capabilityGrants(['review:*'], 'review:approve')).toBe(true)
  })

  it('publish:request does NOT grant publish:approve (two-approver separation)', () => {
    // Distinct capabilities exist precisely so they can be granted to
    // different roles in the 4-eyes archetype. Pin the negative case.
    expect(capabilityGrants(['publish:request'], 'publish:approve')).toBe(false)
    expect(capabilityGrants(['publish:approve'], 'publish:request')).toBe(false)
  })

  it('review:submit does NOT grant review:approve', () => {
    expect(capabilityGrants(['review:submit'], 'review:approve')).toBe(false)
    expect(capabilityGrants(['review:approve'], 'review:submit')).toBe(false)
  })

  it('expandRole returns expected capability sets for reviewer + publisher', () => {
    expect(expandRole('reviewer')).toEqual(['read:*', 'review:approve'])
    expect(expandRole('publisher')).toEqual(['read:*', 'publish:request', 'publish:approve'])
  })
})

describe('KNOWN_CAPABILITIES registry (Cut 2)', () => {
  it('contains the four new capabilities', () => {
    expect(KNOWN_CAPABILITIES.has('review:submit')).toBe(true)
    expect(KNOWN_CAPABILITIES.has('review:approve')).toBe(true)
    expect(KNOWN_CAPABILITIES.has('publish:request')).toBe(true)
    expect(KNOWN_CAPABILITIES.has('publish:approve')).toBe(true)
  })

  it('contains review:* alongside the existing wildcards', () => {
    expect(KNOWN_CAPABILITIES.has('review:*')).toBe(true)
    expect(KNOWN_CAPABILITIES.has('publish:*')).toBe(true)
  })

  it('still contains all pre-existing built-in capabilities (no removal)', () => {
    // Spot-check representative pre-existing caps to guard against
    // accidental removals when editing the registry.
    for (const cap of [
      'read:pages',
      'edit:locale-variants',
      'delete:assets',
      'publish:production',
      'configure:site',
      'restore:history',
      '*',
    ] as const) {
      expect(KNOWN_CAPABILITIES.has(cap)).toBe(true)
    }
  })
})

describe('isKnownCapability — config-load semantics (Cut 2)', () => {
  it('accepts every built-in capability', () => {
    expect(isKnownCapability('review:submit')).toBe(true)
    expect(isKnownCapability('publish:approve')).toBe(true)
    expect(isKnownCapability('read:pages')).toBe(true)
    expect(isKnownCapability('*')).toBe(true)
    expect(isKnownCapability('read:*')).toBe(true)
    expect(isKnownCapability('review:*')).toBe(true)
  })

  it('rejects reserved-prefix capabilities not in the registry', () => {
    // The point of this gate — operator typo / stale config catch.
    expect(isKnownCapability('review:foo')).toBe(false)
    expect(isKnownCapability('publish:nonsense')).toBe(false)
    expect(isKnownCapability('read:imaginary')).toBe(false)
    expect(isKnownCapability('configure:plugins')).toBe(false)
  })

  it('accepts plugin-scoped capabilities (non-reserved prefix)', () => {
    // Plugin foundation owns its namespace; reserved-prefix check
    // only constrains the built-in vocabulary.
    expect(isKnownCapability('@my-org/search:rebuild-index')).toBe(true)
    expect(isKnownCapability('@example/notify:send')).toBe(true)
    expect(isKnownCapability('@example/notify:*')).toBe(true)
  })

  it('rejects strings without a colon (not even a prefix)', () => {
    expect(isKnownCapability('read')).toBe(false)
    expect(isKnownCapability('foo')).toBe(false)
  })
})

describe('AuthConfigSchema rejects unknown capabilities at config load (Cut 2)', () => {
  it('rejects a custom role declaring review:foo', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        badReviewer: { capabilities: ['review:foo'] },
      },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('Unknown capability')
    }
  })

  it('rejects a custom role declaring publish:nonsense', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        bad: { capabilities: ['read:pages', 'publish:nonsense'] },
      },
    })
    expect(r.success).toBe(false)
  })

  it('accepts a custom role using the four new capabilities directly', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        releaseManager: {
          capabilities: ['read:*', 'publish:request', 'publish:approve'],
        },
        contentReviewer: {
          capabilities: ['read:*', 'review:approve'],
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it('still accepts plugin-scoped capabilities (no regression)', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        searcher: { capabilities: ['@my-org/search:rebuild-index'] },
      },
    })
    expect(r.success).toBe(true)
  })

  it('still accepts wildcards (no regression on Cut 6 contract)', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        godmode: { capabilities: ['*'] },
        readers: { capabilities: ['read:*'] },
      },
    })
    expect(r.success).toBe(true)
  })
})

describe('Principal capability check via role mapping (Cut 2)', () => {
  // The acceptance criterion described as `principal.has('review:submit')`:
  // the principal carries a capability set (computed via expandRole on the
  // resolved role); `capabilityGrants(principal.capabilities, required)`
  // is how middleware actually checks. These tests pin the full chain
  // from group claim → role → capability set → grant decision.

  it('upstream "editors" group → editor role → can submit reviews', () => {
    const resolved = resolveRole({
      groups: ['editors'],
      mapping: {
        claim: 'groups',
        map: { editors: 'editor', reviewers: 'reviewer', publishers: 'publisher' },
      },
    })
    expect(resolved?.name).toBe('editor')
    expect(capabilityGrants(resolved!.capabilities, 'review:submit')).toBe(true)
    // Editor cannot approve their own review without self-approval allowance
    expect(capabilityGrants(resolved!.capabilities, 'review:approve')).toBe(false)
  })

  it('upstream "reviewers" group → reviewer role → can approve reviews', () => {
    const resolved = resolveRole({
      groups: ['reviewers'],
      mapping: {
        claim: 'groups',
        map: { editors: 'editor', reviewers: 'reviewer' },
      },
    })
    expect(resolved?.name).toBe('reviewer')
    expect(capabilityGrants(resolved!.capabilities, 'review:approve')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'review:submit')).toBe(false)
  })

  it('upstream "publishers" group → publisher role → can request + approve publish', () => {
    const resolved = resolveRole({
      groups: ['publishers'],
      mapping: {
        claim: 'groups',
        map: { editors: 'editor', publishers: 'publisher' },
      },
    })
    expect(resolved?.name).toBe('publisher')
    expect(capabilityGrants(resolved!.capabilities, 'publish:request')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'publish:approve')).toBe(true)
  })

  it('custom "release-manager" role with publish:* wildcard grants both publish:request and publish:approve', () => {
    // Composition path: operator defines a custom role using the wildcard
    // rather than enumerating both capabilities. Validates the
    // archetype where one role covers the whole publish-gate workflow.
    const resolved = resolveRole({
      groups: ['releasers'],
      mapping: {
        claim: 'groups',
        map: { releasers: 'release-manager' },
      },
      customRoles: { 'release-manager': ['read:*', 'publish:*'] },
    })
    expect(resolved?.name).toBe('release-manager')
    expect(capabilityGrants(resolved!.capabilities, 'publish:request')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'publish:approve')).toBe(true)
    expect(capabilityGrants(resolved!.capabilities, 'publish:production')).toBe(true)
  })

  it('viewer role denies every review/publish capability', () => {
    const resolved = resolveRole({
      groups: ['readers'],
      mapping: { claim: 'groups', map: { readers: 'viewer' } },
    })
    expect(resolved?.name).toBe('viewer')
    for (const cap of ['review:submit', 'review:approve', 'publish:request', 'publish:approve'] as const) {
      expect(capabilityGrants(resolved!.capabilities, cap)).toBe(false)
    }
  })
})
