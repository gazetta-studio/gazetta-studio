/**
 * ESI publishing and serving follow a target's own language settings
 * (design-i18n.md "Target locale rules", #1146). ESI files keep their
 * names (`index.html` is the site's default language, `index.fr.html`
 * French); what changes is which ones a target publishes and which file
 * a request reads: on a French-only target `/about` is French.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, findPage, serveLocaleOptions } from '../src/serve.js'
import { createWorker } from '../src/workers/cloudflare-r2.js'
import { renderWorkerEntry, workerEntryLocales } from '../src/deploy/cloudflare-workers.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

const SITE: SiteManifest = { name: 'test', locales: { default: 'en', supported: ['en', 'fr'] } }
const FR_ONLY = { locale: 'fr', locales: ['fr'] } as TargetConfig
const PREFIXED = { defaultPrefix: true } as TargetConfig

const page = (body: string) => `<!DOCTYPE html><html><body>${body}</body></html>`

function esiStorage(): MemoryStorage {
  const storage = memoryStorage()
  storage.seed({
    'pages/home/index.html': page('Home EN'),
    'pages/home/index.fr.html': page('Accueil FR'),
    'pages/about/index.html': page('About EN'),
    'pages/about/index.fr.html': page('A propos FR'),
  })
  return storage
}

describe('serveLocaleOptions takes the target languages (#1146)', () => {
  it('a French-only target: French is the default, English names the index.html files', () => {
    expect(serveLocaleOptions(SITE, FR_ONLY)).toEqual({
      locales: ['fr'],
      defaultLocale: 'fr',
      defaultPrefix: false,
      detection: false,
      contentLocale: 'en',
    })
  })

  it('a target with defaultPrefix', () => {
    expect(serveLocaleOptions(SITE, PREFIXED)).toMatchObject({ locales: ['en', 'fr'], defaultPrefix: true })
  })

  it('a target without language settings inherits the site', () => {
    expect(serveLocaleOptions(SITE, {} as TargetConfig)).toMatchObject({
      locales: ['en', 'fr'],
      defaultLocale: 'en',
      defaultPrefix: false,
      contentLocale: 'en',
    })
  })
})

describe('gazetta serve on an ESI target follows the target languages (#1146)', () => {
  it('a French-only target serves French at /about, and /fr/about is not a language route', async () => {
    const app = createServer({ storage: esiStorage(), type: 'dynamic', ...serveLocaleOptions(SITE, FR_ONLY) })

    const about = await app.request('http://localhost/about')
    expect(about.status).toBe(200)
    expect(await about.text()).toContain('A propos FR')
    expect(await (await app.request('http://localhost/')).text()).toContain('Accueil FR')
    expect((await app.request('http://localhost/fr/about')).status).toBe(404)
  })

  it('defaultPrefix serves the default language under its prefix', async () => {
    const app = createServer({ storage: esiStorage(), type: 'dynamic', ...serveLocaleOptions(SITE, PREFIXED) })

    const en = await app.request('http://localhost/en/about')
    expect(en.status).toBe(200)
    expect(await en.text()).toContain('About EN')
    expect(await (await app.request('http://localhost/fr/about')).text()).toContain('A propos FR')
  })

  it('a target default other than the site default reads the default-language file under its prefix', async () => {
    const app = createServer({
      storage: esiStorage(),
      type: 'dynamic',
      ...serveLocaleOptions(SITE, { locale: 'fr', locales: ['fr', 'en'] } as TargetConfig),
    })

    expect(await (await app.request('http://localhost/about')).text()).toContain('A propos FR')
    expect(await (await app.request('http://localhost/en/about')).text()).toContain('About EN')
  })

  it('an archive redirect on a French-only target goes to the unprefixed route', async () => {
    const storage = esiStorage()
    storage.seed({ 'pages/old/index.fr.html': archiveMarker({ kind: 'alias', target: 'about' }) })
    const app = createServer({ storage, type: 'dynamic', ...serveLocaleOptions(SITE, FR_ONLY) })

    const res = await app.request('http://localhost/old')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/about')
  })

  it('findPage without a target default keeps the earlier routing', async () => {
    const result = await findPage(esiStorage(), '/fr/about', ['en', 'fr'])
    expect(result?.html).toContain('A propos FR')
  })
})

describe('gazetta serve on a static target with defaultPrefix (#1146)', () => {
  const LIVE = page('Welcome')

  it('an alias without a version in the request language redirects to the prefixed default', async () => {
    const storage = memoryStorage()
    storage.seed({
      '/en/welcome/index.html': LIVE,
      '/fr/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })
    const app = createServer({ storage, type: 'static', ...serveLocaleOptions(SITE, PREFIXED) })

    const res = await app.request('http://localhost/fr/landing')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/en/welcome')
  })

  it('keeps the request language when the destination has a version in it', async () => {
    const storage = memoryStorage()
    storage.seed({
      '/en/welcome/index.html': LIVE,
      '/fr/welcome/index.html': LIVE,
      '/fr/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })
    const app = createServer({ storage, type: 'static', ...serveLocaleOptions(SITE, PREFIXED) })

    const res = await app.request('http://localhost/fr/landing')
    expect(res.headers.get('location')).toBe('/fr/welcome')
  })

  it('an archive on a French-only static target redirects to the unprefixed route', async () => {
    const storage = memoryStorage()
    storage.seed({
      '/welcome/index.html': LIVE,
      '/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })
    const app = createServer({ storage, type: 'static', ...serveLocaleOptions(SITE, FR_ONLY) })

    const res = await app.request('http://localhost/landing')
    expect(res.headers.get('location')).toBe('/welcome')
  })
})

describe('the generated worker embeds the target languages (#1146)', () => {
  it('workerEntryLocales gives the target languages, not the site ones', () => {
    expect(workerEntryLocales(SITE, FR_ONLY)).toEqual({
      supported: ['fr'],
      default: 'fr',
      defaultPrefix: false,
      contentLocale: 'en',
    })
    expect(workerEntryLocales({ name: 'plain' }, FR_ONLY)).toBeUndefined()
  })

  it('renderWorkerEntry embeds the content language when it differs from the default', () => {
    expect(renderWorkerEntry(workerEntryLocales(SITE, FR_ONLY))).toContain(
      'createWorker({ locales: ["fr"], defaultLocale: "fr", defaultPrefix: false, contentLocale: "en" })',
    )
  })

  describe('the worker routes by the embedded languages', () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches
    beforeEach(() => {
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        writable: true,
        value: { default: { match: async () => undefined, put: async () => {} } },
      })
    })
    afterEach(() => {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
      else delete (globalThis as { caches?: unknown }).caches
    })

    const bucketFrom = (storage: MemoryStorage) => ({
      async get(key: string) {
        if (!(await storage.exists(key))) return null
        const value = await storage.readFile(key)
        return { text: async () => value, body: value }
      },
      async list() {
        return { delimitedPrefixes: [] as string[], objects: [] }
      },
    })

    const fetchFrom = async (path: string) => {
      const app = createWorker({
        locales: ['fr'],
        defaultLocale: 'fr',
        defaultPrefix: false,
        contentLocale: 'en',
      })
      return app.fetch(
        new Request(`https://example.fr${path}`),
        { SITE_BUCKET: bucketFrom(esiStorage()) } as never,
        { waitUntil: () => {}, passThroughOnException: () => {} } as never,
      )
    }

    it('serves French at /about on a French-only target', async () => {
      const res = await fetchFrom('/about')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('A propos FR')
    })

    it('/fr/about is not a language route there', async () => {
      expect((await fetchFrom('/fr/about')).status).toBe(404)
    })
  })
})

describe('ESI publish follows the target languages (#1146)', { timeout: 30000 }, () => {
  it('a French-only ESI target gets French files and no English page file', async () => {
    const sourceStorage = createFilesystemProvider(starterTargetDir)
    const targetStorage = memoryStorage()
    const starter = await starterManifest()
    const targetConfig = {
      storage: targetStorage,
      type: 'dynamic' as const,
      environment: 'staging' as const,
      publicStorage: false,
      locale: 'fr',
      locales: ['fr'],
    } as TargetConfig
    const localConfig = { storage: sourceStorage, type: 'esi', environment: 'local', editable: true } as TargetConfig
    const manifest: SiteManifest = { ...starter, targets: { local: localConfig, staging: targetConfig } }
    const app = createAdminApp({
      source: createSourceContext({ storage: sourceStorage, siteDir: '', projectSiteDir: '/test-project', manifest }),
      siteDir: '/test-project',
      templatesDir: starterTemplatesDir,
      targets: new Map([
        ['local', sourceStorage],
        ['staging', targetStorage],
      ]),
      targetConfigs: { local: localConfig, staging: targetConfig },
      disableCacheStatsLogger: true,
    })
    const res = await app.request('/api/v1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/about', 'pages/showcase', 'fragments/header'], targets: ['staging'] }),
    })
    expect(res.status, await res.clone().text()).toBeLessThan(300)

    const files = [...targetStorage.dump().keys()]
    expect(files).toContain('pages/about/index.fr.html')
    expect(files).not.toContain('pages/about/index.html')
    // showcase has no French version.
    expect(files.some(f => f.startsWith('pages/showcase/index'))).toBe(false)
    // A fragment keeps its base file: pages in a language it lacks read it.
    expect(files).toContain('fragments/header/index.fr.html')
    expect(files).toContain('fragments/header/index.html')

    const served = createServer({
      storage: targetStorage,
      type: 'dynamic',
      ...serveLocaleOptions(manifest, targetConfig),
    })
    const about = await served.request('http://localhost/about')
    expect(about.status).toBe(200)
    expect(await about.text()).toContain('À Propos de Gazetta')
  })
})
