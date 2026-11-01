/**
 * The CLI behind each login layer (design-agent-access.md Q14, Q15, Q19,
 * Q23; cut 9): a Cloudflare service token, an Easy Auth principal from the
 * `gz` app registration and an ALB bearer token each name no person on
 * their own, act as the person (edit-only) with a Gazetta token, and can't
 * approve logins. The admin publishes its keys for ALB, lets a signed-in
 * person create a grant to paste behind ALB, and shows a shared Cloudflare
 * service token only to signed-in people.
 */
import { createLocalJWKSet, exportPKCS8, generateKeyPair, type JWTPayload, jwtVerify, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import {
  type AuthIdentityProvider,
  createAzureEasyAuthProvider,
  createCloudflareAccessAuthProvider,
  expandRole,
} from '../src/auth/index.js'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

beforeEach(async () => {
  vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
})
afterEach(() => vi.unstubAllEnvs())

function appWith(authProvider: AuthIdentityProvider) {
  const storage = memoryStorage()
  storage.seed({ 'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }) })
  const local = { storage, type: 'esi' as const, environment: 'local' as const, editable: true, publicStorage: false }
  const manifest: SiteManifest = { name: 'site', targets: { local } }
  return createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([['local', storage]]),
    targetConfigs: { local },
    disableCacheStatsLogger: true,
    authProvider,
  })
}
type App = ReturnType<typeof appWith>

const json = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function problemCode(res: Response): Promise<string> {
  expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
  return ((await res.json()) as { code: string }).code
}

/**
 * Signs in a CLI as the person: starts and redeems with `cli` headers
 * only, approves with `browser` headers. Returns the Gazetta token.
 */
async function signIn(app: App, cli: Record<string, string>, browser: Record<string, string>): Promise<string> {
  const started = await app.request('/api/v1/auth/logins', json({ machine: 'laptop' }, cli))
  expect(started.status).toBe(201)
  const { code, pollSecret } = (await started.json()) as { code: string; pollSecret: string }
  // The CLI's credential can't approve its own code (Q19).
  const byCli = await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST', headers: cli })
  expect(await problemCode(byCli)).toBe('UNAUTHENTICATED')
  expect((await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST', headers: browser })).status).toBe(
    200,
  )
  const redeemed = await app.request(`/api/v1/auth/logins/${code}/redeem`, json({ pollSecret }, cli))
  return ((await redeemed.json()) as { token: string }).token
}

/** The credential alone names nobody; with the token it's the person, edit-only. */
async function expectCliCredentialRules(app: App, cli: Record<string, string>, withToken: Record<string, string>) {
  expect(await problemCode(await app.request('/api/v1/pages', { headers: cli }))).toBe('UNAUTHENTICATED')
  const me = await app.request('/api/v1/me', { headers: withToken })
  expect(((await me.json()) as { id: string }).id).toBe('alice')
  expect((await app.request('/api/v1/pages', { headers: withToken })).status).toBe(200)
  const del = await app.request('/api/v1/pages/home', { method: 'DELETE', headers: withToken })
  expect(['ELEVATION_REQUIRED', 'TOKEN_EDIT_ONLY']).toContain(await problemCode(del))
}

describe('Cloudflare Access service tokens', () => {
  async function cloudflare() {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const provider = createCloudflareAccessAuthProvider({
      teamDomain: 'acme',
      jwksFactory: () => async () => publicKey,
    })
    const sign = (claims: JWTPayload) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer('https://acme.cloudflareaccess.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
    return { provider, sign }
  }

  it('a service token alone names nobody; with a Gazetta token it acts as the person', async () => {
    const { provider, sign } = await cloudflare()
    const app = appWith(provider)
    // A service token's JWT, as Cloudflare documents it: empty sub, the client id in common_name.
    const service = { 'Cf-Access-Jwt-Assertion': await sign({ sub: '', common_name: 'abc123.access' }) }
    const browser = { 'Cf-Access-Jwt-Assertion': await sign({ sub: 'alice', email: 'alice@example.com' }) }
    const token = await signIn(app, service, browser)
    await expectCliCredentialRules(app, service, { ...service, 'Gazetta-Token': token })
  })

  it('shows a configured shared service token only to signed-in people', async () => {
    vi.stubEnv('GAZETTA_CF_ACCESS_CLIENT_ID', 'abc123.access')
    vi.stubEnv('GAZETTA_CF_ACCESS_CLIENT_SECRET', 's3cret')
    const { provider, sign } = await cloudflare()
    const app = appWith(provider)
    const browser = { 'Cf-Access-Jwt-Assertion': await sign({ sub: 'alice', email: 'alice@example.com' }) }
    const setup = await app.request('/api/v1/auth/cli-setup', { headers: browser })
    expect(await setup.json()).toEqual({
      trustMode: 'cloudflare-access',
      paste: false,
      cloudflare: { clientId: 'abc123.access', clientSecret: 's3cret' },
    })
    const service = { 'Cf-Access-Jwt-Assertion': await sign({ sub: '', common_name: 'abc123.access' }) }
    expect(await problemCode(await app.request('/api/v1/auth/cli-setup', { headers: service }))).toBe('UNAUTHENTICATED')
  })
})

describe('Azure Easy Auth through the gz app registration', () => {
  const principal = (claims: Array<{ typ: string; val: string }>) => ({
    'X-MS-CLIENT-PRINCIPAL': Buffer.from(JSON.stringify({ auth_typ: 'aad', claims })).toString('base64'),
    'X-MS-CLIENT-PRINCIPAL-ID': 'alice',
  })
  const person = { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', val: 'alice' }

  it.each([
    ['azp (v2.0 tokens)', 'azp'],
    ['appid (v1.0 tokens)', 'appid'],
    ['a renamed claim', 'http://schemas.microsoft.com/identity/claims/appid'],
  ])('a principal from the gz app names nobody, read from %s', async (_name, typ) => {
    const app = appWith(createAzureEasyAuthProvider({ cliClientId: 'gz-app-id' }))
    const cli = principal([person, { typ, val: 'gz-app-id' }])
    const browser = principal([person, { typ, val: 'admin-app-id' }])
    const token = await signIn(app, cli, browser)
    await expectCliCredentialRules(app, cli, { ...cli, 'Gazetta-Token': token })
  })

  it('without cliClientId, every principal is the person, as before', async () => {
    const app = appWith(createAzureEasyAuthProvider())
    const res = await app.request('/api/v1/me', { headers: principal([person, { typ: 'azp', val: 'gz-app-id' }]) })
    expect(((await res.json()) as { id: string }).id).toBe('alice')
  })
})

describe('ALB: bearer tokens, the JWKS and pasted grants', () => {
  /** An aws-cognito admin whose browser person comes from a test header. */
  const alb: AuthIdentityProvider = {
    trustMode: 'aws-cognito',
    async extractPrincipal(req) {
      const id = req.headers.get('x-test-person')
      return id ? { id, role: 'editor', trustMode: 'aws-cognito', capabilities: expandRole('editor') ?? [] } : null
    },
  }
  const browser = { 'X-Test-Person': 'alice' }

  async function pasted(app: App): Promise<string> {
    const res = await app.request('/api/v1/auth/grants', json({ machine: 'build server' }, browser))
    expect(res.status).toBe(201)
    return ((await res.json()) as { grantSecret: string }).grantSecret
  }

  it('a pasted grant renews tokens that work in Authorization: Bearer, edit-only', async () => {
    const app = appWith(alb)
    const renewed = await app.request('/api/v1/auth/tokens', json({ grantSecret: await pasted(app) }, {}))
    const { token } = (await renewed.json()) as { token: string }
    await expectCliCredentialRules(app, {}, { Authorization: `Bearer ${token}` })
  })

  it('a bearer token can neither approve codes nor create grants (Q19)', async () => {
    const app = appWith(alb)
    const renewed = await app.request('/api/v1/auth/tokens', json({ grantSecret: await pasted(app) }, {}))
    const bearer = { Authorization: `Bearer ${((await renewed.json()) as { token: string }).token}` }
    expect(await problemCode(await app.request('/api/v1/auth/grants', json({ machine: 'x' }, bearer)))).toBe(
      'BROWSER_REQUIRED',
    )
    const { code } = (await (await app.request('/api/v1/auth/logins', json({ machine: 'x' }, {}))).json()) as {
      code: string
    }
    const approve = await app.request(`/api/v1/auth/logins/${code}/approve`, { method: 'POST', headers: bearer })
    expect(await problemCode(approve)).toBe('BROWSER_REQUIRED')
  })

  it('pasting is for ALB only; elsewhere the code is approved instead', async () => {
    const app = appWith({ ...alb, trustMode: 'forwarded-user' })
    expect(await problemCode(await app.request('/api/v1/auth/grants', json({ machine: 'x' }, browser)))).toBe(
      'FORBIDDEN',
    )
    expect(await (await app.request('/api/v1/auth/cli-setup', { headers: browser })).json()).toEqual({
      trustMode: 'forwarded-user',
      paste: false,
    })
  })

  it('outside aws-cognito, Authorization: Bearer is not a Gazetta token', async () => {
    const app = appWith({ ...alb, trustMode: 'forwarded-user' })
    const grantRes = await appWith(alb).request('/api/v1/auth/grants', json({ machine: 'x' }, browser))
    expect(grantRes.status).toBe(201)
    expect(
      await problemCode(await app.request('/api/v1/pages', { headers: { Authorization: 'Bearer anything' } })),
    ).toBe('UNAUTHENTICATED')
  })

  it('refuses to start with the legacy GAZETTA_TOKEN guard, which also reads Authorization', () => {
    vi.stubEnv('GAZETTA_TOKEN', 'legacy')
    expect(() => appWith(alb)).toThrow(/GAZETTA_TOKEN can't be used with trust: 'aws-cognito'/)
  })

  it('publishes both keys during rotation, and they verify tokens signed with either', async () => {
    const current = await generateSigningKeys()
    const previous = await generateSigningKeys()
    vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8(current.current.privateKey))
    vi.stubEnv('GAZETTA_SIGNING_KEY_PREVIOUS', await exportPKCS8(previous.current.privateKey))
    const app = appWith(alb)

    const res = await app.request('/api/v1/auth/keys')
    expect(res.status).toBe(200)
    const jwks = (await res.json()) as { keys: Array<{ kid: string; kty: string; alg: string; n: string }> }
    expect(jwks.keys.map(k => k.kid)).toEqual([current.current.kid, previous.current.kid])
    expect(jwks.keys.every(k => k.kty === 'RSA' && k.alg === 'RS256' && !('d' in k))).toBe(true)
    // RSA-2048, as ALB requires.
    expect(Buffer.from(jwks.keys[0].n, 'base64url').length).toBe(256)

    const keySet = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0])
    const issued = await app.request('/api/v1/auth/tokens', json({ grantSecret: await pasted(app) }, {}))
    const { token } = (await issued.json()) as { token: string }
    const { payload, protectedHeader } = await jwtVerify(token, keySet)
    expect(protectedHeader).toMatchObject({ alg: 'RS256', kid: current.current.kid })
    expect(payload).toMatchObject({ sub: 'alice' })
    expect(typeof payload.iss).toBe('string')
    expect(typeof payload.exp).toBe('number')

    const old = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: previous.current.kid })
      .setExpirationTime('5m')
      .sign(previous.current.privateKey)
    await expect(jwtVerify(old, keySet)).resolves.toBeTruthy()
  })
})
