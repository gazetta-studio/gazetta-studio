/**
 * Unit tests for asset-refs sidecar primitives.
 *
 * Coverage:
 *   - Filename encoding round-trip (incl. locale, subfolder names)
 *   - readRefsForAsset on missing dir returns []
 *   - applyItemRefsDiff write/remove diff
 *   - rebuildItemRefs convenience over the diff
 *   - itemRefToAssetRef reconstruction
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
  applyItemRefsDiff,
  filenameToItemRef,
  itemRefToFilename,
  itemRefToAssetRef,
  readRefsForAsset,
  rebuildItemRefs,
  refSidecarPath,
  ASSET_REFS_ROOT,
  type ItemRef,
} from '../src/assets/refs-sidecars.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir(`refs-sidecars-${Date.now()}`)

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

describe('readRefsForAsset', () => {
  it('returns [] when the asset directory does not exist', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    expect(await readRefsForAsset(root, 'never-indexed')).toEqual([])
  })

  it('returns parsed refs from sidecar files in the dir', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    // Pre-populate the directory with three sidecar files.
    const dir = join(testDir, ASSET_REFS_ROOT, 'hero')
    await mkdir(dir, { recursive: true })
    await Promise.all([
      root.storage.writeFile(`${ASSET_REFS_ROOT}/hero/pages.home`, ''),
      root.storage.writeFile(`${ASSET_REFS_ROOT}/hero/pages.about:fr`, ''),
      root.storage.writeFile(`${ASSET_REFS_ROOT}/hero/fragments.header`, ''),
    ])
    const refs = await readRefsForAsset(root, 'hero')
    expect(refs).toHaveLength(3)
    expect(refs).toContainEqual({ source: 'page', name: 'home' })
    expect(refs).toContainEqual({ source: 'page', name: 'about', locale: 'fr' })
    expect(refs).toContainEqual({ source: 'fragment', name: 'header' })
  })

  it('skips files whose names do not match the encoding shape', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const dir = join(testDir, ASSET_REFS_ROOT, 'hero')
    await mkdir(dir, { recursive: true })
    await Promise.all([
      root.storage.writeFile(`${ASSET_REFS_ROOT}/hero/pages.home`, ''),
      root.storage.writeFile(`${ASSET_REFS_ROOT}/hero/.DS_Store`, ''),
      root.storage.writeFile(`${ASSET_REFS_ROOT}/hero/random-junk`, ''),
    ])
    const refs = await readRefsForAsset(root, 'hero')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toEqual({ source: 'page', name: 'home' })
  })
})

describe('applyItemRefsDiff', () => {
  it('writes sidecars for added assets, removes for dropped ones', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }

    // Initial state: refs to hero only.
    await applyItemRefsDiff(root, item, new Set(), new Set(['hero']))
    expect(existsSync(join(testDir, refSidecarPath(root, 'hero', item)))).toBe(true)

    // Now references hero + banner; removes hero, adds banner.
    await applyItemRefsDiff(root, item, new Set(['hero']), new Set(['banner']))
    expect(existsSync(join(testDir, refSidecarPath(root, 'hero', item)))).toBe(false)
    expect(existsSync(join(testDir, refSidecarPath(root, 'banner', item)))).toBe(true)
  })

  it('is a no-op when old and new sets are equal', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await applyItemRefsDiff(root, item, new Set(['hero']), new Set(['hero']))
    // Sidecar should NOT exist — neither side flagged it for write.
    expect(existsSync(join(testDir, refSidecarPath(root, 'hero', item)))).toBe(false)
  })

  it('is idempotent under concurrent writes to the same path', async () => {
    // Two adds to the same (item, asset) pair race. Final state has the
    // sidecar present once. This is the multi-instance correctness story.
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await Promise.all([
      applyItemRefsDiff(root, item, new Set(), new Set(['hero'])),
      applyItemRefsDiff(root, item, new Set(), new Set(['hero'])),
    ])
    const refs = await readRefsForAsset(root, 'hero')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toEqual(item)
  })
})

describe('rebuildItemRefs (manifest-driven diff)', () => {
  it('extracts asset names from manifests and applies the diff', async () => {
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
    await rebuildItemRefs(root, item, oldManifest, newManifest)

    expect(existsSync(join(testDir, refSidecarPath(root, 'hero', item)))).toBe(false)
    expect(existsSync(join(testDir, refSidecarPath(root, 'banner', item)))).toBe(true)
  })

  it('treats null oldManifest as empty (initial save) and writes new refs', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await rebuildItemRefs(root, item, null, { content: { hero: { _asset: 'hero' } } })
    expect(existsSync(join(testDir, refSidecarPath(root, 'hero', item)))).toBe(true)
  })

  it('treats null newManifest as deletion and removes refs', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    // Pre-state: ref exists.
    await rebuildItemRefs(root, item, null, { content: { hero: { _asset: 'hero' } } })
    // Now the page is deleted: pass null new.
    await rebuildItemRefs(root, item, { content: { hero: { _asset: 'hero' } } }, null)
    expect(existsSync(join(testDir, refSidecarPath(root, 'hero', item)))).toBe(false)
  })
})

describe('itemRefToAssetRef', () => {
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
  it('encodes subfolder asset names in the directory path', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await applyItemRefsDiff(root, item, new Set(), new Set(['products/shot']))
    // products/shot encodes to products.shot — directory is at .../asset-refs/products.shot/
    const dir = join(testDir, ASSET_REFS_ROOT, 'products.shot')
    expect(existsSync(dir)).toBe(true)
    const entries = await readdir(dir)
    expect(entries).toContain('pages.home')
  })

  it('rejects asset names containing dots', async () => {
    await mkdir(testDir, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(testDir), '')
    const item: ItemRef = { source: 'page', name: 'home' }
    await expect(applyItemRefsDiff(root, item, new Set(), new Set(['bad.name']))).rejects.toThrow(/dot is reserved/)
  })
})
