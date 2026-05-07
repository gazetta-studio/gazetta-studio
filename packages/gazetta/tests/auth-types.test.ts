/**
 * Cuts 1+2 of auth/RBAC implementation: types + Zod schema + the
 * `none` trust-mode provider. The contract is the seam every
 * subsequent cut hangs off, so tests pin:
 *
 *   - Schema accepts the documented shapes; rejects malformed input
 *   - Capability regex catches typos at config-load time
 *   - `none` provider returns the canonical unknown principal
 *   - `isReservedPrefix` correctly identifies built-in prefixes
 *   - `BUILT_IN_ROLES` are stable + correct
 *   - Error classes carry the right httpStatus + name
 */
import { describe, expect, it } from 'vitest'
import {
  AuthConfigSchema,
  AuthConfigurationError,
  AuthError,
  AuthenticationError,
  AuthorizationError,
  BUILT_IN_ROLES,
  isReservedPrefix,
  noneAuthProvider,
  RESERVED_CAPABILITY_PREFIXES,
  UNKNOWN_ACTOR_ID,
} from '../src/auth/index.js'

describe('AuthConfigSchema (Cut 1)', () => {
  it('accepts trust: none with no other fields', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'none' })
    expect(r.success).toBe(true)
  })

  it('accepts trust: none with custom roles', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        translator: { capabilities: ['read:pages', 'edit:locale-variants'] },
      },
    })
    expect(r.success).toBe(true)
  })

  it('rejects unknown trust mode', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'unknown-mode' })
    expect(r.success).toBe(false)
  })

  it('rejects malformed capability', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        bad: { capabilities: ['this is not a capability'] },
      },
    })
    expect(r.success).toBe(false)
  })

  it('accepts wildcard capability', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: { godmode: { capabilities: ['*'] } },
    })
    expect(r.success).toBe(true)
  })

  it('accepts plugin-scoped capability', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'none',
      roles: {
        searcher: { capabilities: ['@my-org/search:rebuild-index'] },
      },
    })
    expect(r.success).toBe(true)
  })

  it('rejects extra unknown fields (strict mode)', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'none', extra: 'nope' })
    expect(r.success).toBe(false)
  })
})

describe('isReservedPrefix', () => {
  it('treats wildcard as reserved', () => {
    expect(isReservedPrefix('*')).toBe(true)
  })

  it('detects each built-in prefix', () => {
    for (const prefix of RESERVED_CAPABILITY_PREFIXES) {
      expect(isReservedPrefix(`${prefix}:something`)).toBe(true)
    }
  })

  it('treats plugin-scoped prefix as not reserved', () => {
    expect(isReservedPrefix('@my-org/search:rebuild-index')).toBe(false)
  })

  it('returns false for capabilities with no colon', () => {
    expect(isReservedPrefix('read')).toBe(false)
  })
})

describe('BUILT_IN_ROLES', () => {
  it('admin gets full wildcard', () => {
    expect(BUILT_IN_ROLES.admin).toEqual(['*'])
  })

  it('editor has read + edit + non-prod publish (not delete, not configure)', () => {
    expect(BUILT_IN_ROLES.editor).toContain('read:*')
    expect(BUILT_IN_ROLES.editor).toContain('edit:*')
    expect(BUILT_IN_ROLES.editor).toContain('publish:non-production')
    // Editor does NOT have publish:production (locked invariant —
    // editors can't publish to prod by default).
    expect(BUILT_IN_ROLES.editor).not.toContain('publish:production')
    expect(BUILT_IN_ROLES.editor).not.toContain('delete:*')
    expect(BUILT_IN_ROLES.editor).not.toContain('configure:site')
  })

  it('viewer is read-only', () => {
    expect(BUILT_IN_ROLES.viewer).toEqual(['read:*'])
  })

  it('the three built-in role names are stable', () => {
    // Pin the names so consumers can rely on them; renaming any of
    // these is an audit-log + role-mapping breaking change.
    expect(Object.keys(BUILT_IN_ROLES).sort()).toEqual(['admin', 'editor', 'viewer'])
  })
})

describe('Error taxonomy (Cut 1)', () => {
  it('AuthError is the base class; subclasses extend it', () => {
    expect(new AuthConfigurationError('x')).toBeInstanceOf(AuthError)
    expect(new AuthenticationError('x')).toBeInstanceOf(AuthError)
    expect(new AuthorizationError('x', ['edit:pages'], 'viewer')).toBeInstanceOf(AuthError)
  })

  it('AuthConfigurationError is 500', () => {
    expect(new AuthConfigurationError('bad config').httpStatus).toBe(500)
  })

  it('AuthenticationError is 401', () => {
    expect(new AuthenticationError('missing token').httpStatus).toBe(401)
  })

  it('AuthorizationError is 403 with missing + role', () => {
    const err = new AuthorizationError('not allowed', ['edit:pages'], 'viewer')
    expect(err.httpStatus).toBe(403)
    expect(err.missing).toEqual(['edit:pages'])
    expect(err.role).toBe('viewer')
  })

  it('Error names are set so try/catch by name works', () => {
    expect(new AuthConfigurationError('x').name).toBe('AuthConfigurationError')
    expect(new AuthenticationError('x').name).toBe('AuthenticationError')
    expect(new AuthorizationError('x', [], 'r').name).toBe('AuthorizationError')
  })
})

describe('noneAuthProvider (Cut 2)', () => {
  it('declares trust mode none', () => {
    expect(noneAuthProvider.trustMode).toBe('none')
  })

  it('returns the canonical unknown principal regardless of request shape', async () => {
    const principal = await noneAuthProvider.extractPrincipal({ headers: new Map() })
    expect(principal).toEqual({
      id: UNKNOWN_ACTOR_ID,
      role: 'admin',
      trustMode: 'none',
      capabilities: ['*'],
    })
  })

  it("returns the same principal even when headers carry a forged 'user' field", async () => {
    // none mode IGNORES upstream headers; this is the security
    // contract — a misconfigured proxy can't leak identity into a
    // none-mode deployment.
    const principal = await noneAuthProvider.extractPrincipal({
      headers: new Map([
        ['x-forwarded-user', 'attacker@example.com'],
        ['cf-access-authenticated-user-email', 'attacker@example.com'],
      ]),
    })
    expect(principal?.id).toBe(UNKNOWN_ACTOR_ID)
    expect(principal?.role).toBe('admin')
  })

  it('UNKNOWN_ACTOR_ID is the locked sentinel', () => {
    // Pin the value so audit-log + history-recorder consumers can
    // depend on it. Changing this is a compatibility break across
    // the audit-log shape.
    expect(UNKNOWN_ACTOR_ID).toBe('unknown')
  })
})
