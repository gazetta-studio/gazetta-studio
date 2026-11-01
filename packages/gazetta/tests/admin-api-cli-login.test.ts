/**
 * CLI login and Gazetta tokens over the admin API (design-agent-access.md
 * Q12, Q16, Q19, Q21, Q25, Q26): start, approve in the browser, redeem
 * once, renew, revoke; a token edits but can't publish, delete, purge or
 * restore; no key on a hosted admin turns login off.
 */
import { exportPKCS8 } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import { Hono } from 'hono'
import { noneAuthProvider } from '../src/auth/index.js'
import { createAdminApp } from '../src/admin-api/index.js'
import type { TokenAuth } from '../src/admin-api/middleware/principal.js'
import { mountValidationSse } from '../src/admin-api/routes/validation.js'
import { createTokenAuth } from '../src/admin-api/token-auth.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest, StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

afterEach(() => vi.unstubAllEnvs())

const forwardedUser = { auth: { trust: 'forwarded-user' as const, allowAnyOrigin: true } }

function appOn(
  storage: ReturnType<typeof memoryStorage>,
  opts: { admin?: SiteManifest['admin']; local?: Partial<TargetConfig> } = {},
) {
  storage.seed({ 'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }) })
  const staging = memoryStorage()
  const targetConfigs = {
    local: {
      storage,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
      publicStorage: false,
      ...opts.local,
    },
    staging: { storage: staging, type: 'esi' as const, environment: 'staging' as const, publicStorage: false },
  }
  const manifest: SiteManifest = {
    name: 'test-site',
    targets: targetConfigs,
    ...(opts.admin ? { admin: opts.admin } : {}),
  }
  return createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([
      ['local', storage],
      ['staging', staging],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    ...(opts.tokenAuth ? { tokenAuth: opts.tokenAuth } : {}),
  })
}

type App = ReturnType<typeof appOn>
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const asAlice = { 'X-Forwarded-User': 'alice' }

async function start(app: App) {
  const res = await app.request(
    '/api/v1/auth/logins',
    post({ machine: 'laptop' }, { 'X-Forwarded-For': '203.0.113.7' }),
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { code: string; approveUrl: string; pollSecret: string; expiresAt: string }
}

async function redeem(app: App, code: string, pollSecret: string) {
  return app.request(`/api/v1/auth/logins/${code}/redeem`, post({ pollSecret }))
}

/** A token for the local principal (trust `none`). */
async function tokenOn(app: App): Promise<string> {
  const { code, pollSecret } = await start(app)
  expect((await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST' })).status).toBe(200)
  return ((await (await redeem(app, code, pollSecret)).json()) as { token: string }).token
}

async function problemCode(res: Response) {
  expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
  return ((await res.json()) as { code: string }).code
}

describe('pin login', () => {
  it('starts, shows the approve page details, approves, and redeems once for a working token', async () => {
    vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
    const app = appOn(memoryStorage(), { admin: forwardedUser })
    const { code, approveUrl, pollSecret } = await start(app)
    expect(approveUrl).toBe(`http://localhost/cli-login/${code}`)

    expect(await (await redeem(app, code, pollSecret)).json()).toEqual({ status: 'pending' })

    const details = await app.request(`/api/v1/auth/logins/${code}`, { headers: asAlice })
    expect(await details.json()).toMatchObject({ code, machine: 'laptop', ip: '203.0.113.7', state: 'pending' })

    expect(
      (await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST', headers: asAlice })).status,
    ).toBe(200)
    const redeemed = await redeem(app, code, pollSecret)
    const body = (await redeemed.json()) as { status: string; token: string; grantSecret: string }
    expect(body.status).toBe('approved')

    const me = await app.request('/api/v1/me', { headers: { 'Gazetta-Token': body.token } })
    expect(await me.json()).toEqual({ id: 'alice', role: 'editor', trustMode: 'forwarded-user' })

    expect(await problemCode(await redeem(app, code, pollSecret))).toBe('LOGIN_REDEEMED')
  })

  it('redeems a code once across two admin instances sharing storage', async () => {
    const storage = memoryStorage()
    vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
    const a = appOn(storage)
    const b = appOn(storage)
    const { code, pollSecret } = await start(a)
    await b.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST' })
    const statuses = (await Promise.all([redeem(a, code, pollSecret), redeem(b, code, pollSecret)])).map(r => r.status)
    expect(statuses.sort()).toEqual([200, 409])
  })

  it('answers denied after the person denies, and expired after 10 minutes', async () => {
    const app = appOn(memoryStorage())
    const denied = await start(app)
    await app.request(`/api/v1/auth/logins/${denied.code}/deny`, { method: 'POST' })
    expect(await problemCode(await redeem(app, denied.code, denied.pollSecret))).toBe('LOGIN_DENIED')

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const late = await start(app)
      vi.setSystemTime(Date.now() + 10 * 60 * 1000)
      expect(await problemCode(await app.request(`/api/v1/auth/logins/${late.code}/approve`, { method: 'POST' }))).toBe(
        'LOGIN_EXPIRED',
      )
      expect(await problemCode(await redeem(app, late.code, late.pollSecret))).toBe('LOGIN_EXPIRED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('records approvals and denials in the audit log', async () => {
    const storage = memoryStorage()
    const app = appOn(storage)
    const one = await start(app)
    await app.request(`/api/v1/auth/logins/${one.code}/approve`, { method: 'POST' })
    const two = await start(app)
    await app.request(`/api/v1/auth/logins/${two.code}/deny`, { method: 'POST' })
    const audit = [...storage.dump()]
      .filter(([k]) => k.startsWith('.gazetta/audit/'))
      .map(([, v]) => Buffer.from(v).toString())
      .join('\n')
    expect(audit).toContain('"action":"login-approve"')
    expect(audit).toContain('"action":"login-deny"')
  })
})

describe('the approve page accepts only a browser', () => {
  it('refuses a request with a Gazetta token, and records the refusal', async () => {
    const storage = memoryStorage()
    const app = appOn(storage)
    const token = await tokenOn(app)
    const { code } = await start(app)
    const headers = { 'Gazetta-Token': token }
    expect(await problemCode(await app.request(`/api/v1/auth/logins/${code}`, { headers }))).toBe('BROWSER_REQUIRED')
    const approve = await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST', headers })
    expect(approve.status).toBe(403)
    expect(await problemCode(approve)).toBe('BROWSER_REQUIRED')
    const audit = [...storage.dump()]
      .filter(([k]) => k.startsWith('.gazetta/audit/'))
      .map(([, v]) => Buffer.from(v).toString())
      .join('\n')
    expect(audit).toMatch(/"action":"login-approve","outcome":"forbidden"/)
  })

  it('refuses someone the login layer did not identify', async () => {
    vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
    const app = appOn(memoryStorage(), { admin: forwardedUser })
    const { code } = await start(app)
    const res = await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('refuses a bad token outright instead of falling back to the login layer', async () => {
    const app = appOn(memoryStorage())
    const res = await app.request('/api/v1/me', { headers: { 'Gazetta-Token': 'not-a-token' } })
    expect(res.status).toBe(401)
    expect(await problemCode(res)).toBe('TOKEN_INVALID')
  })
})

describe('a token edits but cannot publish, delete, purge or restore', () => {
  const capped: Array<[string, string, RequestInit]> = [
    ['publish', '/api/v1/publish', post({ items: ['pages/home'], targets: ['staging'] })],
    ['delete', '/api/v1/pages/home', { method: 'DELETE' }],
    ['purge', '/api/v1/pages/home/purge', { method: 'DELETE' }],
    ['undo', '/api/v1/history/undo?target=local', { method: 'POST' }],
    ['rollback/restore', '/api/v1/history/restore?target=local', post({ revisionId: 'rev-1' })],
  ]

  it.each(capped)('%s: 403 TOKEN_EDIT_ONLY with a token; the browser is not refused for it', async (_n, path, init) => {
    const app = appOn(memoryStorage())
    const token = await tokenOn(app)
    const withToken = await app.request(path, { ...init, headers: { ...(init.headers ?? {}), 'Gazetta-Token': token } })
    expect(withToken.status).toBe(403)
    expect(await problemCode(withToken)).toBe('TOKEN_EDIT_ONLY')
    const inBrowser = await app.request(path, init)
    if (inBrowser.status === 403) expect(await problemCode(inBrowser)).not.toBe('TOKEN_EDIT_ONLY')
  })

  it('saves a page with a token', async () => {
    const app = appOn(memoryStorage())
    const token = await tokenOn(app)
    const res = await app.request('/api/v1/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Gazetta-Token': token },
      body: JSON.stringify({ content: { title: 'Edited by a token' } }),
    })
    expect(res.status).toBe(200)
  })
})

describe('a token outside /api/v1', () => {
  it('reads a preview', async () => {
    const app = appOn(memoryStorage())
    const token = await tokenOn(app)
    const res = await app.request('/preview/', { headers: { 'Gazetta-Token': token } })
    expect(res.status).not.toBe(401)
  })

  it('opens the dev server’s /__validation stream when the setup is shared', async () => {
    const storage = memoryStorage()
    const tokenAuth = createTokenAuth({ trustMode: 'none', sourceStorage: storage })
    const app = appOn(storage, { tokenAuth })
    const token = await tokenOn(app)
    const outer = new Hono()
    mountValidationSse(outer, null, noneAuthProvider, tokenAuth)
    const res = await outer.request('/__validation', { headers: { 'Gazetta-Token': token } })
    expect(res.status).toBe(200)
    await res.body?.cancel()
  })
})

describe('grants', () => {
  it('renews a token from the grant secret until the grant is revoked; issued tokens keep working', async () => {
    const app = appOn(memoryStorage())
    const { code, pollSecret } = await start(app)
    await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST' })
    const { grantId, grantSecret, token } = (await (await redeem(app, code, pollSecret)).json()) as {
      grantId: string
      grantSecret: string
      token: string
    }
    expect((await app.request('/api/v1/auth/tokens', post({ grantSecret }))).status).toBe(200)

    expect((await app.request(`/api/v1/auth/grants/${grantId}`, { method: 'DELETE' })).status).toBe(204)
    expect(await problemCode(await app.request('/api/v1/auth/tokens', post({ grantSecret })))).toBe('GRANT_INVALID')
    expect((await app.request('/api/v1/me', { headers: { 'Gazetta-Token': token } })).status).toBe(200)
  })
})

describe('when CLI login is off', () => {
  it('a hosted admin without GAZETTA_SIGNING_KEY starts and answers 503 on login routes', async () => {
    vi.stubEnv('GAZETTA_SIGNING_KEY', '')
    const app = appOn(memoryStorage(), { admin: forwardedUser })
    expect((await app.request('/api/v1/version')).status).not.toBe(503)
    const res = await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }))
    expect(res.status).toBe(503)
    expect(await problemCode(res)).toBe('CLI_LOGIN_UNAVAILABLE')
  })

  it('a source on public storage writes no auth record', async () => {
    const storage = memoryStorage()
    const app = appOn(storage, { local: { publicStorage: true, editable: undefined } })
    expect((await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }))).status).toBe(503)
    expect([...storage.dump().keys()].filter(k => k.startsWith('.gazetta/auth/'))).toEqual([])
  })
})
