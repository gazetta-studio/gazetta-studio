/**
 * publishFragment tests — Cut 4.
 *
 * Fragment-specific wrapper. Simpler than page (no per-target-type
 * mode resolution; archive short-circuit is the only branch).
 */
import { describe, expect, it } from 'vitest'
import { publishFragment, resolveFragmentRenderMode } from '../src/fragments/publish.js'
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

describe('resolveFragmentRenderMode — pure dispatch', () => {
  it('archived fragment → archive-marker', () => {
    expect(resolveFragmentRenderMode({ archived: true })).toBe('archive-marker')
  })

  it('live fragment → fragment-rendered', () => {
    expect(resolveFragmentRenderMode({})).toBe('fragment-rendered')
  })
})

describe('publishFragment — wrapper', () => {
  it('returns NOT_FOUND when fragment missing', async () => {
    const site = await loadStarterSite()
    const result = await publishFragment({
      name: 'no-such-fragment',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(memoryStorage()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })

  it('publishes a starter fragment → fragment-rendered mode', async () => {
    const site = await loadStarterSite()
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return
    const targetStorage = memoryStorage()
    const result = await publishFragment({
      name: fragName,
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('fragment-rendered')
    expect(await targetStorage.exists(`fragments/${fragName}/index.html`)).toBe(true)
  })

  it('archived fragment → archive-marker mode regardless of target type', async () => {
    const site = await loadStarterSite()
    const sample = [...site.fragments.values()][0]
    if (!sample) return
    site.fragments.set('archived-frag', { ...sample, archived: true, aliasOf: 'header' })
    const targetStorage = memoryStorage()
    const result = await publishFragment({
      name: 'archived-frag',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, 'static'),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('archive-marker')
  })

  it('preserves locale through to spine', async () => {
    const site = await loadStarterSite()
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return
    const targetStorage = memoryStorage()
    const result = await publishFragment({
      name: fragName,
      locale: 'fr',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.locale).toBe('fr')
    expect(await targetStorage.exists(`fragments/${fragName}/index.fr.html`)).toBe(true)
  })
})
