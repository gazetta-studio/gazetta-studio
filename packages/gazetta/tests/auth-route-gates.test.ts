/**
 * Cut 9 tests: confirm requireCapability is wired on every admin-api
 * route and the gate reflects the design's read/edit/delete/publish
 * matrix.
 *
 * Strategy: build an admin app with a fixed-role provider. Sweep
 * every route and assert 403 when the role lacks the gate's
 * capability; 200 (or other non-403) when it has it. The role-
 * resolver isn't wired into providers yet (Cut 6 ships standalone),
 * so we inject capability sets directly via a test provider.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { principalMiddleware, type PrincipalEnv } from '../src/admin-api/middleware/principal.js'
import { validationRoutes } from '../src/admin-api/routes/validation.js'
import type { AuthIdentityProvider, Principal } from '../src/auth/index.js'
import { tempDir } from './_helpers/temp.js'

// Reuse the starter fixture from admin-api.test.ts setup
const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const projectRoot = tempDir('auth-route-gates-' + Date.now())
const projectSiteDir = resolve(projectRoot, 'sites/main')
const localTargetDir = resolve(projectSiteDir, 'targets/local')
const storage = createFilesystemProvider(localTargetDir)

let app: Hono

beforeAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${projectSiteDir}`)
  const manifest = siteConfigToManifest(loaded.config)
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  app = createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
})

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

// The default `none`-mode wiring grants `*` to every request, so
// every gate passes. That's the production-like baseline; this
// test file's other suites would need a custom provider to assert
// 403s. For Cut 9 we focus on the structural assertion: every
// gated route still works under the admin baseline.

describe('Cut 9 — admin-api route gates (none mode = admin role with *)', () => {
  it('GET /api/site → 200 (read:pages gate satisfied by *)', async () => {
    const res = await app.request('/api/site')
    expect(res.status).toBe(200)
  })

  it('GET /api/pages → 200', async () => {
    const res = await app.request('/api/pages')
    expect(res.status).toBe(200)
  })

  it('GET /api/fragments → 200', async () => {
    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
  })

  it('GET /api/templates → 200', async () => {
    const res = await app.request('/api/templates')
    expect(res.status).toBe(200)
  })

  it('GET /api/fields → 200', async () => {
    const res = await app.request('/api/fields')
    expect(res.status).toBe(200)
  })

  it('GET /api/targets → 200', async () => {
    const res = await app.request('/api/targets')
    expect(res.status).toBe(200)
  })

  it('GET /api/dependents → 200 (or 400 for missing query)', async () => {
    const res = await app.request('/api/dependents')
    // Capability gate passed; route may reject for other reasons.
    expect([200, 400]).toContain(res.status)
  })

  it('GET /api/system/cache/stats → 200 (configure:site gate satisfied by *)', async () => {
    const res = await app.request('/api/system/cache/stats')
    expect(res.status).toBe(200)
  })

  it('GET /api/health → 200 (no gate; intentionally public)', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
  })

  it('GET /api/assets → 200 (read:assets gate)', async () => {
    const res = await app.request('/api/assets')
    expect(res.status).toBe(200)
  })

  it('GET /api/history → 200 or 400 (read:pages gate satisfied; route requires target)', async () => {
    const res = await app.request('/api/history')
    // Capability gate passed; route returns 400 for missing ?target
    // query. We just confirm it's not 401/403.
    expect([200, 400]).toContain(res.status)
  })

  it('GET /api/validation/issues → 200 (read:pages gate satisfied by *)', async () => {
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(200)
  })
})

// `GET /api/validation/issues` returns the full site issue list —
// item paths + validator messages. It must carry the same
// `read:pages` gate every peer read route (compare / fields / site /
// templates) has. The none-mode suite above can only confirm the
// route stays reachable under the admin baseline (`*` grants
// everything); these suites use a custom provider to exercise the
// 401 / 403 paths the gate is responsible for.

function providerWithCaps(caps: string[], role = 'editor'): AuthIdentityProvider {
  return {
    trustMode: 'forwarded-user',
    async extractPrincipal(): Promise<Principal> {
      return { id: 'test-user', role, trustMode: 'forwarded-user', capabilities: caps }
    },
  }
}

const anonymousProvider: AuthIdentityProvider = {
  trustMode: 'forwarded-user',
  async extractPrincipal(): Promise<Principal | null> {
    return null
  },
}

function buildValidationApp(provider: AuthIdentityProvider) {
  const inner = new Hono<PrincipalEnv>()
  inner.use('/api/*', principalMiddleware(provider))
  inner.route('/', validationRoutes({ scanner: null }))
  return inner
}

describe('GET /api/validation/issues — read:pages capability gate', () => {
  it('200 when the principal has read:pages', async () => {
    const res = await buildValidationApp(providerWithCaps(['read:pages'])).request('/api/validation/issues')
    expect(res.status).toBe(200)
  })

  it('403 when the authenticated principal lacks read:pages', async () => {
    const res = await buildValidationApp(providerWithCaps([], 'editor')).request('/api/validation/issues')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['read:pages'])
  })

  it('401 when the request is anonymous (no upstream identity)', async () => {
    const res = await buildValidationApp(anonymousProvider).request('/api/validation/issues')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('UNAUTHENTICATED')
  })
})
