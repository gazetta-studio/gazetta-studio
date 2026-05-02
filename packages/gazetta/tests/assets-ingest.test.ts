import { afterEach, describe, expect, it } from 'vitest'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { AssetValidationError } from '../src/assets/errors.js'
import { ingestAsset } from '../src/assets/ingest.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('ingest-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

async function jpegBuffer(w = 64, h = 48): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
}

async function pngBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
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

describe('ingestAsset — happy path', () => {
  it('persists bytes and writes a manifest for a valid JPEG upload', async () => {
    const storage = createFilesystemProvider(testDir)
    const bytes = await jpegBuffer(100, 50)

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'hero',
      alt: 'Test hero',
      uploadedBy: '',
    })

    // Manifest fields
    expect(result.manifest.name).toBe('hero')
    expect(result.manifest.kind).toBe('embedded')
    expect(result.manifest.source).toBe('internal')
    expect(result.manifest.mime).toBe('image/jpeg')
    expect(result.manifest.size).toBe(bytes.byteLength)
    expect(result.manifest.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(result.manifest.width).toBe(100)
    expect(result.manifest.height).toBe(50)
    expect(result.manifest.alt).toBe('Test hero')
    expect(result.manifest.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Bytes landed at the expected path
    expect(result.bytesPath).toBe(`assets/hero-${result.manifest.hash}.jpg`)
    const onDisk = await readFile(join(testDir, result.bytesPath))
    expect(Buffer.compare(onDisk, bytes)).toBe(0)

    // Manifest written next to bytes
    const manifestOnDisk = JSON.parse(await readFile(join(testDir, 'assets/hero.asset.json'), 'utf-8'))
    expect(manifestOnDisk.hash).toBe(result.manifest.hash)
  })

  it('handles PNG with dimensions', async () => {
    const storage = createFilesystemProvider(testDir)
    const bytes = await pngBuffer()

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'icon',
      alt: null,
      uploadedBy: '',
    })

    expect(result.manifest.mime).toBe('image/png')
    expect(result.manifest.width).toBe(32)
    expect(result.manifest.height).toBe(32)
    expect(result.manifest.alt).toBeNull()
    expect(result.bytesPath.endsWith('.png')).toBe(true)
  })

  it('strips client-supplied extension from the canonical name', async () => {
    const storage = createFilesystemProvider(testDir)
    const bytes = await jpegBuffer()

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'hero.jpg',
      alt: null,
      uploadedBy: '',
    })

    expect(result.manifest.name).toBe('hero')
    // The byte file gets the MIME-derived extension, not the client-sent one.
    expect(result.bytesPath).toBe(`assets/hero-${result.manifest.hash}.jpg`)
  })

  it('writes only the target files — no temp leftovers', async () => {
    const storage = createFilesystemProvider(testDir)
    const bytes = await jpegBuffer()

    await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'clean',
      alt: null,
      uploadedBy: '',
    })

    const entries = await readdir(join(testDir, 'assets'))
    // exactly two files: the bytes and the manifest (source is 64×48 — below
    // the 400px variant floor, so no variants are generated)
    expect(entries).toHaveLength(2)
    expect(entries.some(n => n.startsWith('clean-') && n.endsWith('.jpg'))).toBe(true)
    expect(entries).toContain('clean.asset.json')
  })
})

describe('ingestAsset — variant generation', () => {
  it('generates responsive variants for a large-enough source JPEG', async () => {
    const storage = createFilesystemProvider(testDir)
    // 1000×500 — above 400w and 800w, below 1200w and 1600w.
    const bytes = await jpegBuffer(1000, 500)

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'hero',
      alt: null,
      uploadedBy: '',
    })

    // Manifest records the variants, ordered ascending by width.
    expect(result.manifest.variants.map(v => v.width)).toEqual([400, 800])
    for (const v of result.manifest.variants) {
      expect(v.path).toMatch(new RegExp(`^hero-${result.manifest.hash}-\\d+w\\.jpg$`))
      expect(v.size).toBeGreaterThan(0)
      // Each variant is on disk.
      const onDisk = await readFile(join(testDir, 'assets', v.path))
      expect(onDisk.byteLength).toBe(v.size)
    }
  })

  it('generates no variants when the source is smaller than the smallest target', async () => {
    const storage = createFilesystemProvider(testDir)
    // 100×100 source — below every variant width.
    const bytes = await jpegBuffer(100, 100)

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'tiny',
      alt: null,
      uploadedBy: '',
    })

    expect(result.manifest.variants).toEqual([])
  })

  it('variant paths use width suffix matching the design-doc scheme', async () => {
    const storage = createFilesystemProvider(testDir)
    const bytes = await jpegBuffer(1000, 500)

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'banner',
      alt: null,
      uploadedBy: '',
    })

    // Shape: `{name}-{hash}-{width}w.{ext}` per design-media.md
    const paths = result.manifest.variants.map(v => v.path)
    expect(paths).toContain(`banner-${result.manifest.hash}-400w.jpg`)
    expect(paths).toContain(`banner-${result.manifest.hash}-800w.jpg`)
  })
})

describe('ingestAsset — rejects invalid input', () => {
  it('rejects an unsupported MIME (WebP) with ASSET_MIME_MISMATCH', async () => {
    const storage = createFilesystemProvider(testDir)
    const webp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .webp()
      .toBuffer()

    await expect(
      ingestAsset({
        storage,
        assetsRoot: 'assets',
        bytes: streamOf(new Uint8Array(webp)),
        requestedName: 'rejected',
        alt: null,
        uploadedBy: '',
      }),
    ).rejects.toMatchObject({ code: 'ASSET_MIME_MISMATCH' })
  })

  it('rejects garbage bytes (no magic-byte match)', async () => {
    const storage = createFilesystemProvider(testDir)
    const garbage = new TextEncoder().encode('this is plain text, nothing else')

    await expect(
      ingestAsset({
        storage,
        assetsRoot: 'assets',
        bytes: streamOf(garbage),
        requestedName: 'garbage',
        alt: null,
        uploadedBy: '',
      }),
    ).rejects.toBeInstanceOf(AssetValidationError)
  })

  it('rejects a path-traversal name', async () => {
    const storage = createFilesystemProvider(testDir)
    const bytes = await jpegBuffer()

    await expect(
      ingestAsset({
        storage,
        assetsRoot: 'assets',
        bytes: streamOf(new Uint8Array(bytes)),
        requestedName: '../etc/passwd',
        alt: null,
        uploadedBy: '',
      }),
    ).rejects.toMatchObject({ code: 'ASSET_PATH_TRAVERSAL' })
  })
})

describe('ingestAsset — history recording', () => {
  it('records a revision per upload when history is provided', async () => {
    const storage = createFilesystemProvider(testDir)
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(await jpegBuffer())),
      requestedName: 'hero',
      alt: null,
      uploadedBy: '',
      history,
      contentRoot,
      author: 'alice',
    })

    // recordWrite emits a baseline on the first call, so:
    //   listRevisions = [upload, baseline]
    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    expect(list[0].operation).toBe('save')
    expect(list[0].author).toBe('alice')
    expect(list[0].message).toBe('Upload hero')
  })

  it('captures manifest + primary bytes + variants in one revision', async () => {
    const storage = createFilesystemProvider(testDir)
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    // 1200×600 — large enough that variants get generated.
    const bytes = await sharp({ create: { width: 1200, height: 600, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer()

    const result = await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(bytes)),
      requestedName: 'big',
      alt: null,
      uploadedBy: '',
      history,
      contentRoot,
    })

    const list = await history.listRevisions()
    const upload = await history.readRevision(list[0].id)
    // Snapshot covers manifest + primary bytes + every variant.
    const expected = new Set<string>([
      'assets/big.asset.json',
      result.bytesPath,
      ...result.manifest.variants.map(v => `assets/${v.path}`),
    ])
    for (const path of expected) {
      expect(Object.keys(upload.snapshot)).toContain(path)
    }
    // Variants count should be > 0 to make this test meaningful.
    expect(result.manifest.variants.length).toBeGreaterThan(0)
  })

  it('skips history recording when no provider is passed', async () => {
    const storage = createFilesystemProvider(testDir)
    const history = createHistoryProvider({ storage })

    await ingestAsset({
      storage,
      assetsRoot: 'assets',
      bytes: streamOf(new Uint8Array(await jpegBuffer())),
      requestedName: 'hero',
      alt: null,
      uploadedBy: '',
      // history NOT passed
    })

    expect(await history.listRevisions()).toEqual([])
  })

  it('throws when history is set but contentRoot is missing', async () => {
    const storage = createFilesystemProvider(testDir)
    const history = createHistoryProvider({ storage })

    await expect(
      ingestAsset({
        storage,
        assetsRoot: 'assets',
        bytes: streamOf(new Uint8Array(await jpegBuffer())),
        requestedName: 'hero',
        alt: null,
        uploadedBy: '',
        history,
        // contentRoot intentionally omitted
      }),
    ).rejects.toThrow(/contentRoot/)
  })
})
