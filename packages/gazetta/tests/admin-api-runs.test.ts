/**
 * `GET /api/v1/runs/:runId` and `POST /api/v1/runs/:runId/revert`
 * (design-agent-access.md Q48, Q50, cut 11, #1730): undoing an agent run
 * item by item, through a token.
 */
import { exportPKCS8 } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
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

const alice = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'admins' }
const bob = { 'X-Forwarded-User': 'bob' } // the default role, editor: can't archive
const hero = (title: string) => ({ name: 'hero', template: 'hero', content: { title } })
const page = (title: string, extra: unknown[] = []) => ({
  template: 'page-default',
  content: {},
  components: [hero(title), ...extra],
})

function setup() {
  const local = memoryStorage()
  local.seed({
    'pages/home/page.json': JSON.stringify(page('Home')),
    'pages/home/page.fr.json': JSON.stringify(page('Accueil')),
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
  const manifest: SiteManifest = {
    name: 'site',
    locales: { default: 'en', supported: ['en', 'fr'] },
    targets: targetConfigs,
    admin: {
      auth: {
        trust: 'forwarded-user' as const,
        allowAnyOrigin: true,
        roleMapping: { claim: 'groups', map: { admins: 'admin' }, defaultRole: 'editor' },
      },
    },
  }
  const app = createAdminApp({
    source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([['local', local]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, local }
}
type App = ReturnType<typeof setup>['app']

const send = (method: string, body: unknown, headers: Record<string, string>): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function signIn(app: App, who = alice): Promise<Record<string, string>> {
  const s = (await (await app.request('/api/v1/auth/logins', send('POST', { machine: 'laptop' }, {}))).json()) as {
    code: string
    pollSecret: string
  }
  await app.request(`/api/v1/auth/logins/${s.code}/approve`, { method: 'POST', headers: who })
  const r = (await (
    await app.request(`/api/v1/auth/logins/${s.code}/redeem`, send('POST', { pollSecret: s.pollSecret }, {}))
  ).json()) as { token: string }
  return { 'Gazetta-Token': r.token }
}

async function etagOf(app: App, path: string): Promise<string> {
  return (await app.request(path, { headers: alice })).headers.get('ETag')!.replace(/"/g, '')
}

/** Saves one item in a run, through the token. */
async function save(
  app: App,
  token: Record<string, string>,
  runId: string,
  item: { kind?: 'page' | 'fragment'; name: string; locale?: string; manifest: unknown; create?: boolean },
) {
  const kind = item.kind ?? 'page'
  const path = `/api/v1/${kind}s/${item.name}${item.locale ? `?locale=${item.locale}` : ''}`
  const body = {
    items: [
      {
        kind,
        name: item.name,
        ...(item.locale ? { locale: item.locale } : {}),
        manifest: item.manifest,
        ...(item.create ? { ifNoneMatch: '*' } : { ifMatch: await etagOf(app, path) }),
      },
    ],
  }
  const res = await app.request('/api/v1/saves', send('POST', body, { ...token, 'Gazetta-Run': runId }))
  expect(res.status, await res.clone().text()).toBe(200)
}

/** The run the acceptance cases share: edits home and about, creates promo. */
async function theRun(app: App, token: Record<string, string>) {
  await save(app, token, 'r1', { name: 'home', manifest: { ...page('Home by agent'), metadata: { title: 'Agent' } } })
  await save(app, token, 'r1', { name: 'about', manifest: page('About by agent') })
  await save(app, token, 'r1', { name: 'promo', manifest: page('Promo'), create: true })
}

const revert = (app: App, token: Record<string, string>, body: unknown = {}, runId = 'r1') =>
  app.request(`/api/v1/runs/${runId}/revert`, send('POST', body, token))

type Reverted = {
  runId: string
  revertRun: string
  items: Array<{ item: string; status: string; reason?: string }>
}
const statusOf = (r: Reverted, item: string) => r.items.find(i => i.item === item)

const titleOf = async (storage: StorageProvider, path: string) =>
  (JSON.parse(await storage.readFile(path)) as ReturnType<typeof page>).components[0]!.content.title

describe('reverting a run', () => {
  it('puts edited pages back and archives what it created, as a run of its own', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    await theRun(app, token)

    const shown = await app.request('/api/v1/runs/r1', { headers: token })
    expect(await shown.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ item: 'pages.home', created: false, changed: false, restorable: true }),
        expect.objectContaining({ item: 'pages.promo', created: true }),
      ]),
    })

    const res = await revert(app, token)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as Reverted
    expect(statusOf(body, 'pages.home')?.status).toBe('reverted')
    expect(statusOf(body, 'pages.about')?.status).toBe('reverted')
    expect(statusOf(body, 'pages.promo')?.status).toBe('archived')
    expect(await titleOf(local, 'pages/home/page.json')).toBe('Home')
    // Exactly the stored version: the metadata the run added goes too.
    expect(JSON.parse(await local.readFile('pages/home/page.json')).metadata).toBeUndefined()
    expect(await titleOf(local, 'pages/about/page.json')).toBe('About')
    expect(JSON.parse(await local.readFile('pages/promo/page.json')).archived).toBe(true)

    expect(body.revertRun).toMatch(/^revert-r1-/)
    const [newest] = await createHistoryProvider({ storage: local }).listRevisions(1)
    expect(newest?.runId).toBe(body.revertRun)
    const events = [...local.dump()]
      .filter(([k]) => k.startsWith('.gazetta/audit/'))
      .flatMap(([, v]) => Buffer.from(v).toString().split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as { action: string; runId?: string; metadata?: Record<string, unknown> })
      .filter(e => e.runId === body.revertRun)
    expect(events.map(e => e.action).sort()).toEqual(['archive', 'save', 'save'])
    expect(events.every(e => e.metadata?.revertedRun === 'r1')).toBe(true)

    // The revert is undoable in turn: reverting it brings the agent's edits back.
    const again = (await (await revert(app, token, {}, body.revertRun)).json()) as Reverted
    expect(statusOf(again, 'pages.home')?.status).toBe('reverted')
    expect(await titleOf(local, 'pages/home/page.json')).toBe('Home by agent')
  })

  it('skips an item someone changed since, unless forced', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    await theRun(app, token)
    const ifMatch = await etagOf(app, '/api/v1/pages/about')
    const edit = await app.request(
      '/api/v1/pages/about',
      send('PUT', page('About by alice'), { ...alice, 'If-Match': `"${ifMatch}"` }),
    )
    expect(edit.status, await edit.clone().text()).toBe(200)

    const first = (await (await revert(app, token)).json()) as Reverted
    expect(statusOf(first, 'pages.about')?.status).toBe('skipped-changed')
    expect(await titleOf(local, 'pages/about/page.json')).toBe('About by alice')
    expect(statusOf(first, 'pages.home')?.status).toBe('reverted')

    const forced = (await (await revert(app, token, { force: ['pages.about'] })).json()) as Reverted
    expect(statusOf(forced, 'pages.about')?.status).toBe('reverted')
    expect(await titleOf(local, 'pages/about/page.json')).toBe('About')
  })

  it("skips an item whose version before the run doesn't save any more, and reverts the rest", async () => {
    const { app, local } = setup()
    // home's stored version lacks hero's required title: it no longer saves.
    local.seed({
      'pages/home/page.json': JSON.stringify({
        ...page('x'),
        components: [{ name: 'hero', template: 'hero', content: {} }],
      }),
    })
    const token = await signIn(app)
    await theRun(app, token)
    const body = (await (await revert(app, token)).json()) as Reverted
    expect(statusOf(body, 'pages.home')).toMatchObject({
      status: 'skipped-failed',
      reason: expect.stringContaining('checks'),
    })
    expect(await titleOf(local, 'pages/home/page.json')).toBe('Home by agent')
    expect(statusOf(body, 'pages.about')?.status).toBe('reverted')
  })

  it('skips a created item something else still uses', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    await save(app, token, 'r1', {
      kind: 'fragment',
      name: 'banner',
      manifest: { template: 'hero', content: { title: 'Sale' } },
      create: true,
    })
    // Outside the run, contact starts using the fragment.
    await save(app, token, 'other', { name: 'contact', manifest: page('Contact', ['@banner']) })
    const body = (await (await revert(app, token)).json()) as Reverted
    expect(statusOf(body, 'fragments.banner')).toMatchObject({ status: 'skipped-in-use' })
    expect(JSON.parse(await local.readFile('fragments/banner/fragment.json')).archived).toBeUndefined()
  })

  it("lists created items as skipped for someone who can't archive, and reverts the rest", async () => {
    const { app, local } = setup()
    const token = await signIn(app, bob)
    await theRun(app, token)
    const body = (await (await revert(app, token)).json()) as Reverted
    expect(statusOf(body, 'pages.promo')).toMatchObject({ status: 'skipped-failed', reason: "You can't archive pages" })
    expect(statusOf(body, 'pages.home')?.status).toBe('reverted')
    expect(await titleOf(local, 'pages/home/page.json')).toBe('Home')
  })

  it("doesn't archive a page that came in outside the admin; it skips it (Seer, #1732)", async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    // History's baseline is taken at the first save; news arrives afterwards, as a git pull would bring it.
    await save(app, token, 'other', { name: 'about', manifest: page('About again') })
    local.seed({ 'pages/news/page.json': JSON.stringify(page('News')) })
    await save(app, token, 'r1', { name: 'news', manifest: page('News by agent') })
    const body = (await (await revert(app, token)).json()) as Reverted
    expect(statusOf(body, 'pages.news')).toMatchObject({
      status: 'skipped-failed',
      reason: expect.stringContaining('history'),
    })
    expect(JSON.parse(await local.readFile('pages/news/page.json')).archived).toBeUndefined()
  })

  it('reverts a language version as its own item', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    await save(app, token, 'r1', { name: 'home', locale: 'fr', manifest: page('Accueil par agent') })
    const body = (await (await revert(app, token)).json()) as Reverted
    expect(body.items).toEqual([expect.objectContaining({ item: 'pages.home:fr', status: 'reverted' })])
    expect(await titleOf(local, 'pages/home/page.fr.json')).toBe('Accueil')
    expect(await titleOf(local, 'pages/home/page.json')).toBe('Home')
  })

  it('answers 401 to an anonymous caller before reading the run (Seer, #1732)', async () => {
    const { app } = setup()
    const token = await signIn(app)
    await theRun(app, token)
    expect((await revert(app, {})).status).toBe(401)
    expect((await revert(app, {}, {}, 'nope')).status).toBe(401)
  })

  it('answers 404 for an unknown run, and refuses a revert sent in the same run', async () => {
    const { app } = setup()
    const token = await signIn(app)
    expect((await app.request('/api/v1/runs/nope', { headers: token })).status).toBe(404)
    expect((await revert(app, token, {}, 'nope')).status).toBe(404)
    await theRun(app, token)
    expect((await revert(app, { ...token, 'Gazetta-Run': 'r1' })).status).toBe(400)
  })
})
