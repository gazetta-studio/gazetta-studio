/**
 * Where a write came from (design-agent-access.md Q22, Q47; cut 5):
 * revisions and audit events record the channel, the agent run from the
 * `Gazetta-Run` header, and for a token its id and whether an elevation
 * covered it, with the person as author. Route handlers never set these;
 * one middleware does.
 */
import { exportPKCS8 } from 'jose'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import { createHistoryProvider } from '../src/history-provider.js'
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
const alice = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'admins' }

function setup() {
  const local = memoryStorage()
  local.seed({ 'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }) })
  const staging = memoryStorage()
  const targetConfigs = {
    local: {
      storage: local,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
      publicStorage: false,
    },
    staging: { storage: staging, type: 'esi' as const, environment: 'staging' as const, publicStorage: false },
  }
  const manifest: SiteManifest = { name: 'site', targets: targetConfigs, admin: { auth } }
  const app = createAdminApp({
    source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([
      ['local', local],
      ['staging', staging],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, local, staging }
}
type App = ReturnType<typeof setup>['app']

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function signIn(app: App) {
  const s = (await (await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }))).json()) as {
    code: string
    pollSecret: string
  }
  await app.request(`/api/v1/auth/logins/${s.code}/approve`, { method: 'POST', headers: alice })
  const r = (await (
    await app.request(`/api/v1/auth/logins/${s.code}/redeem`, post({ pollSecret: s.pollSecret }))
  ).json()) as {
    token: string
  }
  return r.token
}

/** The newest revision on a target, from its history. */
async function newestRevision(storage: StorageProvider) {
  const [rev] = await createHistoryProvider({ storage }).listRevisions(1)
  return rev
}

/** Every audit event in a storage, oldest first. */
function auditEvents(storage: ReturnType<typeof memoryStorage>): Array<Record<string, unknown>> {
  return [...storage.dump()]
    .filter(([k]) => k.startsWith('.gazetta/audit/'))
    .flatMap(([, v]) => Buffer.from(v).toString().split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

const tokenIdOf = (token: string) =>
  (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { jti: string }).jti

describe('the origin of a write', () => {
  it('a token save with Gazetta-Run records channel, run, token and author', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    const res = await app.request('/api/v1/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Gazetta-Token': token, 'Gazetta-Run': 'run-1.a_b' },
      body: JSON.stringify({ content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(200)
    const origin = { channel: 'token', runId: 'run-1.a_b', tokenId: tokenIdOf(token), elevated: false }
    expect(await newestRevision(local)).toMatchObject({ operation: 'save', author: 'alice', ...origin })
    expect(auditEvents(local).find(e => e.action === 'save')).toMatchObject(origin)
  })

  it('a browser save records channel browser and the author, no token or run', async () => {
    const { app, local } = setup()
    const res = await app.request('/api/v1/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({ content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(200)
    const rev = await newestRevision(local)
    expect(rev).toMatchObject({ author: 'alice', channel: 'browser' })
    expect(rev).not.toHaveProperty('tokenId')
    expect(rev).not.toHaveProperty('runId')
    expect(rev).not.toHaveProperty('elevated')
    const event = auditEvents(local).find(e => e.action === 'save')
    expect(event).toMatchObject({ channel: 'browser' })
    expect(event).not.toHaveProperty('tokenId')
  })

  it('an elevated token publish records elevated: true', async () => {
    const { app, local, staging } = setup()
    const token = await signIn(app)
    const e = (await (
      await app.request('/api/v1/auth/elevations', post({ scope: 'non-production' }, { 'Gazetta-Token': token }))
    ).json()) as {
      code: string
    }
    expect(
      (await app.request(`/api/v1/auth/logins/${e.code}/approve`, { method: 'POST', headers: alice })).status,
    ).toBe(200)
    const res = await app.request(
      '/api/v1/publish',
      post({ items: ['pages/home'], targets: ['staging'] }, { 'Gazetta-Token': token, 'Gazetta-Run': 'pub' }),
    )
    expect(res.status).toBe(200)
    expect(await newestRevision(staging)).toMatchObject({
      operation: 'publish',
      channel: 'token',
      runId: 'pub',
      elevated: true,
    })
    expect(auditEvents(local).find(ev => ev.action === 'publish')).toMatchObject({ elevated: true, runId: 'pub' })
  })

  it('an archive (with an elevation: it needs delete:pages) and an asset upload through a token carry the run', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    const headers = { 'Gazetta-Token': token, 'Gazetta-Run': 'r2' }
    const e = (await (
      await app.request('/api/v1/auth/elevations', post({ scope: 'non-production' }, { 'Gazetta-Token': token }))
    ).json()) as { code: string }
    await app.request(`/api/v1/auth/logins/${e.code}/approve`, { method: 'POST', headers: alice })
    expect((await app.request('/api/v1/pages/home/archive', post({}, headers))).status).toBe(200)
    expect(await newestRevision(local)).toMatchObject({ channel: 'token', runId: 'r2', elevated: true })
    expect(auditEvents(local).find(ev => ev.action === 'archive')).toMatchObject({ channel: 'token', runId: 'r2' })

    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer()
    const form = new FormData()
    form.set('file', new File([new Uint8Array(bytes)], 'hero.jpg', { type: 'image/jpeg' }))
    form.set('name', 'hero')
    const up = await app.request('/api/v1/assets', {
      method: 'POST',
      headers: { ...headers, 'Gazetta-Run': 'r3' },
      body: form,
    })
    expect(up.status).toBe(201)
    expect(await newestRevision(local)).toMatchObject({ channel: 'token', runId: 'r3', author: 'alice' })
  })

  it('an undo records its origin and author too', async () => {
    const { app, local } = setup()
    const save = await app.request('/api/v1/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({ content: { title: 'Edited' } }),
    })
    expect(save.status).toBe(200)
    const undo = await app.request('/api/v1/history/undo?target=local', {
      method: 'POST',
      headers: { ...alice, 'Gazetta-Run': 'undo-run' },
    })
    expect(undo.status).toBe(200)
    expect(await newestRevision(local)).toMatchObject({
      operation: 'rollback',
      author: 'alice',
      channel: 'browser',
      runId: 'undo-run',
    })
  })

  it.each(['', 'has space', 'x'.repeat(65), 'semi;colon'])(
    'refuses Gazetta-Run %j with 400 and writes nothing',
    async run => {
      const { app, local } = setup()
      const res = await app.request('/api/v1/pages/home', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...alice, 'Gazetta-Run': run },
        body: JSON.stringify({ content: { title: 'Edited' } }),
      })
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
      expect(await newestRevision(local)).toBeUndefined()
    },
  )

  it('still reads revisions written before these fields existed', async () => {
    const storage = memoryStorage()
    storage.seed({
      '.gazetta/history/revisions/rev-1700000000000.json': JSON.stringify({
        id: 'rev-1700000000000',
        timestamp: '2023-11-14T22:13:20.000Z',
        operation: 'save',
        items: ['pages/home'],
        snapshot: {},
      }),
    })
    const [rev] = await createHistoryProvider({ storage }).listRevisions()
    expect(rev).toEqual({
      id: 'rev-1700000000000',
      timestamp: '2023-11-14T22:13:20.000Z',
      operation: 'save',
      items: ['pages/home'],
    })
  })
})
