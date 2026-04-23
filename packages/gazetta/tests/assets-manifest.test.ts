import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AssetManifestCorruptError, AssetManifestNotFoundError } from '../src/assets/errors.js'
import { assetBytesPath, manifestPath, readManifest, writeManifest } from '../src/assets/manifest.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { AssetManifest } from '../src/schema/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('manifest-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function sampleManifest(overrides: Partial<AssetManifest> = {}): AssetManifest {
  return {
    version: 1,
    name: 'hero',
    kind: 'embedded',
    source: 'internal',
    mime: 'image/jpeg',
    size: 12345,
    hash: 'a3b2c1d4',
    width: 1920,
    height: 1080,
    variants: [],
    alt: 'Mountain sunset',
    uploadedAt: '2026-04-21T12:00:00.000Z',
    uploadedBy: '',
    ...overrides,
  }
}

describe('manifestPath + assetBytesPath', () => {
  it('manifestPath returns `{name}.asset.json`', () => {
    expect(manifestPath('hero')).toBe('hero.asset.json')
  })

  it('assetBytesPath assembles name + hash + ext', () => {
    expect(assetBytesPath('hero', 'a3b2c1d4', 'jpg')).toBe('hero-a3b2c1d4.jpg')
    expect(assetBytesPath('hero', 'a3b2c1d4', '.jpg')).toBe('hero-a3b2c1d4.jpg')
  })
})

describe('readManifest / writeManifest round-trip', () => {
  it('writes and reads back an identical manifest', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    const manifest = sampleManifest()
    await writeManifest(fs, 'assets', manifest)
    const read = await readManifest(fs, 'assets', 'hero')
    expect(read).toEqual(manifest)
  })

  it('preserves null fields', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)

    const manifest = sampleManifest({ alt: null, width: null, height: null })
    await writeManifest(fs, 'assets', manifest)
    const read = await readManifest(fs, 'assets', 'hero')
    expect(read.alt).toBeNull()
    expect(read.width).toBeNull()
    expect(read.height).toBeNull()
  })
})

describe('readManifest — error paths', () => {
  it('throws AssetManifestNotFoundError when the file is missing', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)
    await expect(readManifest(fs, 'assets', 'no-such')).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('throws AssetManifestCorruptError when JSON is malformed', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    await writeFile(join(testDir, 'assets/broken.asset.json'), 'not json at all')

    const fs = createFilesystemProvider(testDir)
    await expect(readManifest(fs, 'assets', 'broken')).rejects.toBeInstanceOf(AssetManifestCorruptError)
  })

  it('throws AssetManifestCorruptError when JSON parses but shape is wrong', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    await writeFile(join(testDir, 'assets/shape-wrong.asset.json'), JSON.stringify({ version: 1, name: 'x' }))

    const fs = createFilesystemProvider(testDir)
    await expect(readManifest(fs, 'assets', 'shape-wrong')).rejects.toBeInstanceOf(AssetManifestCorruptError)
  })
})
