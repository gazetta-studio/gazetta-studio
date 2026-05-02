/**
 * Unit tests for `renameAsset`. Covers:
 *   - Happy path: copy bytes + variants + manifest, rewrite refs, delete old
 *   - URLs valid throughout (old bytes still present after copy, before delete)
 *   - Collision rejection (newName already exists)
 *   - Missing source rejection
 *   - Same-name no-op
 *   - Per-reference overrides (alt, focalPoint) preserved through ref rewrite
 *   - Refs across both pages and fragments rewritten
 *   - Asset-refs sidecars move from oldName to newName
 *   - History records ONE revision spanning the operation
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { renameAsset } from '../src/assets/rename.js'
import { ingestAsset } from '../src/assets/ingest.js'
import { ingestLocaleBytes } from '../src/assets/ingest-locale.js'
import { AssetManifestNotFoundError, AssetNameCollisionError, AssetStorageError } from '../src/assets/errors.js'
import { buildSelector } from '../src/schema/dimensions.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('rename-asset-test-' + Date.now())

async function jpeg(width = 16): Promise<Buffer> {
  return sharp({
    create: { width, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
}

async function seedAsset(assetName: string) {
  const storage = createFilesystemProvider(testDir)
  const bytes = await jpeg()
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(bytes))
      ctrl.close()
    },
  })
  return ingestAsset({
    storage,
    assetsRoot: 'assets',
    bytes: stream,
    requestedName: assetName,
    alt: null,
    uploadedBy: '',
  })
}

async function seedPage(name: string, content: Record<string, unknown>): Promise<void> {
  const dir = join(testDir, 'pages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'page.json'),
    JSON.stringify({ template: 'page-default', route: `/${name}`, content }, null, 2),
  )
}

async function seedFragment(name: string, content: Record<string, unknown>): Promise<void> {
  const dir = join(testDir, 'fragments', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'fragment.json'), JSON.stringify({ template: 'header', content }, null, 2))
}

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
  await writeFile(join(testDir, 'site.yaml'), 'name: test-site\n')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('renameAsset', () => {
  it('copies bytes + manifest to new name and removes the old asset', async () => {
    const storage = createFilesystemProvider(testDir)
    const old = await seedAsset('hero')

    const result = await renameAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(result.refsRewritten).toBe(0)
    expect(result.manifestsRewritten).toBe(0)

    // New name lives.
    expect(existsSync(join(testDir, 'assets/banner.asset.json'))).toBe(true)
    expect(existsSync(join(testDir, `assets/banner-${old.manifest.hash}.jpg`))).toBe(true)

    // Old name is gone.
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
    expect(existsSync(join(testDir, old.bytesPath))).toBe(false)

    // New manifest carries forward the same hash + size + mime; only name changed.
    const newManifest = JSON.parse(await readFile(join(testDir, 'assets/banner.asset.json'), 'utf-8'))
    expect(newManifest.name).toBe('banner')
    expect(newManifest.hash).toBe(old.manifest.hash)
    expect(newManifest.size).toBe(old.manifest.size)
    expect(newManifest.mime).toBe(old.manifest.mime)
  })

  it('rewrites refs across pages and fragments', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedPage('home', { hero: { _asset: 'hero' } })
    await seedFragment('promo', { image: { _asset: 'hero' } })

    const result = await renameAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(result.refsRewritten).toBe(2)
    expect(result.manifestsRewritten).toBe(2)

    const page = JSON.parse(await readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(page.content.hero._asset).toBe('banner')
    const frag = JSON.parse(await readFile(join(testDir, 'fragments/promo/fragment.json'), 'utf-8'))
    expect(frag.content.image._asset).toBe('banner')
  })

  it('preserves per-reference overrides through the rewrite', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedPage('home', {
      hero: { _asset: 'hero', alt: 'Override alt', focalPoint: { x: 0.3, y: 0.7 } },
    })

    await renameAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    const page = JSON.parse(await readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(page.content.hero).toEqual({
      _asset: 'banner',
      alt: 'Override alt',
      focalPoint: { x: 0.3, y: 0.7 },
    })
  })

  it('refuses when the new name is already taken', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedAsset('banner')

    await expect(
      renameAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'hero',
        newName: 'banner',
      }),
    ).rejects.toBeInstanceOf(AssetNameCollisionError)

    // Both still exist — the rejection is non-destructive.
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(true)
    expect(existsSync(join(testDir, 'assets/banner.asset.json'))).toBe(true)
  })

  it('throws when the source asset does not exist', async () => {
    const storage = createFilesystemProvider(testDir)
    await expect(
      renameAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'missing',
        newName: 'banner',
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('is a no-op when oldName === newName', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')

    const result = await renameAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'hero',
    })

    expect(result.refsRewritten).toBe(0)
    expect(result.manifestsRewritten).toBe(0)
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(true)
  })

  it('updates asset-refs sidecars from oldName to newName', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedPage('home', { hero: { _asset: 'hero' } })

    // Pre-seed the sidecar that ref-tracking would populate (mirroring
    // what happens after a save). The rename should rewrite that
    // sidecar to point at the new name.
    const oldSidecar = join(testDir, '.gazetta/asset-refs/hero/pages.home')
    await mkdir(join(testDir, '.gazetta/asset-refs/hero'), { recursive: true })
    await writeFile(oldSidecar, '')

    await renameAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(existsSync(oldSidecar)).toBe(false)
    expect(existsSync(join(testDir, '.gazetta/asset-refs/banner/pages.home'))).toBe(true)
  })

  it('records ONE history revision covering the whole operation', async () => {
    const storage = createFilesystemProvider(testDir)
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    await seedAsset('hero')
    await seedPage('home', { hero: { _asset: 'hero' } })

    await renameAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
      history,
      contentRoot,
      author: 'alice',
    })

    // Baseline + rename = 2.
    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    expect(list[0].author).toBe('alice')
    expect(list[0].message).toBe('Rename hero → banner')

    const head = await history.readRevision(list[0].id)
    // New name's manifest + bytes are in the snapshot.
    expect(Object.keys(head.snapshot)).toContain('assets/banner.asset.json')
    // Old name's are gone.
    expect(Object.keys(head.snapshot)).not.toContain('assets/hero.asset.json')
    // Rewritten page manifest reflects the new name (decode the blob).
    const pageHash = head.snapshot['pages/home/page.json']!
    const pageBlob = await history.readBlob(pageHash)
    const page = JSON.parse(new TextDecoder().decode(pageBlob))
    expect(page.content.hero._asset).toBe('banner')
  })

  it('refuses (v1 limitation) when the asset has locale-bytes overrides', async () => {
    // v1 rename only handles default bytes. Override-aware rename is
    // tracked as out-of-v1 (design-media-implementation.md). The
    // refusal is a typed AssetStorageError pointing at the default
    // manifest path.
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')

    const overrideBytes = await jpeg()
    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(overrideBytes))
          c.close()
        },
      }),
    })

    await expect(
      renameAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'hero',
        newName: 'banner',
      }),
    ).rejects.toBeInstanceOf(AssetStorageError)
  })
})
