/**
 * POST /api/v1/publish/stream keeps publishing when the client leaves
 * (#1068). The stream only reports progress; disconnecting stops the
 * reporting, not the work. Every target is published, the audit records
 * each target once and afterPublish hooks fire once per target.
 */
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { HookRegistry } from '../src/hooks/index.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function build(): { app: Hono; staging: MemoryStorage; production: MemoryStorage; fired: string[] } {
  const sourceStorage = memoryStorage()
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
  })
  const staging = memoryStorage()
  const production = memoryStorage()
  const target = (storage: MemoryStorage, environment: 'staging' | 'production') => ({
    storage,
    publicStorage: false,
    type: 'esi' as const,
    environment,
  })
  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: target(staging, 'staging'),
    production: target(production, 'production'),
  }
  const fired: string[] = []
  const hooks = new HookRegistry()
  hooks.register('afterPublish', async t => {
    fired.push(t)
  })
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, MemoryStorage>([
      ['local', sourceStorage],
      ['staging', staging],
      ['production', production],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    hooks,
  })
  return { app, staging, production, fired }
}

const BODY = { items: ['fragments/header'], targets: ['staging', 'production'] }

async function publishEvents(app: Hono): Promise<Array<{ outcome: string; metadata: { target?: string } }>> {
  const res = await app.request('/api/v1/audit')
  const body = (await res.json()) as {
    events: Array<{ action: string; outcome: string; metadata: { target?: string } }>
  }
  return body.events.filter(e => e.action === 'publish')
}

describe('publish stream outlives the connection', { timeout: 30_000 }, () => {
  it('a client that leaves after the first event still gets every target published, audited and hooked', async () => {
    const { app, staging, production, fired } = build()
    const controller = new AbortController()
    const res = await app.request('/api/v1/publish/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    await reader.cancel().catch(() => {})

    await vi.waitFor(
      async () => {
        expect(await staging.exists('fragments/header/fragment.json')).toBe(true)
        expect(await production.exists('fragments/header/fragment.json')).toBe(true)
        expect(fired.sort()).toEqual(['production', 'staging'])
        const events = await publishEvents(app)
        expect(events.map(e => `${e.metadata.target} ${e.outcome}`).sort()).toEqual([
          'production success',
          'staging success',
        ])
      },
      { timeout: 20_000, interval: 50 },
    )
  })

  it('a client that stays connected sees done and the same records', async () => {
    const { app, staging, production, fired } = build()
    const res = await app.request('/api/v1/publish/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    const text = await res.text()
    expect(text).toContain('event: done')
    expect(await staging.exists('fragments/header/fragment.json')).toBe(true)
    expect(await production.exists('fragments/header/fragment.json')).toBe(true)
    expect(fired.sort()).toEqual(['production', 'staging'])
    expect((await publishEvents(app)).length).toBe(2)
  })
})
