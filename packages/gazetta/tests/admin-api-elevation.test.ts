/**
 * Elevations (design-agent-access.md Q12, Q17, Q18, Q19, Q21, #1693): a
 * token asks to publish, delete or restore for a short time; the person
 * approves in the browser; the window covers one scope, is fixed, ends on
 * request or with the grant, and is checked on every withheld request.
 */
import { exportPKCS8 } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const admin: SiteManifest['admin'] = {
  auth: {
    trust: 'forwarded-user',
    allowAnyOrigin: true,
    roleMapping: { claim: 'groups', map: { admins: 'admin', viewers: 'viewer' }, defaultRole: 'editor' },
  },
}

beforeEach(async () => {
  vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function appOn(storage = memoryStorage(), elevationMinutes?: number) {
  storage.seed({ 'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }) })
  const staging = memoryStorage()
  const production = memoryStorage()
  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true, publicStorage: false },
    staging: { storage: staging, type: 'esi' as const, environment: 'staging' as const, publicStorage: false },
    production: { storage: production, type: 'esi' as const, environment: 'production' as const, publicStorage: false },
  }
  const auth = { ...admin!.auth, ...(elevationMinutes ? { elevationMinutes } : {}) }
  const manifest: SiteManifest = { name: 'test-site', targets: targetConfigs, admin: { auth } }
  return createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([
      ['local', storage],
      ['staging', staging],
      ['production', production],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
}

type App = ReturnType<typeof appOn>
const as = (user: string, groups = '') => ({
  'X-Forwarded-User': user,
  ...(groups ? { 'X-Forwarded-Groups': groups } : {}),
})
const alice = as('alice', 'admins')
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const code = async (res: Response) => {
  expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
  return ((await res.json()) as { code: string }).code
}

/** Sign Alice's CLI in; returns her token headers. */
async function signIn(app: App, person = alice) {
  const start = (await (await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }))).json()) as {
    code: string
    pollSecret: string
  }
  expect(
    (await app.request(`/api/v1/auth/logins/${start.code}/approve`, { method: 'POST', headers: person })).status,
  ).toBe(200)
  const r = (await (
    await app.request(`/api/v1/auth/logins/${start.code}/redeem`, post({ pollSecret: start.pollSecret }))
  ).json()) as {
    token: string
    grantId: string
    grantSecret: string
  }
  return { token: { 'Gazetta-Token': r.token }, grantId: r.grantId, grantSecret: r.grantSecret }
}

async function startElevation(app: App, token: Record<string, string>, scope: 'non-production' | 'production') {
  const res = await app.request('/api/v1/auth/elevations', post({ scope }, token))
  expect(res.status).toBe(201)
  return (await res.json()) as { code: string; pollSecret: string; approveUrl: string }
}

async function elevate(
  app: App,
  token: Record<string, string>,
  scope: 'non-production' | 'production',
  person = alice,
) {
  const e = await startElevation(app, token, scope)
  const approved = await app.request(`/api/v1/auth/logins/${e.code}/approve`, { method: 'POST', headers: person })
  expect(approved.status).toBe(200)
  return { ...e, ...((await approved.json()) as { elevationId: string; endsAt: string }) }
}

const publishTo = (app: App, token: Record<string, string>, target: string) =>
  app.request('/api/v1/publish', post({ items: ['pages/home'], targets: [target] }, token))

describe('an elevation', () => {
  it('lets the token publish in its scope and not outside it', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    expect(await code(await publishTo(app, token, 'staging'))).toBe('ELEVATION_REQUIRED')

    const e = await elevate(app, token, 'non-production')
    const polled = await app.request(`/api/v1/auth/logins/${e.code}/redeem`, post({ pollSecret: e.pollSecret }))
    expect(await polled.json()).toEqual({ status: 'elevated', elevationId: e.elevationId, endsAt: e.endsAt })

    expect((await publishTo(app, token, 'staging')).status).not.toBe(403)
    const prod = await publishTo(app, token, 'production')
    expect(prod.status).toBe(403)
    expect(await code(prod)).toBe('ELEVATION_REQUIRED')

    await elevate(app, token, 'production')
    expect((await publishTo(app, token, 'production')).status).not.toBe(403)
  })

  it('shows on the approve page as an elevation', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    const e = await startElevation(app, token, 'production')
    const details = await app.request(`/api/v1/auth/logins/${e.code}`, { headers: alice })
    expect(await details.json()).toMatchObject({
      kind: 'elevation',
      scope: 'production',
      machine: 'laptop',
      state: 'pending',
    })
  })

  it('ends after its window, without being extended by use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const app = appOn(memoryStorage(), 5)
    const { token } = await signIn(app)
    const e = await elevate(app, token, 'non-production')
    vi.setSystemTime(Date.now() + 4 * 60_000)
    expect((await publishTo(app, token, 'staging')).status).not.toBe(403)
    vi.setSystemTime(Date.parse(e.endsAt) + 1000)
    expect(await code(await publishTo(app, token, 'staging'))).toBe('ELEVATION_REQUIRED')
  })

  it('ends at once when the token holder ends it, also on another instance', async () => {
    const storage = memoryStorage()
    const a = appOn(storage)
    const b = appOn(storage)
    const { token } = await signIn(a)
    const e = await elevate(a, token, 'non-production')
    expect(
      (await b.request(`/api/v1/auth/elevations/${e.elevationId}`, { method: 'DELETE', headers: token })).status,
    ).toBe(204)
    expect(await code(await publishTo(a, token, 'staging'))).toBe('ELEVATION_REQUIRED')
  })

  it('ends when the person ends it in the browser, and only they or the token holder can', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    const e = await elevate(app, token, 'non-production')
    expect(
      (await app.request(`/api/v1/auth/elevations/${e.elevationId}`, { method: 'DELETE', headers: as('bob') })).status,
    ).toBe(404)
    expect(
      (await app.request(`/api/v1/auth/elevations/${e.elevationId}`, { method: 'DELETE', headers: alice })).status,
    ).toBe(204)
    expect(await code(await publishTo(app, token, 'staging'))).toBe('ELEVATION_REQUIRED')
    // The approve page, reloaded, no longer shows a running window.
    const details = (await (await app.request(`/api/v1/auth/logins/${e.code}`, { headers: alice })).json()) as {
      state: string
      endsAt?: string
    }
    expect(details.state).toBe('approved')
    expect(details.endsAt).toBeUndefined()
  })

  it('ends when the grant is revoked', async () => {
    const app = appOn()
    const { token, grantId } = await signIn(app)
    await elevate(app, token, 'non-production')
    expect((await app.request(`/api/v1/auth/grants/${grantId}`, { method: 'DELETE', headers: alice })).status).toBe(204)
    expect(await code(await publishTo(app, token, 'staging'))).toBe('ELEVATION_REQUIRED')
  })

  it('answers denied when the person denies', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    const e = await startElevation(app, token, 'non-production')
    await app.request(`/api/v1/auth/logins/${e.code}/deny`, { method: 'POST', headers: alice })
    expect(
      await code(await app.request(`/api/v1/auth/logins/${e.code}/redeem`, post({ pollSecret: e.pollSecret }))),
    ).toBe('LOGIN_DENIED')
    expect(await code(await publishTo(app, token, 'staging'))).toBe('ELEVATION_REQUIRED')
  })
})

describe('without an elevation', () => {
  const withheld: Array<[string, string, RequestInit]> = [
    ['publish', '/api/v1/publish', post({ items: ['pages/home'], targets: ['staging'] })],
    ['delete', '/api/v1/pages/home', { method: 'DELETE' }],
    ['purge', '/api/v1/pages/home/purge', { method: 'DELETE' }],
    ['restore', '/api/v1/history/restore?target=local', post({ revisionId: 'rev-1' })],
  ]

  it.each(withheld)('%s: ELEVATION_REQUIRED for an admin’s token', async (_n, path, init) => {
    const app = appOn()
    const { token } = await signIn(app)
    const res = await app.request(path, { ...init, headers: { ...(init.headers ?? {}), ...token } })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('ELEVATION_REQUIRED')
  })

  it('TOKEN_EDIT_ONLY, not a way to elevate, when the person’s role lacks the capability', async () => {
    const app = appOn()
    const { token } = await signIn(app, as('bob'))
    const res = await app.request('/api/v1/pages/home', { method: 'DELETE', headers: token })
    expect(await code(res)).toBe('TOKEN_EDIT_ONLY')
  })
})

describe('the approve page, for an elevation', () => {
  it('refuses a token', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    const e = await startElevation(app, token, 'non-production')
    expect(
      await code(await app.request(`/api/v1/auth/logins/${e.code}/approve`, { method: 'POST', headers: token })),
    ).toBe('BROWSER_REQUIRED')
  })

  it('refuses a different person', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    const e = await startElevation(app, token, 'non-production')
    const res = await app.request(`/api/v1/auth/logins/${e.code}/approve`, {
      method: 'POST',
      headers: as('bob', 'admins'),
    })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('FORBIDDEN')
  })

  it('refuses a person who lost the capability since the login', async () => {
    const app = appOn()
    const { token } = await signIn(app)
    const e = await startElevation(app, token, 'non-production')
    const res = await app.request(`/api/v1/auth/logins/${e.code}/approve`, {
      method: 'POST',
      headers: as('alice', 'viewers'),
    })
    expect(res.status).toBe(403)
    expect(await code(await publishTo(app, token, 'staging'))).toBe('ELEVATION_REQUIRED')
  })

  it('approves a code once across two instances', async () => {
    const storage = memoryStorage()
    const a = appOn(storage)
    const b = appOn(storage)
    const { token } = await signIn(a)
    const e = await startElevation(a, token, 'non-production')
    const statuses = (
      await Promise.all([
        a.request(`/api/v1/auth/logins/${e.code}/approve`, { method: 'POST', headers: alice }),
        b.request(`/api/v1/auth/logins/${e.code}/approve`, { method: 'POST', headers: alice }),
      ])
    ).map(r => r.status)
    expect(statuses.sort()).toEqual([200, 409])
  })

  it('needs a token to start one', async () => {
    const app = appOn()
    expect(await code(await app.request('/api/v1/auth/elevations', post({ scope: 'production' }, alice)))).toBe(
      'TOKEN_REQUIRED',
    )
  })
})

describe('grants last 30 days', () => {
  it('a grant past 30 days renews no token, and its elevations end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const app = appOn(memoryStorage(), 60 * 24 * 60)
    const { token, grantSecret } = await signIn(app)
    const e = await elevate(app, token, 'non-production')
    expect(Date.parse(e.endsAt)).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60_000)
    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60_000 + 1000)
    expect(await code(await app.request('/api/v1/auth/tokens', post({ grantSecret })))).toBe('GRANT_EXPIRED')
  })
})
