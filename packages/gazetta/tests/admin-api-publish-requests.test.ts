/**
 * Publish requests through the publish routes (review workflow cut 12,
 * #1787; design-review-workflow.md lock 5 and "Settled by the plan
 * review" items 3 and 13). A target with `requiresPublishApproval` gets
 * requests instead of a publish: the routes ask for `publish:request`
 * there (not `publish:non-production` or `publish:production`), record
 * `publish-request` events and fire the publish-request hooks, and write
 * nothing to the target. Ungated targets in the same call publish as
 * before.
 */
import { exportPKCS8 } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import { HookRegistry, type ReviewTransition } from '../src/hooks/index.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const editor = { 'X-Forwarded-User': 'alice' }
const viewer = { 'X-Forwarded-User': 'vic', 'X-Forwarded-Groups': 'viewers' }

interface Fixture {
  app: ReturnType<typeof createAdminApp>
  source: MemoryStorage
  staging: MemoryStorage
  production: MemoryStorage
  calls: string[]
}

function build(opts: { cancelRequest?: boolean } = {}): Fixture {
  const source = memoryStorage()
  source.seed({
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      metadata: { title: 'Home' },
      components: [{ name: 'msg', template: 'text-block', content: { body: 'Hi' } }],
    }),
    'pages/home/page.fr.json': JSON.stringify({
      template: 'page-default',
      metadata: { title: 'Accueil' },
      components: [{ name: 'msg', template: 'text-block', content: { body: 'Salut' } }],
    }),
  })
  const staging = memoryStorage()
  const production = memoryStorage()
  // Something already live on production, to show it's left as it was.
  production.seed({ 'index.html': '<p>live</p>' })

  const calls: string[] = []
  const hooks = new HookRegistry()
  hooks.register('beforePublish', async (target, items) => {
    calls.push(`beforePublish:${target}`)
    return items
  })
  hooks.register('afterPublish', async target => {
    calls.push(`afterPublish:${target}`)
  })
  hooks.register('beforePublishRequest', async (t: ReviewTransition) => {
    calls.push(`beforePublishRequest:${t.target}:${t.scope.name}`)
    if (opts.cancelRequest) throw new Error('no requests on Fridays')
    return t
  })
  hooks.register('afterPublishRequest', async (t: ReviewTransition) => {
    calls.push(`afterPublishRequest:${t.target}:${t.scope.name}`)
  })
  hooks.seal()

  const targetConfigs = {
    local: {
      storage: source,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
      publicStorage: false,
    },
    staging: { storage: staging, type: 'esi' as const, environment: 'staging' as const, publicStorage: false },
    production: {
      storage: production,
      type: 'esi' as const,
      environment: 'production' as const,
      publicStorage: false,
      requiresPublishApproval: true,
    },
  }
  const manifest: SiteManifest = {
    name: 'test-site',
    locales: { default: 'en', supported: ['en', 'fr'] },
    targets: targetConfigs,
    admin: {
      auth: {
        trust: 'forwarded-user',
        allowAnyOrigin: true,
        roleMapping: { claim: 'groups', map: { admins: 'admin', viewers: 'viewer' }, defaultRole: 'editor' },
      },
    },
  } as SiteManifest
  const app = createAdminApp({
    source: createSourceContext({ storage: source, siteDir: '', projectSiteDir: '/p', manifest }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([
      ['local', source],
      ['staging', staging],
      ['production', production],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    hooks,
  })
  return { app, source, staging, production, calls }
}

const post = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function auditEvents(source: MemoryStorage): Promise<Array<Record<string, unknown>>> {
  const names = (await source.readDir('.gazetta/audit').catch(() => [])).filter(e => e.name.endsWith('.jsonl'))
  const events: Array<Record<string, unknown>> = []
  for (const { name } of names) {
    for (const line of (await source.readFile(`.gazetta/audit/${name}`)).split('\n')) {
      if (line.trim()) events.push(JSON.parse(line))
    }
  }
  return events
}

const requestFiles = (source: MemoryStorage) =>
  [...source.dump().keys()].filter(k => k.startsWith('.gazetta/publish-requests/production/page/'))

beforeEach(async () => {
  vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('publish requests on a target that requires approval', { timeout: 30000 }, () => {
  it('creates requests for an editor without publish:production, and leaves the target as it was', async () => {
    const f = build()
    const before = new Map(f.production.dump())

    const res = await f.app.request('/api/v1/publish', post({ items: ['pages/home'], targets: ['production'] }, editor))

    expect(res.status).toBe(200)
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ target: 'production', success: true, outcome: 'requested' })
    const requestIds = results[0].requestIds as string[]
    expect(requestIds).toHaveLength(1)
    expect(f.production.dump()).toEqual(before)
    expect(requestFiles(f.source)).toEqual([`.gazetta/publish-requests/production/page/home/${requestIds[0]}.json`])
    const request = JSON.parse(await f.source.readFile(requestFiles(f.source)[0]))
    expect(request).toMatchObject({ requestedBy: 'alice', requiredPublishApprovers: 1, state: 'publish-pending' })
    expect(Object.keys(request.hashes).sort()).toEqual(['pages/home/page.fr.json', 'pages/home/page.json'])
  })

  it('refuses a user without publish:request with 403', async () => {
    const f = build()
    const res = await f.app.request('/api/v1/publish', post({ items: ['pages/home'], targets: ['production'] }, viewer))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'FORBIDDEN', missing: ['publish:request'], role: 'viewer' })
    expect(body.detail).toContain('production requires publish approval')
    expect(requestFiles(f.source)).toEqual([])
  })

  it('publishes staging and requests production in one call', async () => {
    const f = build()
    const res = await f.app.request(
      '/api/v1/publish',
      post({ items: ['pages/home'], targets: ['staging', 'production'] }, editor),
    )
    expect(res.status).toBe(200)
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> }
    const staging = results.find(r => r.target === 'staging')!
    const production = results.find(r => r.target === 'production')!
    expect(staging.outcome).toBeUndefined()
    expect(staging.copiedFiles).toBeGreaterThan(0)
    expect(await f.staging.exists('pages/home/page.json')).toBe(true)
    expect(production).toMatchObject({ outcome: 'requested' })
    expect(await f.production.exists('pages/home/page.json')).toBe(false)
  })

  it('records publish-request events and fires the request hooks, not the publish ones, for the gated target', async () => {
    const f = build()
    const res = await f.app.request(
      '/api/v1/publish',
      post({ items: ['pages/home'], targets: ['staging', 'production'] }, editor),
    )
    const { results } = (await res.json()) as { results: Array<{ target: string; requestIds?: string[] }> }
    const [requestId] = results.find(r => r.target === 'production')!.requestIds!

    expect(f.calls).toContain('beforePublish:staging')
    expect(f.calls).toContain('afterPublish:staging')
    expect(f.calls).not.toContain('beforePublish:production')
    expect(f.calls).not.toContain('afterPublish:production')
    expect(f.calls).toContain('beforePublishRequest:production:home')
    expect(f.calls).toContain('afterPublishRequest:production:home')

    const events = await auditEvents(f.source)
    const requestEvents = events.filter(e => e.action === 'publish-request')
    expect(requestEvents).toHaveLength(1)
    expect(requestEvents[0]).toMatchObject({
      outcome: 'success',
      scope: { kind: 'page', name: 'home' },
      metadata: { targetName: 'production', requestId, item: 'pages/home' },
    })
    const publishTargets = events
      .filter(e => e.action === 'publish')
      .map(e => (e.metadata as { target?: string }).target)
    expect(publishTargets).toEqual(['staging'])
  })

  it('cancels the publish when beforePublishRequest throws, and writes nothing', async () => {
    const f = build({ cancelRequest: true })
    const res = await f.app.request(
      '/api/v1/publish',
      post({ items: ['pages/home'], targets: ['staging', 'production'] }, editor),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('HOOK_CANCELLED')
    expect(requestFiles(f.source)).toEqual([])
    expect(await f.staging.exists('pages/home/page.json')).toBe(false)
    const cancelled = (await auditEvents(f.source)).filter(e => e.action === 'publish-request')
    expect(cancelled).toMatchObject([{ outcome: 'hook-cancelled', metadata: { targetName: 'production' } }])
  })

  it('carries the outcome and request ids in the stream route target-result', async () => {
    const f = build()
    const res = await f.app.request(
      '/api/v1/publish/stream',
      post({ items: ['pages/home'], targets: ['production'] }, editor),
    )
    expect(res.status).toBe(200)
    const frames = (await res.text())
      .split('\n\n')
      .map(block =>
        block
          .split('\n')
          .find(l => l.startsWith('data: '))
          ?.slice('data: '.length),
      )
      .filter((d): d is string => !!d)
      .map(d => JSON.parse(d))
    const result = frames.find(fr => fr.kind === 'target-result')!.result
    expect(result).toMatchObject({ target: 'production', success: true, outcome: 'requested' })
    expect(result.requestIds).toHaveLength(1)
    expect(requestFiles(f.source)).toHaveLength(1)
    expect(f.calls).toContain('afterPublishRequest:production:home')
    expect((await auditEvents(f.source)).filter(e => e.action === 'publish-request')).toHaveLength(1)
  })

  it('lets a token without an elevation create the request', async () => {
    const f = build()
    const admin = { 'X-Forwarded-User': 'bob', 'X-Forwarded-Groups': 'admins' }
    const start = (await (await f.app.request('/api/v1/auth/logins', post({ machine: 'laptop' }, {}))).json()) as {
      code: string
      pollSecret: string
    }
    expect(
      (await f.app.request(`/api/v1/auth/logins/${start.code}/approve`, { method: 'POST', headers: admin })).status,
    ).toBe(200)
    const { token } = (await (
      await f.app.request(`/api/v1/auth/logins/${start.code}/redeem`, post({ pollSecret: start.pollSecret }, {}))
    ).json()) as { token: string }

    const res = await f.app.request(
      '/api/v1/publish',
      post({ items: ['pages/home'], targets: ['production'] }, { 'Gazetta-Token': token }),
    )
    expect(res.status).toBe(200)
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(results[0]).toMatchObject({ target: 'production', outcome: 'requested' })
    expect(JSON.parse(await f.source.readFile(requestFiles(f.source)[0])).requestedBy).toBe('bob')
    expect(await f.production.exists('pages/home/page.json')).toBe(false)
  })
})
