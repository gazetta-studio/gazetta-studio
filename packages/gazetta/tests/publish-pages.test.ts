/**
 * publishPage tests — Cut 4.
 *
 * Page-specific wrapper: mode resolution from target.type + archive
 * state. Spine behavior covered by publish-item.test.ts; this file
 * focuses on dispatch decisions.
 */
import { describe, expect, it } from 'vitest'
import { publishPage, resolvePageRenderMode } from '../src/pages/publish.js'
import type { PublishTarget } from '../src/publish-item.js'
import { createContentRoot } from '../src/content-root.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

async function loadStarterSite(): Promise<Site> {
  const storage = createFilesystemProvider(starterTargetDir)
  const contentRoot = createContentRoot(storage, '')
  const manifest = await starterManifest()
  return loadSite({ contentRoot, templatesDir: starterTemplatesDir, manifest })
}

function makeTarget(storage: MemoryStorage, type: PublishTarget['type'] = 'esi'): PublishTarget {
  return { name: 'test', storage, type }
}

describe('resolvePageRenderMode — pure dispatch', () => {
  it('archived page → archive-marker regardless of target type', () => {
    expect(resolvePageRenderMode({ archived: true }, 'static')).toBe('archive-marker')
    expect(resolvePageRenderMode({ archived: true }, 'esi')).toBe('archive-marker')
    expect(resolvePageRenderMode({ archived: true }, 'dynamic')).toBe('archive-marker')
  })

  it('live page on esi target → page-rendered', () => {
    expect(resolvePageRenderMode({}, 'esi')).toBe('page-rendered')
  })

  it('live page on static target → page-static', () => {
    expect(resolvePageRenderMode({}, 'static')).toBe('page-static')
  })

  it('live page on dynamic target → page-static (origin handles fragments)', () => {
    expect(resolvePageRenderMode({}, 'dynamic')).toBe('page-static')
  })
})

describe('publishPage — wrapper', () => {
  it('returns NOT_FOUND when page missing from site', async () => {
    const site = await loadStarterSite()
    const result = await publishPage({
      name: 'no-such-page',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(memoryStorage()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })

  it('publishes a starter page on esi target → page-rendered mode', async () => {
    const site = await loadStarterSite()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const result = await publishPage({
      name: pageName,
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, 'esi'),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('page-rendered')
  })

  it('publishes a starter page on static target → page-static mode', async () => {
    const site = await loadStarterSite()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const result = await publishPage({
      name: pageName,
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, 'static'),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('page-static')
  })

  it('archived page on any target → archive-marker mode', async () => {
    const site = await loadStarterSite()
    const sample = [...site.pages.values()][0]!
    site.pages.set('archived-test', { ...sample, archived: true, aliasOf: 'home' })
    const targetStorage = memoryStorage()
    const result = await publishPage({
      name: 'archived-test',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, 'esi'),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('archive-marker')
  })

  it('preserves locale through to spine', async () => {
    const site = await loadStarterSite()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const result = await publishPage({
      name: pageName,
      locale: 'fr',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, 'esi'),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.locale).toBe('fr')
    expect(await targetStorage.exists(`pages/${pageName}/index.fr.html`)).toBe(true)
  })
})
