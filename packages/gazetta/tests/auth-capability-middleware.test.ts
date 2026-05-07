/**
 * Cut 8 tests: capability-check middleware.
 *
 * Two states matter:
 *   - Anonymous principal (no upstream auth) → 401
 *   - Authenticated principal lacking capability → 403 with
 *     structured body (missing + role + error)
 *   - Authenticated principal with capability → next()
 *
 * Wildcards work transitively (admin's `*` grants any capability).
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { noneAuthProvider, type AuthIdentityProvider, type Principal } from '../src/auth/index.js'
import { principalMiddleware, type PrincipalEnv } from '../src/admin-api/middleware/principal.js'
import { requireCapability } from '../src/admin-api/middleware/capability.js'

function buildApp(provider?: AuthIdentityProvider) {
  const app = new Hono<PrincipalEnv>()
  app.use('/api/*', principalMiddleware(provider))
  app.get('/api/pages', requireCapability('read:pages'), c => c.json({ ok: true }))
  app.put('/api/pages', requireCapability('edit:pages'), c => c.json({ ok: true }))
  app.delete('/api/pages/*', requireCapability('delete:pages'), c => c.json({ ok: true }))
  return app
}

describe('requireCapability (Cut 8)', () => {
  it('allows access when principal has wildcard *', async () => {
    // none mode produces admin principal with capabilities: ['*']
    const app = buildApp(noneAuthProvider)
    const res = await app.request('/api/pages')
    expect(res.status).toBe(200)
  })

  it('allows access when principal has the exact capability', async () => {
    const provider = providerWithCaps(['read:pages'])
    const app = buildApp(provider)
    const res = await app.request('/api/pages')
    expect(res.status).toBe(200)
  })

  it('allows access when principal has the prefix wildcard', async () => {
    const provider = providerWithCaps(['read:*'])
    const app = buildApp(provider)
    const res = await app.request('/api/pages')
    expect(res.status).toBe(200)
  })

  it('returns 403 with structured body when authenticated principal lacks capability', async () => {
    const provider = providerWithCaps(['read:pages'], 'editor')
    const app = buildApp(provider)
    const res = await app.request('/api/pages', { method: 'PUT' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:pages'])
    expect(body.role).toBe('editor')
    expect(body.error).toContain('editor')
    expect(body.error).toContain('edit:pages')
  })

  it('returns 401 when principal is anonymous (no upstream auth)', async () => {
    // Provider returns null → middleware synthesizes ANONYMOUS_PRINCIPAL
    // (id: 'unknown', role: 'unknown', capabilities: [])
    const provider: AuthIdentityProvider = {
      trustMode: 'forwarded-user',
      async extractPrincipal(): Promise<Principal | null> {
        return null
      },
    }
    const app = buildApp(provider)
    const res = await app.request('/api/pages')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const body = await res.json()
    expect(body.code).toBe('UNAUTHENTICATED')
  })

  it('returns 403 (not 401) for an unknown id but known role with insufficient caps', async () => {
    // Edge case: principal is identified (role: viewer) but happens
    // to have id 'unknown' (e.g., upstream provider couldn't extract
    // a stable id). Still 403 because role !== 'unknown' — the
    // request IS authenticated.
    const provider: AuthIdentityProvider = {
      trustMode: 'forwarded-user',
      async extractPrincipal(): Promise<Principal> {
        return {
          id: 'unknown',
          role: 'viewer',
          trustMode: 'forwarded-user',
          capabilities: ['read:pages'],
        }
      },
    }
    const app = buildApp(provider)
    const res = await app.request('/api/pages', { method: 'PUT' })
    expect(res.status).toBe(403)
  })

  it('honors plugin-scoped colon-wildcards', async () => {
    // Plugin-scoped wildcards follow the same `<prefix>:*` shape
    // as built-in: '@my-org/search:*' grants '@my-org/search:rebuild-index'
    // but not '@other-org/search:rebuild-index'.
    const provider = providerWithCaps(['@my-org/search:*'])
    const app = new Hono<PrincipalEnv>()
    app.use('/api/*', principalMiddleware(provider))
    app.get('/api/plugin', requireCapability('@my-org/search:rebuild-index'), c => c.json({ ok: true }))
    app.get('/api/other', requireCapability('@other-org/search:rebuild-index'), c => c.json({ ok: true }))
    expect((await app.request('/api/plugin')).status).toBe(200)
    expect((await app.request('/api/other')).status).toBe(403)
  })

  it('different capabilities on different routes work independently', async () => {
    const provider = providerWithCaps(['read:pages']) // can read, can't write
    const app = buildApp(provider)
    expect((await app.request('/api/pages')).status).toBe(200)
    expect((await app.request('/api/pages', { method: 'PUT' })).status).toBe(403)
    expect((await app.request('/api/pages/x', { method: 'DELETE' })).status).toBe(403)
  })
})

function providerWithCaps(caps: string[], role = 'editor'): AuthIdentityProvider {
  return {
    trustMode: 'forwarded-user',
    async extractPrincipal(): Promise<Principal> {
      return {
        id: 'test-user',
        role,
        trustMode: 'forwarded-user',
        capabilities: caps,
      }
    },
  }
}
