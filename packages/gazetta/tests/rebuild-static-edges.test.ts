/**
 * Whole-index rebuilds on a static target write the flattened page edges
 * publish writes there (sidecars.md, "Static targets get flattened
 * edges"); ESI and dynamic targets keep direct edges (#1800).
 *
 * Site: page `home` uses `@header`, which uses `@logo`, which uses the
 * asset `brand`. Per rule 26 every test builds fresh memory storage.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { historyRoutes } from '../src/admin-api/routes/history.js'
import { createSourceContext, staticSourceResolver } from '../src/admin-api/source-context.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import type { AuditEnv } from '../src/admin-api/middleware/audit.js'
import type { AuditContext } from '../src/audit/index.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { rebuildAllDepIndices } from '../src/publish-rendered.js'
import { loadSite } from '../src/site-loader.js'
import type { TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const HOME_V1 = JSON.stringify({ route: '/', template: 'page-default', components: ['@header'] })
const HOME_V2 = JSON.stringify({ route: '/', template: 'page-default', components: [] })
const FILES: Record<string, string> = {
  'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', components: ['@logo'] }),
  'fragments/logo/fragment.json': JSON.stringify({ template: 'logo', content: { image: { _asset: 'brand' } } }),
}

async function exists(storage: MemoryStorage, path: string): Promise<boolean> {
  return storage.exists(path)
}

/** Where `home` is indexed: under which fragments and assets. */
async function homeEdges(storage: MemoryStorage) {
  return {
    header: await exists(storage, '.gazetta/fragment-deps/header/pages.home'),
    logo: await exists(storage, '.gazetta/fragment-deps/logo/pages.home'),
    brand: await exists(storage, '.gazetta/asset-refs/brand/pages.home'),
  }
}

/** Mount the history routes over one target `t` of the given type. */
function mount(storage: MemoryStorage, type: 'static' | 'esi') {
  const source = createSourceContext({ storage: memoryStorage(), siteDir: '', projectSiteDir: '/test-project' })
  const app = new Hono<AuditEnv>()
  app.use('/api/*', principalMiddleware())
  app.use('/api/*', async (c, next) => {
    c.set('audit', { strict: false, record: async () => ({ succeeded: 1, failed: 0 }) } as unknown as AuditContext)
    await next()
  })
  const config = { storage, type, publicStorage: false } as TargetConfig
  app.route('/api/v1', historyRoutes(staticSourceResolver(source), new Map([['t', storage]]), { t: config }))
  return app
}

/** A target holding the site, with a later revision that dropped `@header` from home. */
async function seededTarget() {
  const storage = memoryStorage()
  const history = createHistoryProvider({ storage })
  const r1 = await history.recordRevision({
    operation: 'publish',
    items: new Map([...Object.entries(FILES), ['pages/home/page.json', HOME_V1]]),
  })
  await history.recordRevision({ operation: 'publish', items: new Map([['pages/home/page.json', HOME_V2]]) })
  storage.seed({ ...FILES, 'pages/home/page.json': HOME_V2 })
  return { storage, r1 }
}

describe('history restore rebuilds the indices for the target type', () => {
  it.each([
    ['static', { header: true, logo: true, brand: true }],
    ['esi', { header: true, logo: false, brand: false }],
  ] as const)('on a %s target', async (type, expected) => {
    const { storage, r1 } = await seededTarget()
    const res = await mount(storage, type).request(`/api/v1/history/restore?target=t&id=${r1.id}`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await homeEdges(storage)).toEqual(expected)
  })

  it('keeps direct edges for fragments on a static target', async () => {
    const { storage, r1 } = await seededTarget()
    await mount(storage, 'static').request(`/api/v1/history/restore?target=t&id=${r1.id}`, { method: 'POST' })
    expect(await exists(storage, '.gazetta/fragment-deps/logo/fragments.header')).toBe(true)
    expect(await exists(storage, '.gazetta/asset-refs/brand/fragments.logo')).toBe(true)
    expect(await exists(storage, '.gazetta/asset-refs/brand/fragments.header')).toBe(false)
  })
})

describe('rebuildAllDepIndices (reindex)', () => {
  async function siteOn(files: Record<string, string>) {
    const storage = memoryStorage()
    storage.seed(files)
    const site = await loadSite({ contentRoot: createContentRoot(storage, ''), manifest: { name: 'x' } })
    return { storage, site }
  }

  it('flattens page edges and their forward records when asked', async () => {
    const { storage, site } = await siteOn({ ...FILES, 'pages/home/page.json': HOME_V1 })
    await rebuildAllDepIndices(site, storage, '', { flattenStaticPages: true })
    expect(await homeEdges(storage)).toEqual({ header: true, logo: true, brand: true })
    const record = JSON.parse(await storage.readFile('.gazetta/deps-of/fragment-deps/pages.home'))
    expect([...record].sort()).toEqual(['header', 'logo'])
  })

  it('writes direct edges by default', async () => {
    const { storage, site } = await siteOn({ ...FILES, 'pages/home/page.json': HOME_V1 })
    await rebuildAllDepIndices(site, storage, '')
    expect(await homeEdges(storage)).toEqual({ header: true, logo: false, brand: false })
  })

  it('keeps direct edges for an archived page', async () => {
    const archived = JSON.stringify({ route: '/', template: 'page-default', components: ['@header'], archived: true })
    const { storage, site } = await siteOn({ ...FILES, 'pages/home/page.json': archived })
    await rebuildAllDepIndices(site, storage, '', { flattenStaticPages: true })
    expect(await homeEdges(storage)).toEqual({ header: true, logo: false, brand: false })
  })
})
