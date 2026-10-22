/**
 * #1130: on a plain-static target with a host redirects file, an archived
 * page gets one row per language the target publishes — a redirect keeps
 * the visitor's language (#1124). Before the fix both redirect builders
 * skipped every locale variant (`if (entry.locale) continue`), so a
 * French visitor to an archived page hit the host's blank marker page
 * or a 404 instead of `/fr/<alias>`.
 *
 * Languages, default and prefixes mirror the sitemap
 * (`targetConfig.locales ?? supported`, `targetConfig.locale ?? site
 * default`, `localeRoutePrefix` for the prefix).
 *
 * Publishes a fragment rather than the pages: static-mode fragment
 * publish copies the source verbatim, while page rendering needs a real
 * templates directory. The redirect rows come from the site manifest,
 * not from the published items, so a fragment publish exercises the
 * same block.
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

interface BuildOpts {
  manifestExtra?: Record<string, unknown>
  targetConfigExtra?: Record<string, unknown>
}

function buildApp(opts: BuildOpts = {}): { app: Hono; targetStorage: MemoryStorage } {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    'pages/landing/page.json': JSON.stringify({
      template: 'page-default',
      content: {},
      archived: true,
      aliasOf: 'welcome',
    }),
    'pages/old/page.json': JSON.stringify({
      template: 'page-default',
      content: {},
      archived: true,
    }),
    'pages/welcome/page.json': JSON.stringify({ template: 'page-default', content: {} }),
  })

  const targetConfig = {
    storage: targetStorage,
    type: 'static' as const,
    environment: 'staging' as const,
    redirects: { format: 'cloudflare' as const },
    ...opts.targetConfigExtra,
  }
  const localConfig = {
    storage: sourceStorage,
    type: 'esi' as const,
    environment: 'local' as const,
    editable: true,
  }

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      ...opts.manifestExtra,
      targets: { local: localConfig, staging: targetConfig },
    },
  })

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: { local: localConfig, staging: targetConfig },
    disableCacheStatsLogger: true,
  })

  return { app, targetStorage }
}

async function publishAndReadRedirects(app: Hono, targetStorage: MemoryStorage): Promise<string> {
  const res = await app.request('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['fragments/header'], targets: ['staging'] }),
  })
  expect(res.status).toBeLessThan(300)
  return targetStorage.readFile('_redirects')
}

describe('publish route — redirects rows per target language (#1130)', () => {
  it('writes one row per published language for archived pages', async () => {
    const { app, targetStorage } = buildApp({
      manifestExtra: { locales: { default: 'en', supported: ['en', 'fr'] } },
    })

    const body = await publishAndReadRedirects(app, targetStorage)

    expect(body).toContain('/landing  /welcome  301')
    expect(body).toContain('/fr/landing  /fr/welcome  301')
    expect(body).toContain('/old  /  410')
    expect(body).toContain('/fr/old  /  410')
    expect(body.trim().split('\n')).toHaveLength(4)
  })

  it('writes only the default-language rows for a single-locale target', async () => {
    const { app, targetStorage } = buildApp({
      manifestExtra: { locales: { default: 'en', supported: ['en', 'fr'] } },
      targetConfigExtra: { locales: ['en'] },
    })

    const body = await publishAndReadRedirects(app, targetStorage)

    expect(body).toContain('/landing  /welcome  301')
    expect(body).toContain('/old  /  410')
    expect(body).not.toContain('/fr/')
    expect(body.trim().split('\n')).toHaveLength(2)
  })

  it('writes the same rows as before for a site without locales', async () => {
    const { app, targetStorage } = buildApp({})

    const body = await publishAndReadRedirects(app, targetStorage)

    expect(body).toContain('/landing  /welcome  301')
    expect(body).toContain('/old  /  410')
    expect(body).not.toContain('/fr/')
    expect(body.trim().split('\n')).toHaveLength(2)
  })
})
