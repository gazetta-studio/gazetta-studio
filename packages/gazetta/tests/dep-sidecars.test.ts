/**
 * Unit tests for the generic dep-sidecars primitives.
 *
 * Covers:
 *   - Filename encoding round-trip (incl. locale, subfolder names)
 *   - readDepsFor on missing dir returns []
 *   - applyDepDiff write/remove diff
 *   - rebuildItemDeps convenience over the diff
 *   - forward records: readDepRecord / replaceItemDeps / removeItemDeps
 *   - The asset-deps binding (via ASSET_REFS relation) so the asset-side
 *     wrapper isn't separately tested
 *
 * Filesystem-backed because the encoding rules are filename-shape and
 * the diff exercises real readDir + writeFile semantics.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import {
  applyDepDiff,
  depSidecarPath,
  filenameToItemRef,
  itemRefToFilename,
  readDepsFor,
  readDepRecord,
  rebuildItemDeps,
  removeItemDeps,
  replaceItemDeps,
  type DepRelation,
  type ItemRef,
} from '../src/dep-sidecars.js'
import { ASSET_REFS, itemRefToAssetRef } from '../src/assets/asset-deps.js'
import { tempDir } from './_helpers/temp.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const testDir = tempDir(`dep-sidecars-${Date.now()}`)

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('itemRefToFilename + filenameToItemRef — round-trip encoding', () => {
  const cases: ItemRef[] = [
    { source: 'page', name: 'home' },
    { source: 'page', name: 'home', locale: 'fr' },
    { source: 'page', name: 'blog/[slug]' },
    { source: 'page', name: 'blog/[slug]', locale: 'ar' },
    { source: 'fragment', name: 'header' },
    { source: 'fragment', name: 'header', locale: 'ja' },
    { source: 'fragment', name: 'nested/header', locale: 'pt-br' },
  ]
  for (const ref of cases) {
    it(`round-trips ${JSON.stringify(ref)}`, () => {
      const fname = itemRefToFilename(ref)
      const parsed = filenameToItemRef(fname)
      expect(parsed).toEqual(ref)
    })
  }

  it('returns null for filenames that do not match the encoding shape', () => {
    expect(filenameToItemRef('garbage')).toBeNull()
    expect(filenameToItemRef('pages')).toBeNull() // missing name
    expect(filenameToItemRef('.hidden')).toBeNull()
  })
})

// All read/write tests parameterize over the asset-refs relation. The
// generic API doesn't care which relation it operates on, and asset-refs
// is the one we ship today; future relations get covered by their own
// callers' integration tests.
const REL: DepRelation = ASSET_REFS

describe('readDepsFor', () => {
  it('returns [] when the relation directory does not exist', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    expect(await readDepsFor(REL, root, 'never-indexed')).toEqual([])
  })

  it('returns parsed refs from sidecar files in the dir', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const relRoot = `.gazetta/${REL.rootName}/hero`
    const dir = join(testDir, relRoot)
    await mkdir(dir, { recursive: true })
    await Promise.all([
      root.storage.writeFile(`${relRoot}/pages.home`, ''),
      root.storage.writeFile(`${relRoot}/pages.about:fr`, ''),
      root.storage.writeFile(`${relRoot}/fragments.header`, ''),
    ])
    const refs = await readDepsFor(REL, root, 'hero')
    expect(refs).toHaveLength(3)
    expect(refs).toContainEqual({ source: 'page', name: 'home' })
    expect(refs).toContainEqual({ source: 'page', name: 'about', locale: 'fr' })
    expect(refs).toContainEqual({ source: 'fragment', name: 'header' })
  })

  it('skips files whose names do not match the encoding shape', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const relRoot = `.gazetta/${REL.rootName}/hero`
    const dir = join(testDir, relRoot)
    await mkdir(dir, { recursive: true })
    await Promise.all([
      root.storage.writeFile(`${relRoot}/pages.home`, ''),
      root.storage.writeFile(`${relRoot}/.DS_Store`, ''),
      root.storage.writeFile(`${relRoot}/random-junk`, ''),
    ])
    const refs = await readDepsFor(REL, root, 'hero')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toEqual({ source: 'page', name: 'home' })
  })
})

describe('applyDepDiff', () => {
  it('writes sidecars for added targets, removes for dropped ones', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }

    // Initial state: refs to hero only.
    await applyDepDiff(REL, root, item, new Set(), new Set(['hero']))
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'hero', item)))).toBe(true)

    // Now references hero + banner; removes hero, adds banner.
    await applyDepDiff(REL, root, item, new Set(['hero']), new Set(['banner']))
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'hero', item)))).toBe(false)
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'banner', item)))).toBe(true)
  })

  it('is a no-op when old and new sets are equal', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await applyDepDiff(REL, root, item, new Set(['hero']), new Set(['hero']))
    // Sidecar should NOT exist — neither side flagged it for write.
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'hero', item)))).toBe(false)
  })

  it('is idempotent under concurrent writes to the same path', async () => {
    // Two adds to the same (item, target) pair race. Final state has the
    // sidecar present once. This is the multi-instance correctness story.
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await Promise.all([
      applyDepDiff(REL, root, item, new Set(), new Set(['hero'])),
      applyDepDiff(REL, root, item, new Set(), new Set(['hero'])),
    ])
    const refs = await readDepsFor(REL, root, 'hero')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toEqual(item)
  })
})

describe('rebuildItemDeps (manifest-driven diff)', () => {
  it('extracts target names from manifests via rel.extract and applies the diff', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }

    const oldManifest = {
      template: 'page-default',
      content: { hero: { _asset: 'hero' } },
      components: [],
    }
    const newManifest = {
      template: 'page-default',
      content: { banner: { _asset: 'banner' } },
      components: [],
    }
    await rebuildItemDeps(REL, root, item, oldManifest, newManifest)

    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'hero', item)))).toBe(false)
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'banner', item)))).toBe(true)
  })

  it('treats null oldManifest as empty (initial save) and writes new deps', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    const manifest = { template: 'p', content: { hero: { _asset: 'hero' } }, components: [] }
    await rebuildItemDeps(REL, root, item, null, manifest)
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'hero', item)))).toBe(true)
  })

  it('treats null newManifest as deletion and removes deps', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    const manifest = { template: 'p', content: { hero: { _asset: 'hero' } }, components: [] }
    // Pre-state: dep exists.
    await rebuildItemDeps(REL, root, item, null, manifest)
    // Now the page is deleted: pass null new.
    await rebuildItemDeps(REL, root, item, manifest, null)
    expect(existsSync(join(testDir, depSidecarPath(REL, root, 'hero', item)))).toBe(false)
  })
})

describe('asset-deps binding: itemRefToAssetRef', () => {
  it('reconstructs an AssetRef from a default-locale page item', () => {
    expect(itemRefToAssetRef({ source: 'page', name: 'home' })).toEqual({
      source: 'page',
      path: 'pages/home/page.json',
      componentPath: null,
    })
  })

  it('encodes locale into the manifest filename', () => {
    expect(itemRefToAssetRef({ source: 'page', name: 'home', locale: 'fr' })).toEqual({
      source: 'page',
      path: 'pages/home/page.fr.json',
      componentPath: null,
    })
  })

  it('handles fragments', () => {
    expect(itemRefToAssetRef({ source: 'fragment', name: 'header' })).toEqual({
      source: 'fragment',
      path: 'fragments/header/fragment.json',
      componentPath: null,
    })
  })
})

describe('encoding edge cases', () => {
  it('encodes subfolder target names in the directory path', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await applyDepDiff(REL, root, item, new Set(), new Set(['products/shot']))
    // products/shot encodes to products.shot — directory at .../{rel}/products.shot/
    const dir = join(testDir, '.gazetta', REL.rootName, 'products.shot')
    expect(existsSync(dir)).toBe(true)
    const entries = await readdir(dir)
    expect(entries).toContain('pages.home')
  })

  it('rejects target names containing dots', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await expect(applyDepDiff(REL, root, item, new Set(), new Set(['bad.name']))).rejects.toThrow(/dot is reserved/)
  })
})

describe('forward records (deps-of)', () => {
  const page = (...assets: string[]) => ({
    template: 'p',
    content: Object.fromEntries(assets.map(a => [a, { _asset: a }])),
    components: [],
  })
  const item: ItemRef = { source: 'page', name: 'home' }
  const recordPath = '.gazetta/deps-of/asset-refs/pages.home'
  const edge = (asset: string, ref: ItemRef = item) => `.gazetta/asset-refs/${asset}/${itemRefToFilename(ref)}`

  function setup() {
    const storage = memoryStorage()
    return { storage, root: createContentRoot(storage, '') }
  }

  it('readDepRecord is null when the record is missing or malformed', async () => {
    const { storage, root } = setup()
    expect(await readDepRecord(REL, root, item)).toBeNull()
    storage.seed({ [recordPath]: 'not json' })
    expect(await readDepRecord(REL, root, item)).toBeNull()
    storage.seed({ [recordPath]: '{"a":1}' })
    expect(await readDepRecord(REL, root, item)).toBeNull()
  })

  it('replaceItemDeps with no record only writes edges, then the record', async () => {
    const { storage, root } = setup()
    storage.seed({ [edge('stale')]: '' }) // an edge no record lists stays
    await replaceItemDeps(REL, root, item, page('hero', 'banner'))
    expect(await storage.exists(edge('hero'))).toBe(true)
    expect(await storage.exists(edge('banner'))).toBe(true)
    expect(await storage.exists(edge('stale'))).toBe(true)
    expect(await readDepRecord(REL, root, item)).toEqual(new Set(['banner', 'hero']))
  })

  it('replaceItemDeps drops the edges the record lists that the new manifest lacks', async () => {
    const { storage, root } = setup()
    await replaceItemDeps(REL, root, item, page('hero', 'banner'))
    await replaceItemDeps(REL, root, item, page('banner', 'logo'))
    expect(await storage.exists(edge('hero'))).toBe(false)
    expect(await storage.exists(edge('banner'))).toBe(true)
    expect(await storage.exists(edge('logo'))).toBe(true)
    expect(await readDepRecord(REL, root, item)).toEqual(new Set(['banner', 'logo']))
  })

  it('replaceItemDeps reads the record, never a stored manifest', async () => {
    const { storage, root } = setup()
    // The record says the item uses `hero`, whatever any manifest says.
    storage.seed({ [recordPath]: '["hero"]', [edge('hero')]: '', 'pages/home/page.json': JSON.stringify(page('x')) })
    await replaceItemDeps(REL, root, item, page('banner'))
    expect(await storage.exists(edge('hero'))).toBe(false)
    expect(await storage.exists(edge('x'))).toBe(false)
    expect(await storage.exists(edge('banner'))).toBe(true)
  })

  it('replaceItemDeps is idempotent when rerun', async () => {
    const { storage, root } = setup()
    await replaceItemDeps(REL, root, item, page('hero'))
    const snapshot = () => new Map([...storage.dump()].map(([k, v]) => [k, new TextDecoder().decode(v)]))
    const before = snapshot()
    await replaceItemDeps(REL, root, item, page('hero'))
    expect(snapshot()).toEqual(before)
  })

  it('locale variants keep their own edges and record', async () => {
    const { storage, root } = setup()
    const fr: ItemRef = { source: 'page', name: 'home', locale: 'fr' }
    await replaceItemDeps(REL, root, item, page('hero'))
    await replaceItemDeps(REL, root, fr, page('hero-fr'))
    expect(await readDepRecord(REL, root, item)).toEqual(new Set(['hero']))
    expect(await readDepRecord(REL, root, fr)).toEqual(new Set(['hero-fr']))
    expect(await storage.exists('.gazetta/deps-of/asset-refs/pages.home:fr')).toBe(true)
    expect(await storage.exists(edge('hero-fr', fr))).toBe(true)
    expect(await storage.exists(edge('hero-fr'))).toBe(false)
  })

  it('removeItemDeps deletes exactly the recorded edges, then the record', async () => {
    const { storage, root } = setup()
    const other: ItemRef = { source: 'page', name: 'about' }
    await replaceItemDeps(REL, root, item, page('hero'))
    await replaceItemDeps(REL, root, other, page('hero'))
    storage.seed({ [edge('unrecorded')]: '' })
    await removeItemDeps(REL, root, item)
    expect(await storage.exists(edge('hero'))).toBe(false)
    expect(await storage.exists(edge('hero', other))).toBe(true)
    expect(await storage.exists(edge('unrecorded'))).toBe(true)
    expect(await storage.exists(recordPath)).toBe(false)
  })

  it('rebuildItemDeps writes the record with the new set and deletes it with the item', async () => {
    const { storage, root } = setup()
    await rebuildItemDeps(REL, root, item, null, page('hero'))
    expect(await readDepRecord(REL, root, item)).toEqual(new Set(['hero']))
    await rebuildItemDeps(REL, root, item, page('hero'), page('banner'))
    expect(await readDepRecord(REL, root, item)).toEqual(new Set(['banner']))
    await rebuildItemDeps(REL, root, item, page('banner'), null)
    expect(await storage.exists(recordPath)).toBe(false)
  })

  it('an item whose name has a dot gets no edges and no record', async () => {
    const { storage, root } = setup()
    const dotted: ItemRef = { source: 'page', name: 'release.notes' }
    await replaceItemDeps(REL, root, dotted, page('hero'))
    await rebuildItemDeps(REL, root, dotted, null, page())
    await removeItemDeps(REL, root, dotted)
    expect(await readDepRecord(REL, root, dotted)).toBeNull()
    expect(storage.dump().size).toBe(0)
  })

  it('applyDepDiff records the new target set', async () => {
    const { root } = setup()
    await applyDepDiff(REL, root, item, new Set(['hero']), new Set(['banner']))
    expect(await readDepRecord(REL, root, item)).toEqual(new Set(['banner']))
  })
})
