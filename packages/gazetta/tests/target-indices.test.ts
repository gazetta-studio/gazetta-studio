/**
 * A target's dependency indices describe what was published to it
 * (sidecars.md, "Target indices describe the target"): each published
 * item replaces its own edges using its forward record, and nothing
 * else on the target changes.
 */
import { describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishRun, type PublishItemRef } from '../src/publish-run.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { scanTemplates } from '../src/templates-scan.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterProjectRoot, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

async function setup() {
  const manifest = await starterManifest()
  const sourceRoot = createContentRoot(createFilesystemProvider(starterTargetDir), '')
  const site = await loadSite({ contentRoot: sourceRoot, templatesDir: starterTemplatesDir, manifest })
  const templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
  const target = memoryStorage()
  const run = (items: PublishItemRef[], opts: { site?: Site; force?: boolean } = {}) =>
    publishRun({
      items,
      targets: ['t'],
      site: opts.site ?? site,
      sourceRoot,
      siteManifest: { ...manifest, targets: { t: { storage: target, type: 'dynamic' } } } as typeof manifest,
      targetStorages: new Map([['t', target]]),
      templateInfos,
      publishAssetsBeforeItems: false,
      publishSiteManifestAfter: false,
      force: opts.force,
    })
  return { site, target, run }
}

/** The site with one page manifest replaced. */
function withPage(site: Site, name: string, page: unknown): Site {
  const pages = new Map(site.pages)
  pages.set(name, page as never)
  return { ...site, pages }
}

async function listNames(storage: MemoryStorage, dir: string): Promise<string[]> {
  try {
    return (await storage.readDir(dir)).map(e => e.name).sort()
  } catch {
    return []
  }
}

async function record(storage: MemoryStorage, relation: string, item: string): Promise<string[] | null> {
  const path = `.gazetta/deps-of/${relation}/${item}`
  return (await storage.exists(path)) ? JSON.parse(await storage.readFile(path)) : null
}

describe('target dependency indices', () => {
  it("replaces only the published page's edges and leaves everything else in place", async () => {
    const { target, run } = await setup()
    // Edges another publish left, including an item only on the target.
    target.seed({
      '.gazetta/fragment-deps/header/pages.about': '',
      '.gazetta/deps-of/fragment-deps/pages.about': '["header"]',
      '.gazetta/fragment-deps/promo/pages.legacy': '',
      '.gazetta/deps-of/fragment-deps/pages.legacy': '["promo"]',
    })

    const result = await run([{ kind: 'page', name: 'home' }])
    expect(result.ok).toBe(true)

    expect(await listNames(target, '.gazetta/fragment-deps/header')).toEqual(['pages.about', 'pages.home'])
    expect(await listNames(target, '.gazetta/fragment-deps/footer')).toEqual(['pages.home'])
    expect(await target.exists('.gazetta/fragment-deps/promo/pages.legacy')).toBe(true)
    expect(await record(target, 'fragment-deps', 'pages.legacy')).toEqual(['promo'])
    expect(await record(target, 'fragment-deps', 'pages.home')).toEqual(['footer', 'header'])
  })

  it("never names a source page that wasn't published to the target", async () => {
    const { site, target, run } = await setup()
    await run([{ kind: 'page', name: 'home' }])
    // Every starter page uses @header on the source; only home was published.
    expect(site.pages.size).toBeGreaterThan(1)
    expect(await listNames(target, '.gazetta/fragment-deps/header')).toEqual(['pages.home'])
    expect(await listNames(target, '.gazetta/deps-of/fragment-deps')).toEqual(['pages.home'])
  })

  it('a page republished without a fragment loses that edge, without reading target manifests', async () => {
    const { site, target, run } = await setup()
    await run([{ kind: 'page', name: 'home' }])
    expect(await target.exists('.gazetta/fragment-deps/footer/pages.home')).toBe(true)

    const home = site.pages.get('home')!
    const withoutFooter = withPage(site, 'home', {
      ...home,
      components: home.components?.filter(c => c !== '@footer'),
    })
    const reads: string[] = []
    const readFile = target.readFile.bind(target)
    target.readFile = async (path: string) => {
      reads.push(path)
      return readFile(path)
    }
    await run([{ kind: 'page', name: 'home' }], { site: withoutFooter })

    expect(await target.exists('.gazetta/fragment-deps/footer/pages.home')).toBe(false)
    expect(await target.exists('.gazetta/fragment-deps/header/pages.home')).toBe(true)
    expect(await record(target, 'fragment-deps', 'pages.home')).toEqual(['header'])
    expect(reads.filter(p => /(page|fragment)(\.[^/]+)?\.json$/.test(p))).toEqual([])
  })

  it('a locale variant gets its own edges and record', async () => {
    const { target, run } = await setup()
    await run([{ kind: 'page', name: 'home', locale: 'fr' }])
    expect(await record(target, 'fragment-deps', 'pages.home:fr')).not.toBeNull()
    expect(await target.exists('.gazetta/fragment-deps/header/pages.home:fr')).toBe(true)
    expect(await record(target, 'fragment-deps', 'pages.home')).toBeNull()
  })

  it('a page whose render fails keeps its previous edges and record and gets no hash sidecar', async () => {
    const { site, target, run } = await setup()
    await run([{ kind: 'page', name: 'home' }])
    const hashesBefore = (await listNames(target, 'pages/home')).filter(n => n.endsWith('.hash'))
    expect(hashesBefore).toHaveLength(1)

    const broken = withPage(site, 'home', { route: '/', template: 'no-such-template', components: ['@header'] })
    const result = await run([{ kind: 'page', name: 'home' }], { site: broken })
    expect(result.items[0]?.ok).toBe(false)

    expect(await record(target, 'fragment-deps', 'pages.home')).toEqual(['footer', 'header'])
    expect(await target.exists('.gazetta/fragment-deps/footer/pages.home')).toBe(true)
    expect((await listNames(target, 'pages/home')).filter(n => n.endsWith('.hash'))).toEqual(hashesBefore)
  })

  it('a page that never published successfully has no edges, no record and no hash sidecar', async () => {
    const { site, target, run } = await setup()
    const broken = withPage(site, 'home', { route: '/', template: 'no-such-template', components: ['@header'] })
    await run([{ kind: 'page', name: 'home' }], { site: broken })
    expect(await record(target, 'fragment-deps', 'pages.home')).toBeNull()
    expect(await target.exists('.gazetta/fragment-deps/header/pages.home')).toBe(false)
    expect((await listNames(target, 'pages/home')).filter(n => n.endsWith('.hash'))).toEqual([])
  })

  it('force wipes the indices and records, then rebuilds them from the published items', async () => {
    const stale = {
      '.gazetta/fragment-deps/ghost/pages.gone': '',
      '.gazetta/asset-refs/old/pages.gone': '',
      '.gazetta/alias-targets/x/pages.gone': '',
      '.gazetta/deps-of/fragment-deps/pages.gone': '["ghost"]',
    }

    const control = await setup()
    control.target.seed(stale)
    await control.run([{ kind: 'page', name: 'home' }])
    expect(await control.target.exists('.gazetta/fragment-deps/ghost/pages.gone')).toBe(true)

    const { target, run } = await setup()
    target.seed(stale)
    await run([{ kind: 'page', name: 'home' }], { force: true })
    for (const path of Object.keys(stale)) expect(await target.exists(path)).toBe(false)
    expect(await record(target, 'fragment-deps', 'pages.home')).toEqual(['footer', 'header'])
    expect(await target.exists('.gazetta/fragment-deps/header/pages.home')).toBe(true)
  })

  it('an archived page with aliasOf gets an alias-targets edge and record', async () => {
    const { site, target, run } = await setup()
    const archived = withPage(site, 'landing', {
      route: '/landing',
      template: 'page-default',
      archived: true,
      aliasOf: 'home',
    })
    const result = await run([{ kind: 'page', name: 'landing' }], { site: archived })
    expect(result.ok).toBe(true)
    expect(await target.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)
    expect(await record(target, 'alias-targets', 'pages.landing')).toEqual(['home'])
  })
})
