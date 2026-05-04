/**
 * Unit tests covering the locale-bytes ingest path:
 *   - enumerateAssetStoragePaths discovers locale + theme overrides on disk
 *   - ingestLocaleBytes writes a locale-bytes override (manifest + bytes + variants)
 *   - removeOverride deletes a single override slice cleanly
 *   - delete cascades through overrides (extra paths picked up by enumeration)
 *
 * The full happy-path of default-only ingest is in assets-ingest.test.ts;
 * here we only cover the locale-specific behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { deleteAsset } from '../src/assets/delete.js'
import { enumerateAssetStoragePaths } from '../src/assets/asset-paths.js'
import { ingestAsset } from '../src/assets/ingest.js'
import { ingestLocaleBytes } from '../src/assets/ingest-locale.js'
import { readManifest } from '../src/assets/manifest.js'
import { removeOverride } from '../src/assets/remove-override.js'
import { AssetManifestNotFoundError } from '../src/assets/errors.js'
import { buildSelector } from '../src/schema/dimensions.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('locale-bytes-test-' + Date.now())

async function jpeg(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
}

async function png(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer()
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

async function seedDefaultAsset(name: string) {
  const storage = createFilesystemProvider(testDir)
  const bytes = await jpeg()
  return ingestAsset({
    storage,
    assetsRoot: 'assets',
    bytes: streamOf(new Uint8Array(bytes)),
    requestedName: name,
    alt: null,
    uploadedBy: '',
  })
}

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('ingestLocaleBytes', () => {
  it('writes a locale manifest, bytes, and variants for an existing default asset', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedDefaultAsset('hero')

    const overrideBytes = await jpeg(20, 20) // different dims to confirm per-locale dims
    const result = await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(overrideBytes)),
    })

    // Locale manifest exists.
    expect(existsSync(join(testDir, 'assets/hero.asset.fr.json'))).toBe(true)
    // Locale bytes exist at {name}-{hash}.{locale}.{ext}.
    expect(existsSync(join(testDir, `assets/hero-${result.manifest.hash}.fr.jpg`))).toBe(true)

    // Default is unaffected.
    const defaultManifest = await readManifest(storage, 'assets', 'hero')
    expect(defaultManifest.name).toBe('hero')
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(true)

    // Override manifest carries its own dims.
    expect(result.manifest.width).toBe(20)
    expect(result.manifest.height).toBe(20)
    expect(result.manifest.size).toBe(overrideBytes.byteLength)
  })

  it('allows MIME variation within the same kind category (jpeg default + png override)', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedDefaultAsset('hero')

    const result = await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await png())),
    })

    expect(result.manifest.mime).toBe('image/png')
    // Default is still jpeg.
    expect((await readManifest(storage, 'assets', 'hero')).mime).toBe('image/jpeg')
  })

  it('throws AssetManifestNotFoundError when default asset is missing', async () => {
    const storage = createFilesystemProvider(testDir)
    await expect(
      ingestLocaleBytes({
        storage,
        assetsRoot: 'assets',
        assetName: 'ghost',
        selector: buildSelector({ locale: 'fr' })!,
        bytes: streamOf(new Uint8Array(await jpeg())),
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('records ONE history revision spanning the override write', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedDefaultAsset('hero')
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
      history,
      contentRoot,
      author: 'alice',
    })

    // Baseline + the locale upload = 2.
    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    expect(list[0].author).toBe('alice')
    expect(list[0].message).toMatch(/Upload hero override/)
  })
})

describe('enumerateAssetStoragePaths', () => {
  it('returns empty overrides when no locale variants exist', async () => {
    const storage = createFilesystemProvider(testDir)
    const { manifest } = await seedDefaultAsset('hero')

    const paths = await enumerateAssetStoragePaths(storage, 'assets', manifest)
    expect(paths.overrides).toEqual([])
    expect(paths.defaultManifest).toBe('assets/hero.asset.json')
  })

  it('discovers a locale-bytes override on disk', async () => {
    const storage = createFilesystemProvider(testDir)
    const { manifest } = await seedDefaultAsset('hero')
    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })

    const paths = await enumerateAssetStoragePaths(storage, 'assets', manifest)
    expect(paths.overrides).toHaveLength(1)
    const override = paths.overrides[0]!
    expect(override.selector.get('locale')).toBe('fr')
    expect(override.manifest).toBe('assets/hero.asset.fr.json')
    expect(override.bytes).not.toBeNull()
    expect(override.bytes!.endsWith('.fr.jpg')).toBe(true)
  })

  it('sorts overrides deterministically by selector', async () => {
    const storage = createFilesystemProvider(testDir)
    const { manifest } = await seedDefaultAsset('hero')

    // Land overrides in non-alphabetical order to test the sort.
    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })
    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'ar' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })
    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'de' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })

    const paths = await enumerateAssetStoragePaths(storage, 'assets', manifest)
    const locales = paths.overrides.map(s => s.selector.get('locale'))
    expect(locales).toEqual(['ar', 'de', 'fr'])
  })

  it('returns empty overrides when the assets dir does not exist', async () => {
    const storage = createFilesystemProvider(testDir)
    const { manifest } = await seedDefaultAsset('hero')
    // Fresh manifest with a different name → readDir on missing path
    // shouldn't throw, returns empty.
    const fakeManifest = { ...manifest, name: 'ghost' }
    const paths = await enumerateAssetStoragePaths(storage, 'nonexistent-root', fakeManifest)
    expect(paths.overrides).toEqual([])
  })
})

describe('removeOverride', () => {
  it('removes the locale manifest, bytes, and variants of one override', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedDefaultAsset('hero')
    const overrideResult = await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })

    expect(existsSync(join(testDir, 'assets/hero.asset.fr.json'))).toBe(true)
    expect(existsSync(join(testDir, overrideResult.bytesPath))).toBe(true)

    await removeOverride({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
    })

    // Override gone.
    expect(existsSync(join(testDir, 'assets/hero.asset.fr.json'))).toBe(false)
    expect(existsSync(join(testDir, overrideResult.bytesPath))).toBe(false)
    // Default still present.
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(true)
  })

  it('throws AssetManifestNotFoundError when the override does not exist', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedDefaultAsset('hero')

    await expect(
      removeOverride({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        assetName: 'hero',
        selector: buildSelector({ locale: 'fr' })!,
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('records ONE history revision for the removal', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedDefaultAsset('hero')
    await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })

    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    await removeOverride({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      history,
      contentRoot,
      author: 'alice',
    })

    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    expect(list[0].author).toBe('alice')
    expect(list[0].message).toMatch(/Remove hero override/)
  })
})

describe('deleteAsset cascades through overrides', () => {
  it('removes locale-bytes overrides when the default asset is deleted', async () => {
    const storage = createFilesystemProvider(testDir)
    const { bytesPath } = await seedDefaultAsset('hero')
    const overrideResult = await ingestLocaleBytes({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' })!,
      bytes: streamOf(new Uint8Array(await jpeg())),
    })

    await deleteAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      assetName: 'hero',
    })

    expect(existsSync(join(testDir, bytesPath))).toBe(false)
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
    expect(existsSync(join(testDir, overrideResult.bytesPath))).toBe(false)
    expect(existsSync(join(testDir, 'assets/hero.asset.fr.json'))).toBe(false)
  })
})
