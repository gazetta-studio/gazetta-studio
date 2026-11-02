/**
 * Saving an item's first language version answers the save-version that
 * reading it returns, so the next save isn't refused as stale (#1719).
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function setup() {
  const local = memoryStorage()
  local.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {}, components: [] }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {}, components: [] }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'footer-layout', content: {}, components: [] }),
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
  }
  return createAdminApp({
    source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>([['local', local]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
}
type App = ReturnType<typeof setup>

const etagOf = async (app: App, path: string) => (await app.request(path)).headers.get('ETag')!.replace(/"/g, '')
const put = (app: App, path: string, content: Record<string, unknown>, ifMatch: string) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${ifMatch}"` },
    body: JSON.stringify({ content }),
  })

describe("an item's first language version", () => {
  it.each([
    ['the home page', '/api/v1/pages/home?locale=fr'],
    ['a page with its own route', '/api/v1/pages/about?locale=fr'],
    ['a fragment', '/api/v1/fragments/header?locale=fr'],
  ])('of %s answers the save-version reading it returns, and saves again with it', async (_case, path) => {
    const app = setup()
    const first = await put(app, path, { n: 1 }, await etagOf(app, path))
    expect(first.status).toBe(200)
    const { etag } = (await first.json()) as { etag: string }
    expect(etag).toBe(await etagOf(app, path))
    expect((await put(app, path, { n: 2 }, etag)).status).toBe(200)
  })
})
