/**
 * Unit tests for `replaceAsset`. Covers:
 *   - Happy path: rewrite refs across pages + fragments, delete old asset
 *   - Preservation of per-reference overrides (alt, focalPoint) when rewriting
 *   - Kind mismatch rejection
 *   - Missing old / new asset rejection
 *   - Zero-ref case (still deletes old)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { replaceAsset } from '../src/assets/replace.js'
import { ingestAsset } from '../src/assets/ingest.js'
import { AssetKindMismatchError, AssetManifestNotFoundError } from '../src/assets/errors.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { AssetManifest } from '../src/schema/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('replace-asset-test-' + Date.now())

async function jpeg(width = 16): Promise<Buffer> {
  return sharp({
    create: { width, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
}

async function png(width = 16): Promise<Buffer> {
  return sharp({
    create: { width, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
}

async function seedAsset(assetName: string, bytesFn: () => Promise<Buffer> = jpeg) {
  const storage = createFilesystemProvider(testDir)
  const bytes = await bytesFn()
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

/** Overwrite an asset manifest's `kind`/`mime` without re-ingesting. */
async function patchAssetManifest(
  assetName: string,
  changes: Partial<Pick<AssetManifest, 'kind' | 'mime'>>,
): Promise<void> {
  const path = join(testDir, `assets/${assetName}.asset.json`)
  const raw = await readFile(path, 'utf-8')
  const manifest = JSON.parse(raw) as AssetManifest
  Object.assign(manifest, changes)
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
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

describe('replaceAsset', () => {
  it('rewrites refs in a page and deletes the old asset', async () => {
    const storage = createFilesystemProvider(testDir)
    const { result: oldAsset } = { result: await seedAsset('hero') }
    await seedAsset('banner')

    await seedPage('home', { hero: { _asset: 'hero' } })

    const result = await replaceAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(result.refsRewritten).toBe(1)
    expect(result.manifestsRewritten).toBe(1)

    // Old asset gone (manifest + bytes).
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
    expect(existsSync(join(testDir, oldAsset.bytesPath))).toBe(false)

    // New asset untouched.
    expect(existsSync(join(testDir, 'assets/banner.asset.json'))).toBe(true)

    // Page now references `banner`.
    const updated = JSON.parse(await readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(updated.content.hero._asset).toBe('banner')
  })

  it('preserves per-reference overrides (alt, focalPoint) when rewriting', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedAsset('banner')
    await seedPage('home', {
      hero: {
        _asset: 'hero',
        alt: 'A specific override',
        focalPoint: { x: 0.3, y: 0.7 },
      },
    })

    await replaceAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    const updated = JSON.parse(await readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(updated.content.hero._asset).toBe('banner')
    expect(updated.content.hero.alt).toBe('A specific override')
    expect(updated.content.hero.focalPoint).toEqual({ x: 0.3, y: 0.7 })
  })

  it('rewrites refs across multiple manifests (pages + fragments)', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedAsset('banner')
    await seedPage('home', { hero: { _asset: 'hero' } })
    await seedPage('about', { hero: { _asset: 'hero' } })
    await seedFragment('promo', { image: { _asset: 'hero' } })

    const result = await replaceAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(result.refsRewritten).toBe(3)
    expect(result.manifestsRewritten).toBe(3)
  })

  it('succeeds when no refs exist (still deletes the old asset)', async () => {
    const storage = createFilesystemProvider(testDir)
    const { result: oldAsset } = { result: await seedAsset('hero') }
    await seedAsset('banner')

    const result = await replaceAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(result.refsRewritten).toBe(0)
    expect(result.manifestsRewritten).toBe(0)
    expect(existsSync(join(testDir, 'assets/hero.asset.json'))).toBe(false)
    expect(existsSync(join(testDir, oldAsset.bytesPath))).toBe(false)
  })

  it('throws AssetManifestNotFoundError when old asset is missing', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('banner')

    await expect(
      replaceAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'ghost',
        newName: 'banner',
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('throws AssetManifestNotFoundError when new asset is missing', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')

    await expect(
      replaceAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'hero',
        newName: 'ghost',
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('accepts same-kind, same-category replacements across different MIMEs (JPEG → PNG)', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero', jpeg)
    await seedAsset('banner', png)
    await seedPage('home', { hero: { _asset: 'hero' } })

    const result = await replaceAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    expect(result.refsRewritten).toBe(1)
  })

  it('throws AssetKindMismatchError when kind differs', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedAsset('banner')
    // Fake a kind mismatch by rewriting the replacement's manifest.
    // The v1 slice only accepts embedded/image uploads, so we patch
    // the JSON directly to simulate a future downloadable asset.
    await patchAssetManifest('banner', { kind: 'downloadable', mime: 'application/pdf' })

    await expect(
      replaceAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'hero',
        newName: 'banner',
      }),
    ).rejects.toBeInstanceOf(AssetKindMismatchError)
  })

  it('throws AssetKindMismatchError when MIME category differs within embedded', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedAsset('banner')
    // image → video mismatch within the `embedded` kind.
    await patchAssetManifest('banner', { mime: 'video/mp4' })

    await expect(
      replaceAsset({
        storage,
        assetsRoot: 'assets',
        siteDir: '',
        oldName: 'hero',
        newName: 'banner',
      }),
    ).rejects.toBeInstanceOf(AssetKindMismatchError)
  })

  it('does not touch refs to OTHER assets', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    await seedAsset('banner')
    await seedPage('home', {
      hero: { _asset: 'hero' },
      other: { _asset: 'unrelated-asset' },
    })

    await replaceAsset({
      storage,
      assetsRoot: 'assets',
      siteDir: '',
      oldName: 'hero',
      newName: 'banner',
    })

    const updated = JSON.parse(await readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(updated.content.hero._asset).toBe('banner')
    expect(updated.content.other._asset).toBe('unrelated-asset')
  })
})
