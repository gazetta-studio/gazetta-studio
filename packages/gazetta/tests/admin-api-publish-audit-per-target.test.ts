/**
 * A publish records one audit event per destination target, each with its
 * own outcome (design-audit.md, "Recording scope"; #1799): `success` when
 * every item reached the target, `write-failed` with the failed items when
 * any didn't. Both publish routes, the synchronous one and the stream.
 *
 * Two ESI targets, staging and production. Production refuses writes of
 * one fragment's HTML, so that item fails there while the rest publish.
 * Date is frozen, so the two targets' events share a timestamp and
 * `GET /api/v1/audit`'s dedup has to keep them apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

/** A storage whose writes of `refuse(path)` paths throw. */
function refusing(refuse: (path: string) => boolean): MemoryStorage {
  const inner = memoryStorage()
  return {
    ...inner,
    async writeFile(path: string, content: string): Promise<void> {
      if (refuse(path)) throw new Error(`write refused: ${path}`)
      return inner.writeFile(path, content)
    },
  }
}

function build(opts: { strict?: boolean; production?: MemoryStorage } = {}): Hono {
  const sourceStorage = memoryStorage()
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout' }),
  })
  const staging = memoryStorage()
  const production = opts.production ?? memoryStorage()
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
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      ...(opts.strict ? { admin: { audit: { provider: 'history', strict: true } } } : {}),
    },
  })
  return createAdminApp({
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
  })
}

const BODY = { items: ['fragments/header', 'fragments/footer'], targets: ['staging', 'production'] }

const ROUTES = [
  ['POST /api/v1/publish', '/api/v1/publish'],
  ['POST /api/v1/publish/stream', '/api/v1/publish/stream'],
] as const

async function publish(app: Hono, path: string): Promise<void> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(BODY),
  })
  // The synchronous route answers 207 when a target failed.
  expect([200, 207]).toContain(res.status)
  await res.text()
}

interface Recorded {
  outcome: string
  scope: { kind: string; name?: string }
  metadata: { target?: string; items?: string[]; failedItems?: { item: string; reason: string }[] }
}

async function publishEvents(app: Hono): Promise<Recorded[]> {
  const res = await app.request('/api/v1/audit')
  const body = (await res.json()) as { events: Array<Recorded & { action: string }> }
  return body.events.filter(e => e.action === 'publish')
}

/** One line per event, in target order: `target outcome [failed items]`. */
function summary(events: Recorded[]): string[] {
  return events
    .map(
      e => `${e.scope.name} ${e.outcome}${e.metadata.failedItems ? ` ${e.metadata.failedItems.map(f => f.item)}` : ''}`,
    )
    .sort()
}

const footerHtmlRefused = () => refusing(path => path.startsWith('fragments/footer/index'))

// These render through the starter's templates, which can take seconds on a loaded CI runner.
describe('a publish records one audit event per target', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(ROUTES)('%s: two successful targets record two success events', async (_, path) => {
    const app = build()
    await publish(app, path)
    const events = await publishEvents(app)
    expect(summary(events)).toEqual(['production success', 'staging success'])
    for (const e of events) {
      expect(e.scope).toEqual({ kind: 'site', name: e.metadata.target })
      expect(e.metadata.items).toEqual(BODY.items)
    }
  })

  it.each(ROUTES)('%s: a target where an item fails records write-failed, naming the item', async (_, path) => {
    const app = build({ production: footerHtmlRefused() })
    await publish(app, path)
    const events = await publishEvents(app)
    expect(summary(events)).toEqual(['production write-failed fragments/footer', 'staging success'])
    const failed = events.find(e => e.outcome === 'write-failed')!
    expect(failed.metadata.failedItems?.[0].reason).toContain('write refused')
  })

  it.each(ROUTES)('%s: a target that fails as a whole fails every item', async (_, path) => {
    const app = build({ production: refusing(() => true) })
    await publish(app, path)
    expect(summary(await publishEvents(app))).toEqual([
      'production write-failed fragments/header,fragments/footer',
      'staging success',
    ])
  })

  it.each(ROUTES)(
    '%s: strict mode records each target before writing, then write-failed for the one that failed',
    async (_, path) => {
      const app = build({ strict: true, production: footerHtmlRefused() })
      await publish(app, path)
      expect(summary(await publishEvents(app))).toEqual([
        'production success',
        'production write-failed fragments/footer',
        'staging success',
      ])
    },
  )
})
