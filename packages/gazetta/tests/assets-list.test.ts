import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listAssets } from '../src/assets/list.js'
import { writeManifest } from '../src/assets/manifest.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { AssetManifest } from '../src/schema/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('list-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function sampleManifest(overrides: Partial<AssetManifest>): AssetManifest {
  return {
    version: 1,
    name: 'placeholder',
    kind: 'embedded',
    source: 'internal',
    mime: 'image/jpeg',
    size: 1000,
    hash: 'aaaaaaaa',
    width: 100,
    height: 100,
    alt: null,
    uploadedAt: '2026-04-21T00:00:00.000Z',
    uploadedBy: '',
    ...overrides,
  }
}

describe('listAssets', () => {
  it('returns empty array when assets directory does not exist', async () => {
    await mkdir(testDir, { recursive: true })
    const fs = createFilesystemProvider(testDir)
    expect(await listAssets({ storage: fs, assetsRoot: 'assets' })).toEqual([])
  })

  it('returns empty array when assets directory is empty', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    const fs = createFilesystemProvider(testDir)
    expect(await listAssets({ storage: fs, assetsRoot: 'assets' })).toEqual([])
  })

  it('lists all asset manifests, ignoring non-manifest files', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await writeManifest(fs, 'assets', sampleManifest({ name: 'hero', hash: 'aaaaaaaa' }))
    await writeManifest(fs, 'assets', sampleManifest({ name: 'logo', hash: 'bbbbbbbb' }))
    // Non-manifest files should be ignored
    await writeFile(join(testDir, 'assets/hero-aaaaaaaa.jpg'), Buffer.from([0xff, 0xd8]))
    await writeFile(join(testDir, 'assets/logo-bbbbbbbb.png'), Buffer.from([0x89, 0x50]))

    const summaries = await listAssets({ storage: fs, assetsRoot: 'assets' })
    expect(summaries).toHaveLength(2)
    expect(summaries.map(s => s.name).sort()).toEqual(['hero', 'logo'])
  })

  it('sorts most-recent-first by uploadedAt', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await writeManifest(fs, 'assets', sampleManifest({ name: 'older', uploadedAt: '2026-04-20T00:00:00.000Z' }))
    await writeManifest(fs, 'assets', sampleManifest({ name: 'newer', uploadedAt: '2026-04-21T00:00:00.000Z' }))

    const summaries = await listAssets({ storage: fs, assetsRoot: 'assets' })
    expect(summaries.map(s => s.name)).toEqual(['newer', 'older'])
  })

  it('returns summary shape (not full manifest)', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await writeManifest(fs, 'assets', sampleManifest({ name: 'hero', alt: 'Mountain', uploadedBy: 'alice' }))

    const [summary] = await listAssets({ storage: fs, assetsRoot: 'assets' })
    expect(summary).toEqual({
      name: 'hero',
      kind: 'embedded',
      mime: 'image/jpeg',
      size: 1000,
      hash: 'aaaaaaaa',
      width: 100,
      height: 100,
      alt: 'Mountain',
      uploadedAt: '2026-04-21T00:00:00.000Z',
    })
    // uploadedBy should NOT be in the summary
    expect('uploadedBy' in summary).toBe(false)
  })

  it('skips corrupt manifests, logs a warning, continues listing', async () => {
    await mkdir(join(testDir, 'assets'), { recursive: true })
    const fs = createFilesystemProvider(testDir)

    await writeManifest(fs, 'assets', sampleManifest({ name: 'good' }))
    await writeFile(join(testDir, 'assets/bad.asset.json'), 'not json at all')

    const origWarn = console.warn
    const warnings: string[] = []
    console.warn = (msg: string) => warnings.push(msg)

    try {
      const summaries = await listAssets({ storage: fs, assetsRoot: 'assets' })
      expect(summaries).toHaveLength(1)
      expect(summaries[0].name).toBe('good')
      expect(warnings.some(w => w.includes('bad'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})
