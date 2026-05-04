/**
 * Unit tests for `updateAssetMetadata` — the asset-domain operation
 * behind PATCH /api/assets/:name. Covers the three-state alt model,
 * no-op patches, history recording, and the absent-vs-explicit-null
 * distinction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ingestAsset } from '../src/assets/ingest.js'
import { readManifest } from '../src/assets/manifest.js'
import { updateAssetMetadata } from '../src/assets/update-metadata.js'
import { AssetManifestNotFoundError } from '../src/assets/errors.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('update-metadata-test-' + Date.now())

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg()
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

async function seedAsset(name: string, alt: string | null = null) {
  const storage = createFilesystemProvider(testDir)
  const bytes = await jpeg()
  return ingestAsset({
    storage,
    assetsRoot: 'assets',
    bytes: streamOf(new Uint8Array(bytes)),
    requestedName: name,
    alt,
    uploadedBy: '',
  })
}

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('updateAssetMetadata', () => {
  it('sets alt to a meaningful description', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')

    const updated = await updateAssetMetadata({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: { alt: 'Mountain sunset' },
    })
    expect(updated.alt).toBe('Mountain sunset')

    const reread = await readManifest(storage, 'assets', 'hero')
    expect(reread.alt).toBe('Mountain sunset')
  })

  it('clears alt to null on explicit null patch', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero', 'has alt')

    const updated = await updateAssetMetadata({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: { alt: null },
    })
    expect(updated.alt).toBeNull()
  })

  it('sets alt to "" on explicit empty string (decorative)', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')

    const updated = await updateAssetMetadata({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: { alt: '' },
    })
    expect(updated.alt).toBe('')
  })

  it('leaves alt unchanged when the patch omits the field', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero', 'preserved')

    const updated = await updateAssetMetadata({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: {}, // no `alt` key at all
    })
    expect(updated.alt).toBe('preserved')
  })

  it('throws AssetManifestNotFoundError on missing asset', async () => {
    const storage = createFilesystemProvider(testDir)
    await expect(
      updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'ghost',
        patch: { alt: 'x' },
      }),
    ).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('records a history revision when alt changes', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    await updateAssetMetadata({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: { alt: 'new alt' },
      history,
      contentRoot,
      author: 'alice',
    })

    // Baseline + the metadata update = 2.
    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    expect(list[0].author).toBe('alice')
    expect(list[0].message).toMatch(/Update metadata for hero/)
  })

  it('does NOT record history when the patch is a no-op', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero', 'unchanged')
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    await updateAssetMetadata({
      storage,
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: { alt: 'unchanged' },
      history,
      contentRoot,
    })

    // No revisions should have been written for a no-op — we'd have
    // only the baseline if anything else triggered it, but this test
    // is the first write so the recorder shouldn't have fired at all.
    expect(await history.listRevisions()).toHaveLength(0)
  })

  it('history requires contentRoot — throws otherwise', async () => {
    const storage = createFilesystemProvider(testDir)
    await seedAsset('hero')
    const history = createHistoryProvider({ storage })

    await expect(
      updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { alt: 'x' },
        history,
        // contentRoot omitted
      }),
    ).rejects.toThrow(/contentRoot/)
  })

  describe('focalPoint patches', () => {
    it('sets focalPoint to a normalized coordinate', async () => {
      const storage = createFilesystemProvider(testDir)
      await seedAsset('hero')

      const updated = await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { focalPoint: { x: 0.3, y: 0.7 } },
      })
      expect(updated.focalPoint).toEqual({ x: 0.3, y: 0.7 })

      const reread = await readManifest(storage, 'assets', 'hero')
      expect(reread.focalPoint).toEqual({ x: 0.3, y: 0.7 })
    })

    it('clears focalPoint on explicit null', async () => {
      const storage = createFilesystemProvider(testDir)
      await seedAsset('hero')

      // First set it.
      await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { focalPoint: { x: 0.5, y: 0.5 } },
      })

      // Then clear.
      const cleared = await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { focalPoint: null },
      })
      expect(cleared.focalPoint).toBeUndefined()
    })

    it('rejects out-of-range focalPoint', async () => {
      const storage = createFilesystemProvider(testDir)
      await seedAsset('hero')

      await expect(
        updateAssetMetadata({
          storage,
          assetsRoot: 'assets',
          assetName: 'hero',
          patch: { focalPoint: { x: 1.5, y: 0.5 } },
        }),
      ).rejects.toThrow(/out of range/)
    })

    it('leaves focalPoint unchanged when omitted from patch', async () => {
      const storage = createFilesystemProvider(testDir)
      await seedAsset('hero')

      // Set initial value.
      await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { focalPoint: { x: 0.25, y: 0.75 } },
      })

      // Patch alt only — focalPoint should survive.
      const updated = await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { alt: 'New alt' },
      })
      expect(updated.focalPoint).toEqual({ x: 0.25, y: 0.75 })
      expect(updated.alt).toBe('New alt')
    })

    it('treats setting the same focalPoint as a no-op', async () => {
      const storage = createFilesystemProvider(testDir)
      await seedAsset('hero')
      await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { focalPoint: { x: 0.5, y: 0.5 } },
      })
      const history = createHistoryProvider({ storage })
      const contentRoot = createContentRoot(storage)

      await updateAssetMetadata({
        storage,
        assetsRoot: 'assets',
        assetName: 'hero',
        patch: { focalPoint: { x: 0.5, y: 0.5 } },
        history,
        contentRoot,
      })

      // No history was recorded — same value, no change.
      expect(await history.listRevisions()).toHaveLength(0)
    })
  })
})
