import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { resolveAssetRefs, resolveEmbeddedRef, type AssetResolveContext } from '../src/assets/resolve.js'
import { AssetManifestNotFoundError } from '../src/assets/errors.js'
import { writeManifest } from '../src/assets/manifest.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { AssetManifest } from '../src/schema/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('resolve-test-' + Date.now())

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

async function seedManifest(ctx: AssetResolveContext, m: AssetManifest) {
  await writeManifest(ctx.storage, ctx.assetsRoot, m)
}

async function makeCtx(): Promise<AssetResolveContext> {
  await mkdir(testDir, { recursive: true })
  return {
    storage: createFilesystemProvider(testDir),
    assetsRoot: 'assets',
  }
}

describe('resolveEmbeddedRef', () => {
  it('resolves a ref to a ResolvedEmbeddedAsset using manifest fields', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest())

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)

    expect(resolved.url).toBe('/assets/hero-a3b2c1d4.jpg')
    expect(resolved.width).toBe(1920)
    expect(resolved.height).toBe(1080)
    expect(resolved.alt).toBe('Mountain sunset')
    expect(resolved.mime).toBe('image/jpeg')
    expect(resolved.srcset).toBeNull()
    expect(resolved.focalPoint).toBeNull()
    expect(resolved.animated).toBe(false)
    expect(resolved.poster).toBeNull()
    expect(resolved.duration).toBeNull()
  })

  it('uses siteUrl when provided', async () => {
    const ctx: AssetResolveContext = {
      ...(await makeCtx()),
      siteUrl: 'https://cdn.example.com',
    }
    await seedManifest(ctx, sampleManifest())

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)
    expect(resolved.url).toBe('https://cdn.example.com/assets/hero-a3b2c1d4.jpg')
  })

  it('prefers per-reference alt over manifest alt', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest({ alt: 'Fallback alt' }))

    const resolved = await resolveEmbeddedRef({ _asset: 'hero', alt: 'Override alt' }, ctx)
    expect(resolved.alt).toBe('Override alt')
  })

  it('falls back to manifest alt when reference has no alt', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest({ alt: 'Manifest alt' }))

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)
    expect(resolved.alt).toBe('Manifest alt')
  })

  it('uses empty-string alt when both reference and manifest alt are absent', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest({ alt: null }))

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)
    expect(resolved.alt).toBe('')
  })

  it('carries per-reference focal point through', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest())

    const resolved = await resolveEmbeddedRef({ _asset: 'hero', focalPoint: { x: 0.3, y: 0.7 } }, ctx)
    expect(resolved.focalPoint).toEqual({ x: 0.3, y: 0.7 })
  })

  it('throws AssetManifestNotFoundError when the asset does not exist', async () => {
    const ctx = await makeCtx()
    await expect(resolveEmbeddedRef({ _asset: 'missing' }, ctx)).rejects.toBeInstanceOf(AssetManifestNotFoundError)
  })

  it('builds a srcset string from manifest variants', async () => {
    const ctx = await makeCtx()
    await seedManifest(
      ctx,
      sampleManifest({
        variants: [
          { width: 400, path: 'hero-a3b2c1d4-400w.jpg', size: 10_000 },
          { width: 800, path: 'hero-a3b2c1d4-800w.jpg', size: 40_000 },
          { width: 1200, path: 'hero-a3b2c1d4-1200w.jpg', size: 90_000 },
        ],
      }),
    )

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)

    expect(resolved.srcset).toBe(
      '/assets/hero-a3b2c1d4-400w.jpg 400w, ' +
        '/assets/hero-a3b2c1d4-800w.jpg 800w, ' +
        '/assets/hero-a3b2c1d4-1200w.jpg 1200w',
    )
  })

  it('srcset uses siteUrl when provided', async () => {
    const ctx: AssetResolveContext = {
      ...(await makeCtx()),
      siteUrl: 'https://cdn.example.com',
    }
    await seedManifest(
      ctx,
      sampleManifest({
        variants: [{ width: 400, path: 'hero-a3b2c1d4-400w.jpg', size: 10_000 }],
      }),
    )

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)
    expect(resolved.srcset).toBe('https://cdn.example.com/assets/hero-a3b2c1d4-400w.jpg 400w')
  })

  it('srcset is null when variants is empty', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest({ variants: [] }))

    const resolved = await resolveEmbeddedRef({ _asset: 'hero' }, ctx)
    expect(resolved.srcset).toBeNull()
  })
})

describe('resolveAssetRefs (walker)', () => {
  it('resolves a top-level asset field', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest())

    const content = { hero: { _asset: 'hero' }, title: 'Welcome' }
    const resolved = (await resolveAssetRefs(content, ctx)) as Record<string, unknown>

    expect(resolved.title).toBe('Welcome')
    expect((resolved.hero as { url: string }).url).toBe('/assets/hero-a3b2c1d4.jpg')
  })

  it('recurses into nested objects', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest())

    const content = {
      section: {
        image: { _asset: 'hero' },
        caption: 'Below',
      },
    }
    const resolved = (await resolveAssetRefs(content, ctx)) as Record<string, unknown>

    const section = resolved.section as Record<string, unknown>
    expect((section.image as { url: string }).url).toBe('/assets/hero-a3b2c1d4.jpg')
    expect(section.caption).toBe('Below')
  })

  it('resolves references inside arrays', async () => {
    const ctx = await makeCtx()
    await seedManifest(ctx, sampleManifest())
    await seedManifest(ctx, sampleManifest({ name: 'second', hash: 'e5f6a7b8' }))

    const content = {
      gallery: [{ _asset: 'hero' }, { _asset: 'second' }],
    }
    const resolved = (await resolveAssetRefs(content, ctx)) as Record<string, unknown>

    const gallery = resolved.gallery as Array<{ url: string }>
    expect(gallery[0].url).toBe('/assets/hero-a3b2c1d4.jpg')
    expect(gallery[1].url).toBe('/assets/second-e5f6a7b8.jpg')
  })

  it('returns undefined for undefined content', async () => {
    const ctx = await makeCtx()
    expect(await resolveAssetRefs(undefined, ctx)).toBeUndefined()
  })

  it('copies primitives unchanged', async () => {
    const ctx = await makeCtx()
    const content = { title: 'Text', count: 42, flag: true, nil: null }
    const resolved = (await resolveAssetRefs(content, ctx)) as Record<string, unknown>
    expect(resolved).toEqual(content)
  })

  it('gracefully degrades on missing asset — returns placeholder, does not throw', async () => {
    const ctx = await makeCtx()
    const content = { hero: { _asset: 'does-not-exist' } }

    // Suppress the expected warn-log during the test
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const resolved = (await resolveAssetRefs(content, ctx)) as Record<string, unknown>
      const hero = resolved.hero as { url: string; alt: string }
      expect(hero.url).toBe('/assets/__missing__.svg')
      expect(hero.alt).toBe('')
    } finally {
      console.warn = origWarn
    }
  })

  it('leaves content without asset refs unchanged', async () => {
    const ctx = await makeCtx()
    const content = { title: 'No assets', bits: [1, 2, 3], nested: { a: 'b' } }
    const resolved = await resolveAssetRefs(content, ctx)
    expect(resolved).toEqual(content)
  })
})
