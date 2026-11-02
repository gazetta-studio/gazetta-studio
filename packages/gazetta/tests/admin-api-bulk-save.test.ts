/**
 * `POST /api/v1/saves` (design-agent-access.md Q46, cut 10, #1714): an
 * agent run's saves, all or nothing, as one history revision.
 */
import { exportPKCS8 } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { BULK_SAVE_MAX_ITEMS } from '../src/admin-api/routes/saves.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createRunIndex } from '../src/history-runs.js'
import { HookCancellation, HookRegistry } from '../src/hooks/index.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

beforeEach(async () => {
  vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
})
afterEach(() => vi.unstubAllEnvs())

const alice = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'admins' }
const hero = (title: string) => ({ name: 'hero', template: 'hero', content: { title } })
const page = (title: string) => ({ template: 'page-default', content: {}, components: [hero(title)] })

function setup(opts: { hooks?: HookRegistry; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const local = opts.storage ?? memoryStorage()
  local.seed({
    'pages/home/page.json': JSON.stringify(page('Home')),
    'pages/about/page.json': JSON.stringify(page('About')),
    'pages/contact/page.json': JSON.stringify(page('Contact')),
  })
  const targetConfigs = {
    local: {
      storage: local,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
      publicStorage: false,
    },
  }
  const auth = {
    trust: 'forwarded-user' as const,
    allowAnyOrigin: true,
    roleMapping: { claim: 'groups', map: { admins: 'admin' }, defaultRole: 'editor' },
  }
  const manifest: SiteManifest = {
    name: 'site',
    locales: { default: 'en', supported: ['en', 'fr'] },
    targets: targetConfigs,
    admin: { auth },
  }
  const app = createAdminApp({
    source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([['local', local]]),
    targetConfigs,
    hooks: opts.hooks,
    disableCacheStatsLogger: true,
  })
  return { app, local }
}
type App = ReturnType<typeof setup>['app']

const post = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function signIn(app: App): Promise<Record<string, string>> {
  const s = (await (await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }, {}))).json()) as {
    code: string
    pollSecret: string
  }
  await app.request(`/api/v1/auth/logins/${s.code}/approve`, { method: 'POST', headers: alice })
  const r = (await (
    await app.request(`/api/v1/auth/logins/${s.code}/redeem`, post({ pollSecret: s.pollSecret }, {}))
  ).json()) as {
    token: string
  }
  return { 'Gazetta-Token': r.token }
}

async function etagOf(app: App, path: string): Promise<string> {
  const res = await app.request(path, { headers: alice })
  return res.headers.get('ETag')!.replace(/"/g, '')
}

const run = (who: Record<string, string> = alice) => ({ ...who, 'Gazetta-Run': 'r1' })
const saves = (app: App, items: unknown[], headers: Record<string, string> = run()) =>
  app.request('/api/v1/saves', post({ items }, headers))

async function threeEdits(app: App) {
  return Promise.all(
    ['home', 'about', 'contact'].map(async name => ({
      kind: 'page',
      name,
      manifest: page(`${name} edited`),
      ifMatch: await etagOf(app, `/api/v1/pages/${name}`),
    })),
  )
}

const titleOf = async (storage: StorageProvider, name: string) =>
  (JSON.parse(await storage.readFile(`pages/${name}/page.json`)) as ReturnType<typeof page>).components[0]!.content
    .title

type Refused = {
  code: string
  items: Array<{ index: number; name: string; code: string; issues?: Array<{ message: string; contentPath?: string }> }>
}

describe('POST /api/v1/saves', () => {
  it('writes every item, as one revision in the run, and answers each save-version', async () => {
    const { app, local } = setup()
    const items = await threeEdits(app)
    const res = await saves(app, items)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revision: string; items: Array<{ name: string; etag: string }> }
    expect(body.items.map(i => i.name)).toEqual(['home', 'about', 'contact'])
    for (const name of ['home', 'about', 'contact']) expect(await titleOf(local, name)).toBe(`${name} edited`)
    expect(body.items[0]!.etag).toBe(await etagOf(app, '/api/v1/pages/home'))

    const [newest, ...older] = await createHistoryProvider({ storage: local }).listRevisions()
    expect(newest).toMatchObject({ id: body.revision, runId: 'r1', channel: 'browser', author: 'alice' })
    expect(newest!.items).toEqual(['pages/about/page.json', 'pages/contact/page.json', 'pages/home/page.json'])
    expect(older.map(r => r.message)).toEqual(['Initial baseline'])
    expect(await createRunIndex(local, '.gazetta/history').listItems('r1')).toEqual([
      'pages.about',
      'pages.contact',
      'pages.home',
    ])
  })

  it('one stale ifMatch refuses the batch, naming the item, and writes nothing', async () => {
    const { app, local } = setup()
    const items = await threeEdits(app)
    items[1]!.ifMatch = 'stale'
    const res = await saves(app, items)
    expect(res.status).toBe(409)
    const body = (await res.json()) as Refused
    expect(body.code).toBe('BATCH_REFUSED')
    expect(body.items).toMatchObject([{ index: 1, name: 'about', code: 'STALE' }])
    for (const name of ['home', 'about', 'contact'])
      expect(await titleOf(local, name)).toBe(name[0]!.toUpperCase() + name.slice(1))
    expect(await createHistoryProvider({ storage: local }).listRevisions()).toEqual([])
  })

  it('one item failing the schema check refuses the batch, naming the field', async () => {
    const { app, local } = setup()
    const items = await threeEdits(app)
    items[2]!.manifest = { ...page(''), components: [{ name: 'hero', template: 'hero', content: {} }] }
    const res = await saves(app, items)
    expect(res.status).toBe(409)
    const [failure] = ((await res.json()) as Refused).items
    expect(failure).toMatchObject({ index: 2, name: 'contact', code: 'VALIDATION_FAILED' })
    expect(failure!.issues!.find(i => i.contentPath === 'hero')!.message).toMatch(/^title: /)
    expect(await titleOf(local, 'home')).toBe('Home')
  })

  it('a beforeSave hook cancelling one item writes nothing', async () => {
    const hooks = new HookRegistry()
    hooks.register(
      'beforeSave',
      async (scope, payload) => {
        if (scope.name === 'about') throw new HookCancellation({ hookName: 'deny', phase: 'beforeSave', message: 'no' })
        return payload
      },
      { name: 'deny' },
    )
    const { app, local } = setup({ hooks })
    const res = await saves(app, await threeEdits(app))
    expect(res.status).toBe(409)
    expect(((await res.json()) as Refused).items).toMatchObject([{ index: 1, code: 'HOOK_CANCELLED' }])
    expect(await titleOf(local, 'home')).toBe('Home')
  })

  it('creates a fragment and references it from a page in the same batch', async () => {
    const { app, local } = setup()
    const res = await saves(app, [
      {
        kind: 'page',
        name: 'home',
        manifest: { ...page('Home'), components: ['@promo', hero('Home')] },
        ifMatch: await etagOf(app, '/api/v1/pages/home'),
      },
      { kind: 'fragment', name: 'promo', manifest: { template: 'footer-layout', content: {} }, ifNoneMatch: '*' },
    ])
    expect(res.status).toBe(200)
    expect(JSON.parse(await local.readFile('fragments/promo/fragment.json'))).toMatchObject({
      template: 'footer-layout',
    })
  })

  it('a create whose name exists answers LIVE_CONFLICT', async () => {
    const { app } = setup()
    const res = await saves(app, [{ kind: 'page', name: 'about', manifest: page('x'), ifNoneMatch: '*' }])
    expect(res.status).toBe(409)
    expect(((await res.json()) as Refused).items).toMatchObject([{ name: 'about', code: 'LIVE_CONFLICT' }])
  })

  it(`more than ${BULK_SAVE_MAX_ITEMS} items answers 413`, async () => {
    const { app } = setup()
    const items = Array.from({ length: BULK_SAVE_MAX_ITEMS + 1 }, (_, i) => ({
      kind: 'page',
      name: `p${i}`,
      manifest: page('x'),
      ifNoneMatch: '*',
    }))
    const res = await saves(app, items)
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe('BATCH_TOO_LARGE')
  })

  it.each([
    ['without Gazetta-Run', alice],
    ['with an item listed twice', null],
  ])('answers 400 %s', async (_case, headers) => {
    const { app } = setup()
    const items = await threeEdits(app)
    const res = await saves(app, headers ? items : [...items, items[0]], headers ?? run())
    expect(res.status).toBe(400)
  })

  it('through a token, the revision and audit events record the token and the run', async () => {
    const { app, local } = setup()
    const res = await saves(app, await threeEdits(app), run(await signIn(app)))
    expect(res.status).toBe(200)
    const [newest] = await createHistoryProvider({ storage: local }).listRevisions(1)
    expect(newest).toMatchObject({ channel: 'token', runId: 'r1', author: 'alice' })
    const events = [...local.dump()]
      .filter(([k]) => k.startsWith('.gazetta/audit/'))
      .flatMap(([, v]) => Buffer.from(v).toString().split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(e => e.action === 'save')
    expect(events).toHaveLength(3)
    expect(events.every(e => e.channel === 'token' && e.runId === 'r1')).toBe(true)
  })

  it('a storage failure partway answers 500 listing what was written, with a revision for it', async () => {
    const storage = memoryStorage()
    const setupResult = setup({ storage })
    const items = await threeEdits(setupResult.app)
    const writeFile = storage.writeFile.bind(storage)
    storage.writeFile = async (path, content, opts) => {
      if (path === 'pages/about/page.json') throw new Error('disk full')
      return writeFile(path, content, opts)
    }
    const res = await saves(setupResult.app, items)
    expect(res.status).toBe(500)
    const body = (await res.json()) as {
      code: string
      revision: string
      written: Array<{ name: string }>
      unwritten: Array<{ name: string }>
    }
    expect(body.code).toBe('STORAGE_WRITE_FAILED')
    expect(body.written.map(i => i.name)).toEqual(['home'])
    expect(body.unwritten.map(i => i.name)).toEqual(['about', 'contact'])
    const [newest] = await createHistoryProvider({ storage }).listRevisions(1)
    expect(newest).toMatchObject({ id: body.revision, items: ['pages/home/page.json'], runId: 'r1' })
  })

  it('a single save still records one revision', async () => {
    const { app, local } = setup()
    const res = await app.request('/api/v1/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify(page('Once')),
    })
    expect(res.status).toBe(200)
    const revisions = await createHistoryProvider({ storage: local }).listRevisions()
    expect(revisions.map(r => r.items)).toEqual([['pages/home/page.json'], expect.any(Array)])
  })

  it('creates language versions of pages that exist, and refuses one whose page is missing or exists', async () => {
    const { app, local } = setup()
    const fr = (name: string) => ({ kind: 'page', name, locale: 'fr', manifest: page(`${name} fr`), ifNoneMatch: '*' })
    const res = await saves(app, [fr('home'), fr('about')])
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ name: string; locale: string; etag: string }> }
    expect(body.items.map(i => [i.name, i.locale])).toEqual([
      ['home', 'fr'],
      ['about', 'fr'],
    ])
    expect(JSON.parse(await local.readFile('pages/home/page.fr.json'))).toMatchObject({ template: 'page-default' })
    // The save-version chains: it's what reading the new version answers.
    expect(body.items[0]!.etag).toBe(await etagOf(app, '/api/v1/pages/home?locale=fr'))
    expect(await titleOf(local, 'home')).toBe('Home')

    const again = await saves(app, [fr('home'), fr('missing')])
    expect(again.status).toBe(409)
    expect(((await again.json()) as Refused).items).toMatchObject([
      { name: 'home', code: 'LIVE_CONFLICT' },
      { name: 'missing', code: 'NOT_FOUND' },
    ])
  })

  it('refuses a create with an unsafe name, as a single create does', async () => {
    const { app } = setup()
    const res = await saves(app, [{ kind: 'page', name: '../escape', manifest: page('x'), ifNoneMatch: '*' }])
    expect(res.status).toBe(400)
  })

  it("written items keep their audit events when the revision can't be recorded", async () => {
    const storage = memoryStorage()
    const { app } = setup({ storage })
    const items = await threeEdits(app)
    // Let the baseline through, then fail the batch's revision.
    const writeFile = storage.writeFile.bind(storage)
    let baselineDone = false
    storage.writeFile = async (path, content, opts) => {
      if (path.startsWith('.gazetta/history/revisions/')) {
        if (baselineDone) throw new Error('history unavailable')
        baselineDone = true
      }
      return writeFile(path, content, opts)
    }
    const res = await saves(app, items)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { written: Array<{ name: string }>; unwritten: unknown[]; detail: string }
    expect(body.written.map(i => i.name)).toEqual(['home', 'about', 'contact'])
    expect(body.unwritten).toEqual([])
    expect(body.detail).toContain("history couldn't be recorded")
    const saveEvents = [...storage.dump()]
      .filter(([k]) => k.startsWith('.gazetta/audit/'))
      .flatMap(([, v]) => Buffer.from(v).toString().split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as { action: string; outcome: string })
      .filter(e => e.action === 'save' && e.outcome === 'success')
    expect(saveEvents).toHaveLength(3)
  })
})
