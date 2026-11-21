/**
 * #1262: write requests refused before a route is matched (the
 * GAZETTA_TOKEN guard's 401 and the identity provider's 401) are
 * recorded as `sign-in` events, within a per-instance allowance
 * (design-audit.md "Recording scope (v1)").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { AuditActionSchema } from '../src/admin-api/schemas/audit.js'
import { createRefusalRecorder, FULL_ROWS_PER_DAY } from '../src/admin-api/refusal-audit.js'
import type { AuditEvent, AuditProvider } from '../src/audit/index.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'
import { fromConnection } from './_helpers/connection.js'

const FROM_PROXY = fromConnection('10.0.0.5')
const FROM_OUTSIDE = fromConnection('203.0.113.9')
const ADMIN = { 'X-Forwarded-User': 'bob', 'X-Forwarded-Groups': 'admins' }

function buildApp(audit?: Record<string, unknown>): Hono {
  const storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', metadata: { title: 'Home' }, components: [] }),
  })
  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      admin: {
        auth: {
          trust: 'forwarded-user',
          trustedProxies: ['10.0.0.0/8'],
          // No defaultRole: a user outside these groups matches no role.
          roleMapping: { claim: 'groups', map: { admins: 'admin', editors: 'editor' } },
        },
        ...(audit ? { audit: { provider: 'history', ...audit } } : {}),
      },
    },
  })
  return createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    disableAuditRetentionPruner: true,
  }) as unknown as Hono
}

async function events(app: Hono, extraHeaders: Record<string, string> = {}): Promise<AuditEvent[]> {
  const res = await app.request('/api/v1/audit?limit=500', { headers: { ...ADMIN, ...extraHeaders } }, FROM_PROXY)
  expect(res.status).toBe(200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

const signIns = (list: AuditEvent[]) => list.filter(e => e.action === 'sign-in')

afterEach(() => {
  vi.useRealTimers()
  delete process.env.GAZETTA_TOKEN
  delete process.env.GAZETTA_AUDIT_ACTOR_SALT
})

describe('sign-in audit events (#1262)', { timeout: 30000 }, () => {
  it('records a write refused for an untrusted proxy, with method, path and check', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_OUTSIDE)
    expect(res.status).toBe(401)

    const rows = signIns(await events(app))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: 'unauthenticated',
      scope: { kind: 'site' },
      actor: { id: 'unknown' },
      metadata: { method: 'DELETE', path: '/api/v1/pages/home', check: 'proxy' },
    })
  })

  it('records nothing for a refused read', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/pages', { headers: ADMIN }, FROM_OUTSIDE)
    expect(res.status).toBe(401)
    expect(signIns(await events(app))).toHaveLength(0)
  })

  it('records nothing for a refused preview render', async () => {
    const app = buildApp()
    const res = await app.request(
      '/preview/home',
      { method: 'POST', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: '{}' },
      FROM_OUTSIDE,
    )
    expect(res.status).toBe(401)
    expect(signIns(await events(app))).toHaveLength(0)
  })

  it('cuts the stored path to 200 characters', async () => {
    const app = buildApp()
    const long = `/api/v1/pages/${'x'.repeat(400)}`
    await app.request(long, { method: 'PUT', headers: ADMIN }, FROM_OUTSIDE)
    const [row] = signIns(await events(app))
    expect((row.metadata as { path: string }).path).toBe(long.slice(0, 200))
  })

  it('records a user matching no role as the actor, with check no-role', async () => {
    const app = buildApp()
    const res = await app.request(
      '/api/v1/pages/home',
      { method: 'DELETE', headers: { 'X-Forwarded-User': 'dave', 'X-Forwarded-Groups': 'interns' } },
      FROM_PROXY,
    )
    expect(res.status).toBe(401)
    const [row] = signIns(await events(app))
    expect(row.actor.id).toBe('dave')
    expect((row.metadata as { check: string }).check).toBe('no-role')
  })

  it('pseudonymizes the no-role actor when actorPseudonym is set', async () => {
    process.env.GAZETTA_AUDIT_ACTOR_SALT = 'salt-for-the-test'
    const app = buildApp({ actorPseudonym: 'sha256' })
    await app.request(
      '/api/v1/pages/home',
      { method: 'DELETE', headers: { 'X-Forwarded-User': 'dave', 'X-Forwarded-Groups': 'interns' } },
      FROM_PROXY,
    )
    const [row] = signIns(await events(app))
    expect(row.actor.id).not.toBe('dave')
    expect(row.actor.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('records a request refused by the GAZETTA_TOKEN guard', async () => {
    process.env.GAZETTA_TOKEN = 'secret-token'
    const app = buildApp()
    const res = await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_PROXY)
    expect(res.status).toBe(401)
    const rows = signIns(await events(app, { Authorization: 'Bearer secret-token' }))
    expect(rows).toHaveLength(1)
    expect(rows[0].metadata).toMatchObject({ method: 'DELETE', check: 'token' })
  })

  it('records the connection address, not a forged X-Forwarded-For, for a refusal from an untrusted peer', async () => {
    const app = buildApp({ recordSourceIp: 'raw' })
    await app.request(
      '/api/v1/pages/home',
      { method: 'DELETE', headers: { ...ADMIN, 'X-Forwarded-For': '198.51.100.77' } },
      FROM_OUTSIDE,
    )
    const [row] = signIns(await events(app))
    expect(row.sourceIp).toBe('203.0.113.9')
  })

  it('records the first refusals of the day in full, then one count row for the hour', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-21T10:15:00Z'))
    const app = buildApp()
    for (let i = 0; i < FULL_ROWS_PER_DAY + 5; i++) {
      await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_OUTSIDE)
    }
    expect(signIns(await events(app))).toHaveLength(FULL_ROWS_PER_DAY)

    // The hour ends: its count row is written.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    const rows = signIns(await events(app))
    expect(rows).toHaveLength(FULL_ROWS_PER_DAY + 1)
    const count = rows.find(r => (r.metadata as Record<string, unknown>).hour !== undefined)
    expect(count).toMatchObject({
      outcome: 'unauthenticated',
      scope: { kind: 'site' },
      actor: { id: 'unknown' },
      metadata: {
        hour: '2026-11-21T10:00:00.000Z',
        token: 0,
        credentials: 0,
        proxy: 5,
        unverifiable: 0,
        'no-role': 0,
        none: 0,
      },
    })

    // An hour with nothing counted writes no row.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(signIns(await events(app))).toHaveLength(FULL_ROWS_PER_DAY + 1)
  })

  it('counts anonymous write refusals from the capability check against the same allowance', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-21T10:15:00Z'))
    const app = buildApp()
    for (let i = 0; i < FULL_ROWS_PER_DAY; i++) {
      await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_OUTSIDE)
    }
    // No credential at all, from the trusted proxy: anonymous principal.
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/api/v1/pages/home', { method: 'DELETE' }, FROM_PROXY)
      expect(res.status).toBe(401)
    }
    const list = await events(app)
    expect(list.filter(e => e.action === 'delete' && e.outcome === 'unauthenticated')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    const count = signIns(await events(app)).find(r => (r.metadata as Record<string, unknown>).hour !== undefined)
    expect((count?.metadata as Record<string, unknown>).none).toBe(3)
  })

  it('keeps a separate allowance for users matching no role', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-21T10:15:00Z'))
    const app = buildApp()
    for (let i = 0; i < FULL_ROWS_PER_DAY + 2; i++) {
      await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_OUTSIDE)
    }
    await app.request(
      '/api/v1/pages/home',
      { method: 'DELETE', headers: { 'X-Forwarded-User': 'dave', 'X-Forwarded-Groups': 'interns' } },
      FROM_PROXY,
    )
    const noRole = signIns(await events(app)).filter(r => (r.metadata as { check?: string }).check === 'no-role')
    expect(noRole).toHaveLength(1)
    expect(noRole[0].actor.id).toBe('dave')
  })

  it('starts a new allowance the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-21T23:30:00Z'))
    const app = buildApp()
    for (let i = 0; i < FULL_ROWS_PER_DAY + 1; i++) {
      await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_OUTSIDE)
    }
    vi.setSystemTime(new Date('2026-11-22T00:05:00Z'))
    await app.request('/api/v1/pages/home', { method: 'DELETE', headers: ADMIN }, FROM_OUTSIDE)
    const full = signIns(await events(app)).filter(r => (r.metadata as { check?: string }).check === 'proxy')
    expect(full).toHaveLength(FULL_ROWS_PER_DAY + 1)
  })

  it('never changes the response when an audit provider fails', async () => {
    const failing: AuditProvider = {
      name: 'failing',
      async record() {
        throw new Error('disk full')
      },
    }
    const recorder = createRefusalRecorder({
      providers: [failing],
      trustMode: 'forwarded-user',
      actorPseudonym: 'none',
      recordSourceIp: 'none',
      recordUserAgent: 'none',
      logFailure: () => {},
    })
    await expect(
      recorder.signIn({ method: 'POST', path: '/api/v1/pages', headers: new Map() }, 'credentials'),
    ).resolves.toBeUndefined()
  })

  it('lists sign-in among the audit actions', () => {
    expect(AuditActionSchema.options).toContain('sign-in')
  })
})
