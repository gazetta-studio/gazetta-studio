/**
 * Unit tests for `deleteAsset`. Covers the happy path (0 refs → deletes),
 * the blocked path (refs exist → AssetInUseError), and the missing-manifest
 * path (AssetManifestNotFoundError).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { deleteAsset } from '../src/assets/delete.js'
import { ingestAsset } from '../src/assets/ingest.js'
import { AssetInUseError, AssetManifestNotFoundError } from '../src/assets/errors.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('delete-asset-test-' + Date.now())

async function jpeg(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
}

async function seedAsset(assetName: string, width = 16, height = 16) {
  const storage = createFilesystemProvider(testDir)
  const bytes = await jpeg(width, height)
  // Wrap the Buffer in a web ReadableStream so ingestAsset can consume it.
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(bytes))
      ctrl.close()
    },
  })
  const result = await ingestAsset({
    storage,
    assetsRoot: 'assets',
    bytes: stream,
    requestedName: assetName,
    alt: null,
    uploadedBy: '',
  })
  return { storage, result }
}

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
  // Minimum site.yaml — loadSite needs something to chew on.
  await writeFile(join(testDir, 'site.yaml'), 'name: test-site\n')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('deleteAsset', () => {
  it('deletes the manifest and bytes when no refs exist', async () => {
    const { storage, result } = await seedAsset('hero')

    // Sanity: both files exist before delete.
    expect(existsSync(join(testDir, result.bytesPath))).toBe(true)
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(true)

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
    })

    expect(existsSync(join(testDir, result.bytesPath))).toBe(false)
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
  })

  it('throws AssetInUseError when a page references the asset', async () => {
    const { storage } = await seedAsset('hero')

    // Drop a page that references "hero".
    await mkdir(join(testDir, 'pages/home'), { recursive: true })
    await writeFile(
      join(testDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/',
        content: { hero: { _asset: 'hero' } },
      }),
    )

    const promise = deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
    })

    await expect(promise).rejects.toBeInstanceOf(AssetInUseError)
    await promise.catch((err: AssetInUseError) => {
      expect(err.code).toBe('ASSET_IN_USE')
      expect(err.assetName).toBe('hero')
      expect(err.refs).toHaveLength(1)
      expect(err.refs[0]).toMatchObject({
        source: 'page',
        path: 'pages/home/page.json',
        componentPath: 'hero',
      })
    })

    // Asset files are untouched when delete is refused.
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(true)
  })

  it('throws AssetInUseError when a fragment references the asset', async () => {
    const { storage } = await seedAsset('hero')

    await mkdir(join(testDir, 'fragments/promo'), { recursive: true })
    await writeFile(
      join(testDir, 'fragments/promo/fragment.json'),
      JSON.stringify({
        template: 'promo',
        content: { image: { _asset: 'hero' } },
      }),
    )

    await expect(
      deleteAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        assetName: 'hero',
      }),
    ).rejects.toBeInstanceOf(AssetInUseError)
  })

  it('throws AssetManifestNotFoundError when the asset does not exist', async () => {
    const storage = createFilesystemProvider(testDir)
    await expect(
      deleteAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        assetName: 'nothing',
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('succeeds when refs exist to OTHER assets (not the one being deleted)', async () => {
    const { storage, result } = await seedAsset('hero')

    await mkdir(join(testDir, 'pages/home'), { recursive: true })
    await writeFile(
      join(testDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/',
        content: { other: { _asset: 'banner' } },
      }),
    )

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
    })

    expect(existsSync(join(testDir, result.bytesPath))).toBe(false)
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
  })

  it('tolerates pre-deleted bytes (idempotent-ish for partial cleanup)', async () => {
    const { storage, result } = await seedAsset('hero')

    // Simulate manual cleanup of just the bytes — delete should still complete.
    await rm(join(testDir, result.bytesPath))

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
    })

    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
  })

  it('removes variant bytes along with primary bytes and manifest', async () => {
    // 1000×500 produces 400w and 800w variants.
    const { storage, result } = await seedAsset('hero', 1000, 500)
    expect(result.manifest.variants.length).toBeGreaterThan(0)

    // Sanity: every variant is on disk.
    for (const v of result.manifest.variants) {
      expect(existsSync(join(testDir, 'assets', v.path))).toBe(true)
    }

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
    })

    // Every variant is gone.
    for (const v of result.manifest.variants) {
      expect(existsSync(join(testDir, 'assets', v.path))).toBe(false)
    }
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
  })
})

describe('deleteAsset — history recording', () => {
  it('records a revision marking the manifest + bytes as deleted', async () => {
    const { storage, result } = await seedAsset('hero')
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
      history,
      contentRoot,
      author: 'alice',
    })

    // First-call baseline + the delete revision = 2.
    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    expect(list[0].operation).toBe('save')
    expect(list[0].author).toBe('alice')
    expect(list[0].message).toBe('Delete hero')
    // Snapshot drops the deleted paths (baseline had them; delete removes).
    const head = await history.readRevision(list[0].id)
    expect(Object.keys(head.snapshot)).not.toContain('assets/hero.asset.json')
    expect(Object.keys(head.snapshot)).not.toContain(result.bytesPath)
  })

  it('skips history recording when no provider is passed', async () => {
    const { storage } = await seedAsset('hero')
    const history = createHistoryProvider({ storage })

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
      // history NOT passed
    })

    expect(await history.listRevisions()).toEqual([])
  })
})
