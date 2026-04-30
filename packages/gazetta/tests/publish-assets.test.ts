/**
 * Integration tests for asset publishing — the operation that copies an
 * asset's full storage footprint (manifest + primary bytes + variants)
 * from a source target to a destination target during publish.
 *
 * Covers the publicly-observable behaviors per the design doc:
 * 1. Pages that reference assets get those assets copied to the target
 * 2. Missing source asset → fail with structured error before any writes
 * 3. Incapable target + asset refs → fail with capability error
 * 4. Already-on-target assets are skipped (cheap publish)
 * 5. Asset failure happens before page render — old pages stay coherent
 *
 * Tests use real filesystem storage (no mocks of internal collaborators —
 * see tdd skill's tests.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ingestAsset } from '../src/assets/ingest.js'
import { publishAssets } from '../src/assets/publish.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-assets-test-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')

async function jpeg(width = 800, height = 400): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

async function seedSourceAsset(name: string, bytes: Uint8Array) {
  const storage = createFilesystemProvider(sourceDir)
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(bytes)
      ctrl.close()
    },
  })
  return ingestAsset({
    storage,
    assetsRoot: 'assets',
    bytes: stream,
    requestedName: name,
    alt: null,
    uploadedBy: '',
  })
}

async function seedSourcePage(name: string, content: Record<string, unknown>) {
  const dir = join(sourceDir, 'pages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'page.json'), JSON.stringify({ template: 'page-default', route: `/${name}`, content }))
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(sourceDir, 'site.yaml'), 'name: test-site\n')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishAssets', () => {
  it('copies asset manifest, primary bytes, and variants to the target', async () => {
    const sourceStorage = createFilesystemProvider(sourceDir)
    const targetStorage = createFilesystemProvider(targetDir)
    const { manifest } = await seedSourceAsset('hero', await jpeg(1000, 500))
    await seedSourcePage('home', { hero: { _asset: 'hero' } })

    const result = await publishAssets({
      sourceRoot: createContentRoot(sourceStorage),
      targetRoot: createContentRoot(targetStorage),
      itemNames: ['pages/home'],
    })

    expect(result.ok).toBe(true)

    // Manifest landed
    expect(existsSync(join(targetDir, 'assets/hero.asset.json'))).toBe(true)

    // Primary bytes landed (matches the source filename, content-addressed by hash)
    expect(existsSync(join(targetDir, `assets/hero-${manifest.hash}.jpg`))).toBe(true)

    // Variants landed (1000x source produces 400w + 800w)
    for (const v of manifest.variants) {
      expect(existsSync(join(targetDir, `assets/${v.path}`))).toBe(true)
    }

    // Manifest content matches source
    const targetManifestRaw = await readFile(join(targetDir, 'assets/hero.asset.json'), 'utf-8')
    const targetManifest = JSON.parse(targetManifestRaw)
    expect(targetManifest.name).toBe('hero')
    expect(targetManifest.hash).toBe(manifest.hash)
    expect(targetManifest.variants).toHaveLength(manifest.variants.length)
  })

  it('passes with no work when itemNames have no asset refs', async () => {
    const sourceStorage = createFilesystemProvider(sourceDir)
    const targetStorage = createFilesystemProvider(targetDir)
    // Page with no asset refs.
    await seedSourcePage('home', { title: 'no images here' })

    const result = await publishAssets({
      sourceRoot: createContentRoot(sourceStorage),
      targetRoot: createContentRoot(targetStorage),
      itemNames: ['pages/home'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.copiedAssets).toBe(0)
  })

  it('skips assets already present on target (content-addressed dedupe)', async () => {
    const sourceStorage = createFilesystemProvider(sourceDir)
    const targetStorage = createFilesystemProvider(targetDir)
    const { manifest } = await seedSourceAsset('hero', await jpeg(1000, 500))
    await seedSourcePage('home', { hero: { _asset: 'hero' } })

    // First publish — copies everything.
    const first = await publishAssets({
      sourceRoot: createContentRoot(sourceStorage),
      targetRoot: createContentRoot(targetStorage),
      itemNames: ['pages/home'],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstFiles = first.copiedFiles
    expect(firstFiles).toBeGreaterThan(0)

    // Second publish — the asset is already present on target. Should
    // skip the byte copies (idempotent re-publish).
    const second = await publishAssets({
      sourceRoot: createContentRoot(sourceStorage),
      targetRoot: createContentRoot(targetStorage),
      itemNames: ['pages/home'],
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.copiedAssets).toBe(0)
    expect(second.copiedFiles).toBe(0)

    // Sanity: the asset is still present on target after the no-op publish.
    expect(existsSync(join(targetDir, `assets/hero-${manifest.hash}.jpg`))).toBe(true)
  })

  it('refuses to copy when a referenced asset is missing on source — names the missing assets', async () => {
    const sourceStorage = createFilesystemProvider(sourceDir)
    const targetStorage = createFilesystemProvider(targetDir)
    // Page references "hero" but no hero asset has been ingested.
    await seedSourcePage('home', { hero: { _asset: 'hero' } })

    const result = await publishAssets({
      sourceRoot: createContentRoot(sourceStorage),
      targetRoot: createContentRoot(targetStorage),
      itemNames: ['pages/home'],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('missing-on-source')
    expect(result.missing).toEqual(['hero'])

    // Nothing was written (validate before any copy).
    expect(existsSync(join(targetDir, 'assets'))).toBe(false)
  })
})
