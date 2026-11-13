/**
 * `replaceAssetBytes` — replacing an asset's file in place
 * (design-media.md M3). Fresh in-memory storage per test.
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { replaceAssetBytes } from '../src/assets/replace-bytes.js'
import { ingestAsset } from '../src/assets/ingest.js'
import { ingestLocaleBytes } from '../src/assets/ingest-locale.js'
import { readManifest } from '../src/assets/manifest.js'
import { AssetKindMismatchError, AssetManifestNotFoundError, AssetStorageError } from '../src/assets/errors.js'
import { buildSelector } from '../src/schema/dimensions.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { restoreRevision } from '../src/history-restorer.js'
import type { StorageProvider } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const ROOT = 'assets'

async function jpeg(width: number, height: number, r = 0): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

/** A minimal PCM WAV: sniffed as audio. */
function wav(): Uint8Array {
  const samples = 64
  const buf = Buffer.alloc(44 + samples)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24)
  buf.writeUInt32LE(8000, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples, 40)
  return new Uint8Array(buf)
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

async function seedHero(storage: MemoryStorage, history?: ReturnType<typeof createHistoryProvider>) {
  const result = await ingestAsset({
    storage,
    assetsRoot: ROOT,
    bytes: stream(await jpeg(900, 600)),
    requestedName: 'hero',
    alt: 'Sunset over the bay',
    uploadedBy: 'alice',
    ...(history ? { history, contentRoot: createContentRoot(storage, '') } : {}),
  })
  // Fields upload doesn't set but the asset may carry.
  const manifest = { ...result.manifest, focalPoint: { x: 0.2, y: 0.7 }, tags: ['nature'], title: 'Hero' }
  storage.seed({ [`${ROOT}/hero.asset.json`]: `${JSON.stringify(manifest, null, 2)}\n` })
  return manifest
}

function seedPage(storage: MemoryStorage, name: string, content: Record<string, unknown>) {
  storage.seed({
    [`pages/${name}/page.json`]: JSON.stringify({ template: 'page-default', route: `/${name}`, content }),
  })
}

function replace(
  storage: StorageProvider,
  bytes: Uint8Array,
  extra: Partial<Parameters<typeof replaceAssetBytes>[0]> = {},
) {
  return replaceAssetBytes({
    storage,
    assetsRoot: ROOT,
    siteDir: '',
    assetName: 'hero',
    bytes: stream(bytes),
    ...extra,
  })
}

function assetFiles(storage: MemoryStorage): string[] {
  return [...storage.dump().keys()].filter(p => p.startsWith(`${ROOT}/`)).sort()
}

describe('replaceAssetBytes', () => {
  it('replaces the byte fields and keeps everything that describes the asset', async () => {
    const storage = memoryStorage()
    const before = await seedHero(storage)

    const { manifest } = await replace(storage, await jpeg(500, 300, 200))

    expect(manifest.hash).not.toBe(before.hash)
    expect([manifest.width, manifest.height]).toEqual([500, 300])
    expect(manifest.variants.map(v => v.width)).toEqual([400])
    expect(manifest).toMatchObject({
      name: 'hero',
      alt: 'Sunset over the bay',
      focalPoint: { x: 0.2, y: 0.7 },
      tags: ['nature'],
      title: 'Hero',
      uploadedAt: before.uploadedAt,
      uploadedBy: 'alice',
    })
    expect(await readManifest(storage, ROOT, 'hero')).toEqual(manifest)
  })

  it('writes the new files and removes the old default bytes and variants', async () => {
    const storage = memoryStorage()
    const before = await seedHero(storage)

    const { manifest } = await replace(storage, await jpeg(500, 300, 200))

    expect(assetFiles(storage)).toEqual(
      [`${ROOT}/hero.asset.json`, `${ROOT}/hero-${manifest.hash}.jpg`, `${ROOT}/${manifest.variants[0]!.path}`].sort(),
    )
    for (const v of before.variants) expect(storage.dump().has(`${ROOT}/${v.path}`)).toBe(false)
    expect(storage.dump().has(`${ROOT}/hero-${before.hash}.jpg`)).toBe(false)
  })

  it('leaves language versions and their bytes untouched', async () => {
    const storage = memoryStorage()
    await seedHero(storage)
    await ingestLocaleBytes({
      storage,
      assetsRoot: ROOT,
      assetName: 'hero',
      selector: buildSelector({ locale: 'fr' }),
      bytes: stream(await jpeg(450, 300, 90)),
    })
    const frFiles = new Map(
      assetFiles(storage)
        .filter(p => p.includes('.fr'))
        .map(p => [p, storage.dump().get(p)]),
    )
    expect(frFiles.size).toBeGreaterThan(1)

    await replace(storage, await jpeg(500, 300, 200))

    for (const [path, bytes] of frFiles) expect(storage.dump().get(path)).toEqual(bytes)
  })

  it('changes no page manifest', async () => {
    const storage = memoryStorage()
    await seedHero(storage)
    seedPage(storage, 'home', { hero: { _asset: 'hero', alt: 'Own alt' } })
    const pageBefore = storage.dump().get('pages/home/page.json')

    await replace(storage, await jpeg(500, 300, 200))

    expect(storage.dump().get('pages/home/page.json')).toEqual(pageBefore)
  })

  it('keeps the old paths when the same bytes are uploaded again', async () => {
    const storage = memoryStorage()
    const bytes = await jpeg(900, 600)
    const before = await seedHero(storage)

    const { manifest } = await replace(storage, bytes)

    expect(manifest.hash).toBe(before.hash)
    expect(storage.dump().has(`${ROOT}/hero-${before.hash}.jpg`)).toBe(true)
    for (const v of before.variants) expect(storage.dump().has(`${ROOT}/${v.path}`)).toBe(true)
  })

  it('refuses a file of another kind and changes nothing', async () => {
    const storage = memoryStorage()
    await seedHero(storage)
    const snapshot = new Map(storage.dump())

    const err = await replace(storage, wav()).catch(e => e)

    expect(err).toBeInstanceOf(AssetKindMismatchError)
    expect(err).toMatchObject({ oldMimeCategory: 'image', newMimeCategory: 'audio' })
    expect(storage.dump()).toEqual(snapshot)
  })

  it('throws AssetManifestNotFoundError for a missing asset', async () => {
    const storage = memoryStorage()
    await expect(replace(storage, await jpeg(500, 300))).rejects.toBeInstanceOf(AssetManifestNotFoundError)
    expect(assetFiles(storage)).toEqual([])
  })

  it('records one revision, and restoring the one before brings the old file back', async () => {
    const storage = memoryStorage()
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage, '')
    const before = await seedHero(storage, history)
    const beforeManifest = await readManifest(storage, ROOT, 'hero')
    const [upload] = await history.listRevisions(1)
    const revisionsBefore = (await history.listRevisions()).length

    await replace(storage, await jpeg(500, 300, 200), { history, contentRoot })

    const revisions = await history.listRevisions()
    expect(revisions.length).toBe(revisionsBefore + 1)
    const head = await history.readRevision(revisions[0]!.id)
    expect(Object.keys(head.snapshot)).not.toContain(`${ROOT}/hero-${before.hash}.jpg`)

    await restoreRevision({ history, contentRoot, revisionId: upload!.id })
    const restored = await readManifest(storage, ROOT, 'hero')
    expect(restored.hash).toBe(before.hash)
    expect(restored.width).toBe(beforeManifest.width)
    expect(storage.dump().has(`${ROOT}/hero-${before.hash}.jpg`)).toBe(true)
  })

  it.each([
    ['no use has its own alt', [{ hero: { _asset: 'hero' } }], 0],
    ['one use has its own alt', [{ hero: { _asset: 'hero', alt: 'Own' } }], 1],
    ['a decorative use counts', [{ hero: { _asset: 'hero', alt: '' } }], 1],
    ['uses of other assets do not count', [{ hero: { _asset: 'other', alt: 'x' } }], 0],
    [
      'nested uses across pages count',
      [{ list: [{ _asset: 'hero', alt: 'a' }] }, { hero: { _asset: 'hero', alt: 'b' } }],
      2,
    ],
  ])('perUseAltCount: %s', async (_label, pages, expected) => {
    const storage = memoryStorage()
    await seedHero(storage)
    pages.forEach((content, i) => seedPage(storage, `p${i}`, content))

    const { perUseAltCount } = await replace(storage, await jpeg(500, 300, 200))

    expect(perUseAltCount).toBe(expected)
  })

  it('counts uses in fragments and translations', async () => {
    const storage = memoryStorage()
    await seedHero(storage)
    seedPage(storage, 'home', { hero: { _asset: 'hero', alt: 'en' } })
    storage.seed({
      'pages/home/page.fr.json': JSON.stringify({
        template: 'page-default',
        content: { hero: { _asset: 'hero', alt: 'fr' } },
      }),
      'fragments/promo/fragment.json': JSON.stringify({
        template: 'header',
        content: { img: { _asset: 'hero', alt: 'x' } },
      }),
    })

    const { perUseAltCount } = await replace(storage, await jpeg(500, 300, 200), {
      manifest: { name: 's', locales: { default: 'en', supported: ['en', 'fr'] } },
    })

    expect(perUseAltCount).toBe(3)
  })

  it('removes the new files and leaves the asset untouched when a write fails', async () => {
    const storage = memoryStorage()
    await seedHero(storage)
    const snapshot = new Map(storage.dump())
    let calls = 0
    const failing: StorageProvider = {
      ...storage,
      async writeStream(path, s) {
        calls++
        if (calls === 2) throw new Error('disk full')
        return storage.writeStream(path, s)
      },
    }

    await expect(replace(failing, await jpeg(500, 300, 200))).rejects.toBeInstanceOf(AssetStorageError)
    expect(storage.dump()).toEqual(snapshot)
  })

  it('removes the new files when the manifest write fails', async () => {
    const storage = memoryStorage()
    const history = createHistoryProvider({ storage })
    await seedHero(storage)
    const assetsBefore = new Map([...storage.dump()].filter(([p]) => p.startsWith(`${ROOT}/`)))
    const failing: StorageProvider = {
      ...storage,
      async writeFile(path, content, opts) {
        if (path === `${ROOT}/hero.asset.json`) throw new Error('disk full')
        return storage.writeFile(path, content, opts)
      },
    }

    await expect(
      replace(failing, await jpeg(500, 300, 200), { history, contentRoot: createContentRoot(storage, '') }),
    ).rejects.toBeInstanceOf(AssetStorageError)
    expect(new Map([...storage.dump()].filter(([p]) => p.startsWith(`${ROOT}/`)))).toEqual(assetsBefore)
  })
})
