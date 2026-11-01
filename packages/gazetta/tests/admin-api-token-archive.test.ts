/**
 * A Gazetta token archives, and renames while dropping the redirect,
 * without an elevation when its person may delete (design-agent-access.md
 * Q32, #1706): both need `archive:*`, which anyone holding the matching
 * `delete:*` holds, and tokens aren't refused it. Purge and delete still
 * need an elevation; a person who can't delete gets the usual refusal.
 */
import { exportPKCS8 } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { capabilityGrants, expandRole } from '../src/auth/index.js'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

beforeEach(async () => {
  vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
})
afterEach(() => vi.unstubAllEnvs())

const auth = {
  trust: 'forwarded-user' as const,
  allowAnyOrigin: true,
  roleMapping: { claim: 'groups', map: { admins: 'admin' }, defaultRole: 'editor' },
}
const admin = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'admins' }
const editor = { 'X-Forwarded-User': 'bob' }

function appOn() {
  const storage = memoryStorage()
  const page = (title: string) => JSON.stringify({ template: 'page-default', content: { title } })
  storage.seed({
    'pages/home/page.json': page('Home'),
    'pages/about/page.json': page('About'),
    'pages/old/page.json': page('Old'),
  })
  const local = { storage, type: 'esi' as const, environment: 'local' as const, editable: true, publicStorage: false }
  const manifest: SiteManifest = { name: 'site', targets: { local }, admin: { auth } }
  return createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([['local', storage]]),
    targetConfigs: { local },
    disableCacheStatsLogger: true,
  })
}
type App = ReturnType<typeof appOn>

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function tokenFor(app: App, person: Record<string, string>) {
  const s = (await (await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }))).json()) as {
    code: string
    pollSecret: string
  }
  expect((await app.request(`/api/v1/auth/logins/${s.code}/approve`, { method: 'POST', headers: person })).status).toBe(
    200,
  )
  const r = (await (
    await app.request(`/api/v1/auth/logins/${s.code}/redeem`, post({ pollSecret: s.pollSecret }))
  ).json()) as {
    token: string
  }
  return { 'Gazetta-Token': r.token }
}

async function problemCode(res: Response) {
  expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
  return ((await res.json()) as { code: string }).code
}

describe('archive:* comes with delete:*', () => {
  it.each([
    [['delete:pages'], 'archive:pages', true],
    [['delete:*'], 'archive:fragments', true],
    [['*'], 'archive:pages', true],
    [['delete:fragments'], 'archive:pages', false],
    [['edit:*', 'read:*'], 'archive:pages', false],
    [expandRole('editor') ?? [], 'archive:pages', false],
  ])('%j grants %s: %s', (granted, required, expected) => {
    expect(capabilityGrants(granted, required)).toBe(expected)
  })
})

describe('a token whose person may delete', () => {
  it('archives a page without an elevation', async () => {
    const app = appOn()
    const token = await tokenFor(app, admin)
    const res = await app.request('/api/v1/pages/home/archive', post({}, token))
    expect(res.status).toBe(200)
  })

  it('renames dropping the redirect without an elevation', async () => {
    const app = appOn()
    const token = await tokenFor(app, admin)
    const res = await app.request('/api/v1/pages/old/rename', post({ to: 'new', keepAlias: false }, token))
    expect(res.status).toBe(200)
  })

  it('still needs an elevation to purge or delete', async () => {
    const app = appOn()
    const token = await tokenFor(app, admin)
    expect((await app.request('/api/v1/pages/about/archive', post({}, admin))).status).toBe(200)
    const purge = await app.request('/api/v1/pages/about/purge', { method: 'DELETE', headers: token })
    expect(await problemCode(purge)).toBe('ELEVATION_REQUIRED')
    const del = await app.request('/api/v1/pages/home', { method: 'DELETE', headers: token })
    expect(await problemCode(del)).toBe('ELEVATION_REQUIRED')
  })
})

describe('a token whose person may not delete', () => {
  it('is refused archive and a redirect-dropping rename with the usual refusal, not an elevation request', async () => {
    const app = appOn()
    const token = await tokenFor(app, editor)
    const archive = await app.request('/api/v1/pages/home/archive', post({}, token))
    expect(archive.status).toBe(403)
    expect(await problemCode(archive)).toBe('FORBIDDEN')
    const rename = await app.request('/api/v1/pages/old/rename', post({ to: 'new', keepAlias: false }, token))
    expect(rename.status).toBe(403)
    expect(await problemCode(rename)).not.toBe('ELEVATION_REQUIRED')
  })
})

describe('the browser', () => {
  it('archives with delete:* as before, and an editor still cannot', async () => {
    const app = appOn()
    expect((await app.request('/api/v1/pages/home/archive', post({}, admin))).status).toBe(200)
    const refused = await app.request('/api/v1/pages/about/archive', post({}, editor))
    expect(refused.status).toBe(403)
    expect(await problemCode(refused)).toBe('FORBIDDEN')
  })
})
