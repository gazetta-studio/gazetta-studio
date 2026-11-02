/**
 * Creating pages, fragments and redirects records history (#1734), so
 * undo and the History panel see them, and a run that created one can
 * be reverted (design-agent-access.md Q47, Q48).
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
const page = (title: string) => ({
  template: 'page-default',
  content: {},
  components: [{ name: 'hero', template: 'hero', content: { title } }],
})

function setup() {
  const local = memoryStorage()
  local.seed({ 'pages/home/page.json': JSON.stringify(page('Home')) })
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
  ).json()) as { token: string }
  return { 'Gazetta-Token': r.token }
}

const newest = async (local: StorageProvider) => (await createHistoryProvider({ storage: local }).listRevisions(1))[0]!
const created = async (local: StorageProvider, id: string) =>
  (await createHistoryProvider({ storage: local }).readRevision(id)).created

describe('creating records history (#1734)', () => {
  it('a page, as created, with its author', async () => {
    const { app, local } = setup()
    const res = await app.request('/api/v1/pages', post({ name: 'news', template: 'page-default' }, alice))
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    const rev = await newest(local)
    expect(rev).toMatchObject({ author: 'alice', items: ['pages/news/page.json'] })
    expect(await created(local, rev.id)).toEqual(['pages/news/page.json'])
  })

  it('a fragment, as created', async () => {
    const { app, local } = setup()
    const res = await app.request('/api/v1/fragments', post({ name: 'banner', template: 'hero' }, alice))
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    const rev = await newest(local)
    expect(rev.items).toEqual(['fragments/banner/fragment.json'])
    expect(await created(local, rev.id)).toEqual(['fragments/banner/fragment.json'])
  })

  it('a redirect, as created', async () => {
    const { app, local } = setup()
    const res = await app.request('/api/v1/page-redirects', post({ from: 'old-home', to: 'home' }, alice))
    expect(res.status, await res.clone().text()).toBe(201)
    const rev = await newest(local)
    expect(await created(local, rev.id)).toEqual(['pages/old-home/page.json'])
  })

  it('a moved-aside archive at its new name, and the new page at the old one', async () => {
    const { app, local } = setup()
    local.seed({ 'pages/promo/page.json': JSON.stringify({ ...page('Old promo'), archived: true }) })
    const res = await app.request(
      '/api/v1/pages?onConflict=moveAside',
      post({ name: 'promo', template: 'page-default' }, alice),
    )
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    const rev = await newest(local)
    const aside = rev.items.find(p => p !== 'pages/promo/page.json')!
    expect(aside).toMatch(/^pages\/promo-archived-\d{8}(-\d+)?\/page\.json$/)
    expect(rev.items).toContain('pages/promo/page.json')
    expect(await created(local, rev.id)).toEqual([aside])
  })

  it('through a token in a run, so reverting the run archives what it created', async () => {
    const { app, local } = setup()
    const token = await signIn(app)
    const res = await app.request(
      '/api/v1/pages',
      post({ name: 'news', template: 'page-default' }, { ...token, 'Gazetta-Run': 'r1' }),
    )
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    expect(await newest(local)).toMatchObject({ channel: 'token', runId: 'r1', author: 'alice' })

    const reverted = await app.request('/api/v1/runs/r1/revert', post({}, token))
    expect(await reverted.json()).toMatchObject({ items: [{ item: 'pages.news', status: 'archived' }] })
    expect(JSON.parse(await local.readFile('pages/news/page.json')).archived).toBe(true)
  })
})
