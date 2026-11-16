/**
 * Publishing follows a target's own language settings (design-i18n.md
 * "Target locale rules", #1146): the target's default language at
 * unprefixed routes (prefixed with `defaultPrefix`), its other languages
 * under `/<locale>/`, and languages outside its `locales` not published,
 * the site's default language included. The sitemap and the `_redirects`
 * rows name only routes the publish wrote.
 *
 * Runs the starter site (en default; about has fr, home has fr/ar/ja)
 * through the admin publish route, which fans each item out into the
 * versions the target publishes.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'
import {
  fragmentVersionsFor,
  pageVersionsFor,
  resolveTargetLanguages,
  versionRoutePrefix,
} from '../src/target-locales.js'

async function publishTo(
  extra: Partial<TargetConfig>,
  items: string[],
  manifestTweak?: (m: SiteManifest) => SiteManifest,
): Promise<MemoryStorage> {
  const sourceStorage = createFilesystemProvider(starterTargetDir)
  const targetStorage = memoryStorage()
  const starter = await starterManifest()
  const targetConfig = {
    storage: targetStorage,
    type: 'static' as const,
    environment: 'staging' as const,
    siteUrl: 'https://example.fr',
    publicStorage: false,
    redirects: { format: 'cloudflare' as const },
    ...extra,
  } as TargetConfig
  const localConfig = {
    storage: sourceStorage,
    type: 'esi' as const,
    environment: 'local' as const,
    editable: true,
  } as TargetConfig
  const base = manifestTweak ? manifestTweak(starter) : starter
  const manifest: SiteManifest = { ...base, targets: { local: localConfig, staging: targetConfig } }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest,
  })
  const app = createAdminApp({
    source,
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
    body: JSON.stringify({ items, targets: ['staging'] }),
  })
  expect(res.status, await res.clone().text()).toBeLessThan(300)
  return targetStorage
}

/** Rendered pages a static target serves: `index.html` files outside `pages/`, `fragments/` and `.gazetta/`. */
function servedPages(storage: MemoryStorage): string[] {
  return [...storage.dump().keys()]
    .filter(k => k.endsWith('index.html') && !/^(pages|fragments|\.gazetta)\//.test(k))
    .sort()
}

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).sort()
}

/** Route a sitemap URL names, as the static file the target must hold for it. */
function staticFileFor(url: string): string {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '')
  return path ? `${path}/index.html` : 'index.html'
}

describe('static publish follows the target language rules (#1146)', { timeout: 30000 }, () => {
  it('a French-only target serves French at unprefixed routes and writes no English', async () => {
    const target = await publishTo({ locale: 'fr', locales: ['fr'] }, ['pages/about', 'pages/home'])

    expect(servedPages(target)).toEqual(['about/index.html', 'index.html'])
    expect(await target.readFile('about/index.html')).toContain('À Propos de Gazetta')
    expect(await target.readFile('index.html')).not.toContain('<h2>About Gazetta</h2>')
  })

  it('a page with no version in the target languages is not published', async () => {
    // showcase has no French version.
    const target = await publishTo({ locale: 'fr', locales: ['fr'] }, ['pages/about', 'pages/showcase'])

    expect(servedPages(target)).toEqual(['about/index.html'])
  })

  it('a target whose default is not the site default prefixes the site default', async () => {
    const target = await publishTo({ locale: 'fr', locales: ['fr', 'en'] }, ['pages/about'])

    expect(servedPages(target)).toEqual(['about/index.html', 'en/about/index.html'])
    expect(await target.readFile('about/index.html')).toContain('À Propos de Gazetta')
    expect(await target.readFile('en/about/index.html')).toContain('About Gazetta')
  })

  it('defaultPrefix prefixes the default language too', async () => {
    const target = await publishTo({ defaultPrefix: true, locales: ['en', 'fr'] }, ['pages/about', 'pages/home'])

    expect(servedPages(target)).toEqual([
      'en/about/index.html',
      'en/index.html',
      'fr/about/index.html',
      'fr/index.html',
    ])
  })

  it('every sitemap URL is a page the publish wrote', async () => {
    for (const extra of [
      { locale: 'fr', locales: ['fr'] },
      { locale: 'fr', locales: ['fr', 'en'] },
      { defaultPrefix: true, locales: ['en', 'fr'] },
    ] satisfies Partial<TargetConfig>[]) {
      const target = await publishTo(extra, ['pages/about', 'pages/home'])
      const locs = sitemapLocs(await target.readFile('sitemap.xml'))
      expect(locs.length, JSON.stringify(extra)).toBeGreaterThan(0)
      const pages = servedPages(target)
      for (const loc of locs) expect(pages, `${JSON.stringify(extra)}: ${loc}`).toContain(staticFileFor(loc))
    }
  })
})

describe('target-locales helpers (#1146)', () => {
  const site: SiteManifest = { name: 's', locales: { default: 'en', supported: ['en', 'fr', 'de'] } }

  it.each([
    ['inherits the site', {}, ['de', 'fr'], [undefined, 'de', 'fr']],
    ['French-only drops the base file', { locales: ['fr'] }, ['de', 'fr'], ['fr']],
    ['no version in the target languages', { locales: ['fr'] }, ['de'], []],
    ['a variant outside the target languages', { locales: ['en', 'fr'] }, ['de', 'fr'], [undefined, 'fr']],
  ] as const)('pages: %s', (_label, target, variants, expected) => {
    const langs = resolveTargetLanguages(site, target as TargetConfig)
    expect(pageVersionsFor(variants, langs)).toEqual(expected)
  })

  it('fragments keep the base file as the request-time fallback', () => {
    const langs = resolveTargetLanguages(site, { locales: ['fr'] } as TargetConfig)
    expect(fragmentVersionsFor(['fr'], langs)).toEqual([undefined, 'fr'])
    expect(fragmentVersionsFor([], langs)).toEqual([undefined])
  })

  it.each([
    [{}, undefined, ''],
    [{}, 'fr', '/fr'],
    [{ locale: 'fr', locales: ['fr'] }, 'fr', ''],
    [{ locale: 'fr', locales: ['fr', 'en'] }, undefined, '/en'],
    [{ defaultPrefix: true }, undefined, '/en'],
  ] as const)('prefix of %o / %s is %s', (target, variant, prefix) => {
    expect(versionRoutePrefix(resolveTargetLanguages(site, target as TargetConfig), variant)).toBe(prefix)
  })

  it('without site locales: the base file plus the variants the target allows, prefixed by their code', () => {
    const plain: SiteManifest = { name: 's' }
    expect(resolveTargetLanguages(plain, undefined)).toBeNull()
    expect(pageVersionsFor(['fr', 'de'], null, ['fr'])).toEqual([undefined, 'fr'])
    expect(versionRoutePrefix(null, 'fr')).toBe('/fr')
    expect(versionRoutePrefix(null, undefined)).toBe('')
  })
})
