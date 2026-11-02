/**
 * publishToTarget tests - the shared target-publish function
 * (publish-undo cut 1, #1426).
 *
 * Locks the per-target step order both callers now share: the
 * approval-gate place (a documented no-op in this cut) precedes the
 * history record, which precedes the manifest copy, the render loop,
 * the generated files (written or DELETED, never skipped), the
 * publish generation and the CDN purge. Purge scope is the caller's
 * explicit option.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishToTarget, type PurgeOutcome } from '../src/publish-target.js'
import { createPublishSnapshot, type PublishSnapshot } from '../src/publish-snapshot.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { PUBLISH_GENERATION_PATH } from '../src/publish-generation.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { scanTemplates, type TemplateInfo } from '../src/templates-scan.js'
import type { SiteManifest, StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterProjectRoot, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

const purgeCalls: string[] = []

vi.mock('../src/publish-rendered.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/publish-rendered.js')>()
  return {
    ...original,
    createCloudflarePurge: () => ({
      purgeAll: async () => {
        purgeCalls.push('purgeAll')
      },
      purgeUrls: async (urls: string[]) => {
        purgeCalls.push(`purgeUrls:${urls.length}`)
      },
    }),
  }
})

let forceEmptySitemap = false

vi.mock('../src/sitemap.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/sitemap.js')>()
  return {
    ...original,
    generateSitemap: (input: Parameters<typeof original.generateSitemap>[0]) =>
      forceEmptySitemap ? null : original.generateSitemap(input),
  }
})

function recordingStorage(inner: MemoryStorage, log: string[]): StorageProvider {
  const writeFileBound = inner.writeFile.bind(inner)
  return {
    ...inner,
    writeFile: async (path: string, content: string) => {
      log.push(`write:${path}`)
      return writeFileBound(path, content)
    },
    rm: async (path: string) => {
      log.push(`rm:${path}`)
      return inner.rm(path)
    },
  } as StorageProvider
}

const PURGE_CONFIG = { type: 'cloudflare' as const, apiToken: 'tok', zoneId: 'zone' }

describe('publishToTarget (#1426)', () => {
  let site: Site
  let manifest: SiteManifest
  let templateInfos: TemplateInfo[]
  let sourceRoot: ReturnType<typeof createContentRoot>
  let snapshot: PublishSnapshot
  let innerTarget: MemoryStorage
  let events: string[]
  let targetStorage: StorageProvider
  let tmp: string

  const stagingConfig = (extra?: Partial<TargetConfig>): TargetConfig =>
    ({
      type: 'esi' as const,
      environment: 'staging' as const,
      siteUrl: 'https://example.com',
      ...extra,
    }) as TargetConfig

  // A publishable content page: not dynamic, not a system page (system
  // pages never qualify for the sitemap).
  const pageName = () =>
    [...site.pages.keys()].find(k => !k.includes('[') && !(site.manifest.systemPages ?? []).includes(k))!

  const publish = (targetConfig: TargetConfig, purgeScope: 'all' | 'items' = 'all') =>
    publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig,
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: [`pages/${pageName()}`],
      itemRefs: [{ kind: 'page', name: pageName() }],
      templateInfos,
      purgeScope,
    })

  beforeEach(async () => {
    purgeCalls.length = 0
    forceEmptySitemap = false
    events = []
    manifest = await starterManifest()
    sourceRoot = createContentRoot(createFilesystemProvider(starterTargetDir), '')
    snapshot = await createPublishSnapshot({ contentRoot: sourceRoot, manifest, templatesDir: starterTemplatesDir })
    site = snapshot.site
    templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
    tmp = await mkdtemp('.tmp-publish-target-')
    innerTarget = memoryStorage()
    targetStorage = recordingStorage(innerTarget, events)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('runs the locked step order: history record, manifest copy, generated files, generation, purge', async () => {
    const result = await publish(stagingConfig({ cache: { purge: PURGE_CONFIG } }))

    expect(result.run?.failed).not.toBe(true)
    // The gate's place precedes every write; the first observable write
    // is the history revision (baseline + publish), before the copy.
    const copyIndex = events.indexOf(`write:pages/${pageName()}/page.json`)
    const generationIndex = events.indexOf(`write:${PUBLISH_GENERATION_PATH}`)
    expect(copyIndex).toBeGreaterThan(0)
    expect(events[0]).toMatch(/^write:.*history/)
    expect(generationIndex).toBeGreaterThan(copyIndex)
    // Generation is written before the purge (#1125).
    expect(purgeCalls).toEqual(['purgeAll'])
    expect(result.purge).toEqual({ kind: 'purged-all' })
    // Exactly one publish revision.
    const history = createHistoryProvider({ storage: innerTarget })
    const revisions = await history.listRevisions()
    expect(revisions.filter(r => r.operation === 'publish')).toHaveLength(1)
  })

  it('writes sitemap.xml when there is content and deletes it when the sitemap would be empty', async () => {
    const first = await publish(stagingConfig())
    expect(first.generatedFiles).toContain('sitemap.xml')
    expect(await innerTarget.exists('sitemap.xml')).toBe(true)

    forceEmptySitemap = true
    const second = await publish(stagingConfig())
    expect(second.generatedFiles).not.toContain('sitemap.xml')
    expect(second.deletedFiles).toContain('sitemap.xml')
    expect(await innerTarget.exists('sitemap.xml')).toBe(false)
  })

  it('deletes a previously published sitemap.xml when the target has no site URL', async () => {
    // Spec acceptance: with no URL for the sitemap there is no sitemap
    // content, and generated files are written or deleted, never
    // skipped - the stale file does not stay live.
    await innerTarget.writeFile('sitemap.xml', 'old sitemap')
    const result = await publish(stagingConfig({ siteUrl: undefined }))
    expect(result.generatedFiles).not.toContain('sitemap.xml')
    expect(result.deletedFiles).toContain('sitemap.xml')
    expect(await innerTarget.exists('sitemap.xml')).toBe(false)
  })

  it('deletes a previously published redirects file when no redirect rows remain', async () => {
    await innerTarget.writeFile('_redirects', 'old rows')
    const result = await publish(stagingConfig({ redirects: { format: 'cloudflare' } } as Partial<TargetConfig>))
    // The starter site has no archived pages, so no rows remain.
    expect(result.generatedFiles).not.toContain('_redirects')
    expect(result.deletedFiles).toContain('_redirects')
    expect(await innerTarget.exists('_redirects')).toBe(false)
  })

  it('writes the publish generation whether or not a purge is configured', async () => {
    const result = await publish(stagingConfig())
    expect(result.purge).toEqual({ kind: 'none' })
    expect(purgeCalls).toEqual([])
    expect(await innerTarget.exists(PUBLISH_GENERATION_PATH)).toBe(true)
  })

  it("purgeScope 'items' purges only the published pages' URLs", async () => {
    // The starter's about page has a French version: the purge covers
    // the published page's URLs including its locale variants, and no
    // other page's.
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig({ cache: { purge: PURGE_CONFIG } }),
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: ['pages/about'],
      itemRefs: [
        { kind: 'page', name: 'about' },
        { kind: 'page', name: 'about', locale: 'fr' },
      ],
      templateInfos,
      purgeScope: 'items',
    })
    expect(purgeCalls).toEqual(['purgeUrls:2'])
    expect(result.purge.kind).toBe('purged-urls')
    if (result.purge.kind === 'purged-urls') {
      expect(result.purge.urls).toContain('https://example.com/about')
      expect(result.purge.urls).toContain('https://example.com/fr/about')
    }
  })

  it('limits the source-side sitemap merge to the items published in this run (#1430 review)', async () => {
    // A partial publish must not list pages the target never received
    // (they would be 404 URLs): only this run's pages merge into the
    // target listing, alongside what the target already has.
    const siteRoot = join(tmp, 'site')
    await mkdir(join(siteRoot, 'pages', 'one'), { recursive: true })
    await writeFile(
      join(siteRoot, 'pages', 'one', 'page.json'),
      JSON.stringify({ template: 'page-default', content: {} }),
    )
    await mkdir(join(siteRoot, 'pages', 'two'), { recursive: true })
    await writeFile(
      join(siteRoot, 'pages', 'two', 'page.json'),
      JSON.stringify({ template: 'page-default', content: {} }),
    )
    const twoPageRoot = createContentRoot(createFilesystemProvider(siteRoot), '')
    const twoPageSnapshot = await createPublishSnapshot({
      contentRoot: twoPageRoot,
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig(),
      snapshot: twoPageSnapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: ['pages/one'],
      itemRefs: [{ kind: 'page', name: 'one' }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    const sitemap = await innerTarget.readFile('sitemap.xml')
    expect(sitemap).toContain('/one')
    expect(sitemap).not.toContain('/two')

    // A follow-up publish of the second page adds it: it is both on
    // the target (sidecar) and in this run's merge set.
    const second = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig(),
      snapshot: twoPageSnapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: ['pages/two'],
      itemRefs: [{ kind: 'page', name: 'two' }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(second.run?.failed).not.toBe(true)
    const sitemap2 = await innerTarget.readFile('sitemap.xml')
    expect(sitemap2).toContain('/one')
    expect(sitemap2).toContain('/two')
  })

  it('stops before the generated files, generation and purge when the run fails (#1430 review)', async () => {
    // A target whose renders all fail keeps the history revision and
    // the manifest copy, but gets no sitemap, no 404, no generation
    // bump and no purge - the edge keeps serving the last good state.
    const failing = {
      ...innerTarget,
      writeFile: async (path: string, content: string) => {
        if (path.endsWith('.html')) throw new Error('render write exploded')
        return innerTarget.writeFile(path, content)
      },
    } as StorageProvider
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage: failing,
      targetConfig: { type: 'static', environment: 'staging', siteUrl: 'https://example.com' } as TargetConfig,
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: [`pages/${pageName()}`],
      itemRefs: [{ kind: 'page', name: pageName() }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).toBe(true)
    expect(result.generatedFiles).toEqual([])
    expect(result.purge).toEqual({ kind: 'none' })
    expect(purgeCalls).toEqual([])
    expect(await innerTarget.exists(PUBLISH_GENERATION_PATH)).toBe(false)
    expect(await innerTarget.exists('sitemap.xml')).toBe(false)
    expect(await innerTarget.exists('404.html')).toBe(false)
    // The manifest copy did land before the render loop.
    expect(await innerTarget.exists(`pages/${pageName()}/page.json`)).toBe(true)
  })

  it('writes 404.html for a static target before the generation and the purge (#1430 review)', async () => {
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: {
        type: 'static',
        environment: 'staging',
        siteUrl: 'https://example.com',
        cache: { purge: PURGE_CONFIG },
      } as TargetConfig,
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: [`pages/${pageName()}`],
      itemRefs: [{ kind: 'page', name: pageName() }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    expect(await innerTarget.exists('404.html')).toBe(true)
    expect(result.generatedFiles[0]).toBe('404.html')
    const notFoundIndex = events.indexOf('write:404.html')
    const generationIndex = events.indexOf(`write:${PUBLISH_GENERATION_PATH}`)
    expect(notFoundIndex).toBeGreaterThan(-1)
    expect(generationIndex).toBeGreaterThan(notFoundIndex)
    expect(purgeCalls).toEqual(['purgeAll'])
  })

  it('a bare item records and copies the default plus every translation manifest', async () => {
    const localized = [...site.pageLocales.keys()][0]
    if (!localized) return
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig(),
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: [`pages/${localized}`],
      itemRefs: [{ kind: 'page', name: localized }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    expect(await innerTarget.exists(`pages/${localized}/page.json`)).toBe(true)
    const history = createHistoryProvider({ storage: innerTarget })
    const revisions = await history.listRevisions()
    const publishes = revisions.filter(r => r.operation === 'publish')
    expect(publishes).toHaveLength(1)
    const rev = await history.readRevision(publishes[0]!.id)
    expect(Object.keys(rev.snapshot)).toContain(`pages/${localized}/page.json`)
    expect(Object.keys(rev.snapshot)).toContain(`pages/${localized}/page.fr.json`)
  })
  describe('removals', () => {
    const goneFolder = {
      'pages/old-landing/page.json': '{"template":"page-default"}',
      'pages/old-landing/page.fr.json': '{"template":"page-default"}',
      'pages/old-landing/index.html': '<old>',
      'pages/old-landing/.cf120e4b.hash': '',
      'pages/old-landing/.pub-20260417T220000Z': '',
    }

    const publishWithRemovals = (opts: { items?: string[]; storage?: StorageProvider; config?: TargetConfig } = {}) =>
      publishToTarget({
        targetName: 'staging',
        targetStorage: opts.storage ?? targetStorage,
        targetConfig: opts.config ?? stagingConfig({ cache: { purge: PURGE_CONFIG } }),
        snapshot,
        sourceName: 'local',
        siteManifest: manifest,
        items: opts.items ?? [`pages/${pageName()}`],
        itemRefs: (opts.items ?? [`pages/${pageName()}`]).map(i => ({ kind: 'page' as const, name: i.slice(6) })),
        templateInfos,
        purgeScope: 'all',
        removals: [{ kind: 'page', name: 'old-landing' }],
      })

    it('run after the render loop and before the generated files, generation and purge', async () => {
      innerTarget.seed(goneFolder)
      const result = await publishWithRemovals()
      expect(result.run?.failed).not.toBe(true)
      expect(result.removed).toEqual([{ kind: 'page', name: 'old-landing' }])
      expect(result.removalFailures).toEqual([])
      // The site manifest is the render loop's last write.
      const renderIndex = events.indexOf('write:site.json')
      const removeIndex = events.indexOf('rm:pages/old-landing/page.json')
      const sitemapIndex = events.indexOf('write:sitemap.xml')
      const generationIndex = events.indexOf(`write:${PUBLISH_GENERATION_PATH}`)
      expect(renderIndex).toBeGreaterThan(-1)
      expect(removeIndex).toBeGreaterThan(renderIndex)
      expect(sitemapIndex).toBeGreaterThan(removeIndex)
      expect(generationIndex).toBeGreaterThan(sitemapIndex)
      expect(purgeCalls).toEqual(['purgeAll'])
      expect(await innerTarget.exists('pages/old-landing/index.html')).toBe(false)
    })

    it('keep a removed page out of sitemap.xml when the listing still returns its sidecar', async () => {
      innerTarget.seed(goneFolder)
      // R2 listings can lag deletes: sidecar deletes leave the files listed.
      const lagging = {
        ...targetStorage,
        rm: async (path: string) => (/\/\.(pub-|[0-9a-f]{8}\.hash)/.test(path) ? undefined : innerTarget.rm(path)),
      } as StorageProvider
      await publishWithRemovals({ storage: lagging })
      expect(await innerTarget.exists('pages/old-landing/.pub-20260417T220000Z')).toBe(true)
      const sitemap = await innerTarget.readFile('sitemap.xml')
      expect(sitemap).toContain(`/${pageName()}`)
      expect(sitemap).not.toContain('/old-landing')
    })

    it('a removals-only call records history, writes the generated files and the generation, and purges', async () => {
      innerTarget.seed(goneFolder)
      const result = await publishWithRemovals({ items: [] })
      expect(result.run?.failed).not.toBe(true)
      expect(result.removed).toHaveLength(1)
      expect(events).toContain(`write:${PUBLISH_GENERATION_PATH}`)
      expect(purgeCalls).toEqual(['purgeAll'])
      const history = createHistoryProvider({ storage: innerTarget })
      const publishes = (await history.listRevisions()).filter(r => r.operation === 'publish')
      expect(publishes).toHaveLength(1)
      const rev = await history.readRevision(publishes[0]!.id)
      expect(Object.keys(rev.snapshot)).not.toContain('pages/old-landing/page.json')
      expect(Object.keys(rev.snapshot)).not.toContain('pages/old-landing/page.fr.json')
    })

    it('leave no snapshot entry for removed manifests that the baseline had', async () => {
      innerTarget.seed(goneFolder)
      // A first publish records the baseline, which includes old-landing.
      await publish(stagingConfig())
      const history = createHistoryProvider({ storage: innerTarget })
      const first = (await history.listRevisions()).filter(r => r.operation === 'publish')
      const firstRev = await history.readRevision(first[first.length - 1]!.id)
      expect(Object.keys(firstRev.snapshot)).toContain('pages/old-landing/page.json')

      await publishWithRemovals()
      const revisions = (await history.listRevisions()).filter(r => r.operation === 'publish')
      expect(revisions).toHaveLength(2)
      const latest = revisions.reduce((a, b) => (a.id > b.id ? a : b))
      const rev = await history.readRevision(latest.id)
      expect(Object.keys(rev.snapshot)).toContain(`pages/${pageName()}/page.json`)
      expect(Object.keys(rev.snapshot)).not.toContain('pages/old-landing/page.json')
      expect(Object.keys(rev.snapshot)).not.toContain('pages/old-landing/page.fr.json')
    })

    it('do not run when the render run fails', async () => {
      innerTarget.seed(goneFolder)
      const failing = {
        ...targetStorage,
        writeFile: async (path: string, content: string) => {
          if (path.endsWith('.html')) throw new Error('render write exploded')
          return innerTarget.writeFile(path, content)
        },
      } as StorageProvider
      const result = await publishWithRemovals({ storage: failing })
      expect(result.run?.failed).toBe(true)
      expect(result.removed).toEqual([])
      expect(events.filter(e => e.startsWith('rm:pages/old-landing'))).toEqual([])
      for (const path of Object.keys(goneFolder)) expect(await innerTarget.exists(path)).toBe(true)
    })

    it('report an invalid ref as a failure without touching any file', async () => {
      innerTarget.seed(goneFolder)
      const result = await publishToTarget({
        targetName: 'staging',
        targetStorage,
        targetConfig: stagingConfig(),
        snapshot,
        sourceName: 'local',
        siteManifest: manifest,
        items: [],
        itemRefs: [],
        templateInfos,
        purgeScope: 'all',
        removals: [{ kind: 'page', name: 'old-landing', locale: '../x' }],
      })
      expect(result.removed).toEqual([])
      expect(result.removalFailures).toHaveLength(1)
      expect(events.filter(e => e.startsWith('rm:pages/'))).toEqual([])
    })

    it('refuse to remove an item this run also publishes', async () => {
      const result = await publishToTarget({
        targetName: 'staging',
        targetStorage,
        targetConfig: stagingConfig(),
        snapshot,
        sourceName: 'local',
        siteManifest: manifest,
        items: [`pages/${pageName()}`],
        itemRefs: [{ kind: 'page', name: pageName() }],
        templateInfos,
        purgeScope: 'all',
        removals: [{ kind: 'page', name: pageName() }],
      })
      expect(result.removed).toEqual([])
      expect(result.removalFailures).toEqual([
        { ref: { kind: 'page', name: pageName() }, reason: 'also published in this run' },
      ])
      expect(await innerTarget.exists(`pages/${pageName()}/page.json`)).toBe(true)
    })
  })
})

describe('publishToTarget: one snapshot per publish (#1632)', () => {
  let tmp: string
  let sourceDir: string
  let manifest: SiteManifest
  let templateInfos: TemplateInfo[]
  let target: MemoryStorage

  beforeEach(async () => {
    tmp = await mkdtemp('.tmp-publish-snapshot-')
    sourceDir = join(tmp, 'local')
    await cp(starterTargetDir, sourceDir, { recursive: true })
    manifest = await starterManifest()
    templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
    target = memoryStorage()
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const take = () =>
    createPublishSnapshot({
      contentRoot: createContentRoot(createFilesystemProvider(sourceDir), ''),
      manifest,
      templatesDir: starterTemplatesDir,
    })
  const publish = (
    snapshot: PublishSnapshot,
    names: string[],
    type: 'esi' | 'static' = 'static',
    fragments: string[] = [],
  ) =>
    publishToTarget({
      // The starter's `staging` is static and its `esi-test` composes at request time.
      targetName: type === 'static' ? 'staging' : 'esi-test',
      targetStorage: target,
      targetConfig: {
        ...manifest.targets![type === 'static' ? 'staging' : 'esi-test'],
        storage: target,
        publicStorage: false,
      } as TargetConfig,
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: [...names.map(n => `pages/${n}`), ...fragments.map(f => `fragments/${f}`)],
      itemRefs: [
        ...names.map(name => ({ kind: 'page' as const, name })),
        ...fragments.map(name => ({ kind: 'fragment' as const, name })),
      ],
      templateInfos,
      purgeScope: 'all',
    })
  const revisionText = async (path: string) => {
    const history = createHistoryProvider({ storage: target })
    const [rev] = (await history.listRevisions()).filter(r => r.operation === 'publish')
    const snap = (await history.readRevision(rev!.id)).snapshot
    return snap[path] ? new TextDecoder().decode(await history.readBlob(snap[path])) : undefined
  }
  const aboutPath = () => join(sourceDir, 'pages/about/page.json')

  it("doesn't publish a save that lands after the snapshot", async () => {
    const before = await readFile(aboutPath(), 'utf8')
    const snapshot = await take()
    const edited = JSON.parse(before)
    edited.metadata = { ...edited.metadata, title: 'Saved during the publish' }
    await writeFile(aboutPath(), JSON.stringify(edited))

    const result = await publish(snapshot, ['about'])
    expect(result.run?.failed).not.toBe(true)
    expect(await target.readFile('pages/about/page.json')).toBe(before)
    expect(await revisionText('pages/about/page.json')).toBe(before)
    expect(await target.readFile('about/index.html')).not.toContain('Saved during the publish')

    // The newer save shows as an unpublished change.
    const { compareTargets } = await import('../src/compare.js')
    const cmp = await compareTargets({
      sourceRoot: createContentRoot(createFilesystemProvider(sourceDir), ''),
      target,
      templatesDir: starterTemplatesDir,
      projectRoot: starterProjectRoot,
      type: 'static',
      scanTemplates: async () => templateInfos,
      manifest,
    })
    expect(cmp.modified).toContain('pages/about')
  })

  it('copies the snapshot’s raw text, fields the loader drops included', async () => {
    const raw = JSON.stringify({ ...JSON.parse(await readFile(aboutPath(), 'utf8')), unlisted: { keep: true } })
    await writeFile(aboutPath(), raw)
    const snapshot = await take()
    await publish(snapshot, ['about'])
    expect(await target.readFile('pages/about/page.json')).toBe(raw)
    expect(await revisionText('pages/about/page.json')).toBe(raw)
    expect(await target.readFile('pages/about/page.fr.json')).toBe(
      await readFile(join(sourceDir, 'pages/about/page.fr.json'), 'utf8'),
    )
  })

  it('copies asset manifests as the snapshot holds them', async () => {
    const assetManifest = join(sourceDir, 'assets/test-pattern.asset.json')
    const snapshotText = await readFile(assetManifest, 'utf8')
    const snapshot = await take()
    await writeFile(assetManifest, JSON.stringify({ ...JSON.parse(snapshotText), alt: 'Edited during the publish' }))
    await publish(snapshot, ['asset-demo'])
    expect(await target.readFile('assets/test-pattern.asset.json')).toBe(snapshotText)
  })

  it('leaves out the pages using an asset whose files went during the publish, and publishes the rest', async () => {
    const snapshot = await take()
    await rm(join(sourceDir, 'assets/test-pattern-2092f9b7.jpg'))
    const result = await publish(snapshot, ['asset-demo', 'about'])
    expect(result.run?.failed).not.toBe(true)
    expect(result.notPublished).toEqual([{ kind: 'page', name: 'asset-demo', assets: ['test-pattern'] }])
    expect(await target.exists('pages/asset-demo/page.json')).toBe(false)
    expect(await target.exists('asset-demo/index.html')).toBe(false)
    expect(await revisionText('pages/asset-demo/page.json')).toBeUndefined()
    expect(await target.exists('pages/about/page.json')).toBe(true)
    expect(await target.exists('assets/test-pattern-2092f9b7.jpg')).toBe(false)
  })

  it('keeps the previous version of a page left out that way', async () => {
    await publish(await take(), ['asset-demo'])
    const published = await target.readFile('pages/asset-demo/page.json')
    const html = await target.readFile('asset-demo/index.html')
    const demo = join(sourceDir, 'pages/asset-demo/page.json')
    await writeFile(demo, JSON.stringify({ ...JSON.parse(await readFile(demo, 'utf8')), metadata: { title: 'New' } }))
    const snapshot = await take()
    await rm(join(sourceDir, 'assets/test-pattern-2092f9b7.jpg'))
    const result = await publish(snapshot, ['asset-demo'])
    expect(result.notPublished.map(n => n.name)).toEqual(['asset-demo'])
    expect(await target.readFile('pages/asset-demo/page.json')).toBe(published)
    expect(await target.readFile('asset-demo/index.html')).toBe(html)
  })

  it('on a static target, also leaves out a page that bakes a fragment using that asset', async () => {
    await mkdir(join(sourceDir, 'fragments/promo'), { recursive: true })
    await writeFile(
      join(sourceDir, 'fragments/promo/fragment.json'),
      JSON.stringify({
        template: 'asset-hero',
        content: { image: { _asset: 'test-pattern' }, headline: 'Promo' },
      }),
    )
    const about = JSON.parse(await readFile(aboutPath(), 'utf8'))
    about.components = [...(about.components ?? []), '@promo']
    await writeFile(aboutPath(), JSON.stringify(about))
    const snapshot = await take()
    await rm(join(sourceDir, 'assets/test-pattern-2092f9b7.jpg'))

    const staticResult = await publish(snapshot, ['about', 'home'], 'static')
    expect(staticResult.notPublished.map(n => n.name)).toEqual(['about'])

    target = memoryStorage()
    const esiResult = await publish(snapshot, ['about', 'home'], 'esi', ['promo'])
    expect(esiResult.notPublished).toEqual([{ kind: 'fragment', name: 'promo', assets: ['test-pattern'] }])
  })

  it('still fails the target for an asset that had no manifest when the snapshot was taken', async () => {
    await rm(join(sourceDir, 'assets/test-pattern.asset.json'))
    const snapshot = await take()
    await writeFile(join(sourceDir, 'assets/test-pattern.asset.json'), '{}')
    const result = await publish(snapshot, ['asset-demo'])
    expect(result.run?.failed).toBe(true)
    expect(result.run?.failureReason).toContain('missing test-pattern')
  })
})
