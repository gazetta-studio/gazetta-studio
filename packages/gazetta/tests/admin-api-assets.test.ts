/**
 * HTTP-level tests for the `/api/assets` route. POST verifies the route
 * adapter correctly wires multipart → ingest → HTTP response; GET verifies
 * list → response. Ingest and list correctness themselves are covered by
 * assets-ingest.test.ts and assets-list.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetRoutes } from '../src/admin-api/routes/assets.js'
import { staticSourceResolver, createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('http-assets-test-' + Date.now())

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
  // Minimum site.yaml so delete's ref-scan can call loadSite without
  // hitting "No site.yaml found". Asset-level tests don't need any real
  // content beyond this.
  await writeFile(join(testDir, 'site.yaml'), 'name: test-site\n')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function buildApp() {
  const storage = createFilesystemProvider(testDir)
  // Storage is already rooted at `testDir`, so siteDir within that root
  // is the empty string — otherwise content paths double the prefix.
  const source = createSourceContext({ storage, siteDir: '' })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.route('/', assetRoutes(resolve))
  return { app, storage }
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
}

function multipartForm(fields: Record<string, string | { name: string; bytes: Uint8Array; type: string }>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      form.set(key, value)
    } else {
      form.set(key, new File([value.bytes], value.name, { type: value.type }))
    }
  }
  return form
}

describe('POST /api/assets', () => {
  it('201s a valid JPEG upload with alt', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
        alt: 'Hero banner',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manifest.name).toBe('hero')
    expect(body.manifest.mime).toBe('image/jpeg')
    expect(body.manifest.alt).toBe('Hero banner')
    expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.jpg$/)

    // Bytes landed on disk
    const onDisk = await readFile(join(testDir, body.bytesPath))
    expect(Buffer.compare(onDisk, bytes)).toBe(0)
  })

  it('treats empty alt string as "decorative"', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'decorative-hero',
        alt: '',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manifest.alt).toBe('')
  })

  it('treats missing alt field as "not set" (null)', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'no-alt',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manifest.alt).toBeNull()
  })

  it('400s when file field is missing', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({ name: 'hero' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('BAD_REQUEST')
  })

  it('400s when name field is missing', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s with ASSET_MIME_MISMATCH for an unsupported format', async () => {
    const { app } = buildApp()
    const webp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .webp()
      .toBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'x.webp', bytes: new Uint8Array(webp), type: 'image/webp' },
        name: 'rejected',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MIME_MISMATCH')
  })

  it('400s with ASSET_PATH_TRAVERSAL for a path-traversing name', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: '../etc/passwd',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('ASSET_PATH_TRAVERSAL')
  })
})

describe('GET /api/assets', () => {
  it('returns an empty array when the target has no assets', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('lists uploaded assets', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    // Upload two assets
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'a.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'asset-one',
        alt: 'First asset',
      }),
    })
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'b.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'asset-two',
      }),
    })

    const res = await app.request('/api/assets')
    expect(res.status).toBe(200)
    const summaries = (await res.json()) as Array<{ name: string; alt: string | null }>
    expect(summaries).toHaveLength(2)
    expect(summaries.map(s => s.name).sort()).toEqual(['asset-one', 'asset-two'])
    const assetOne = summaries.find(s => s.name === 'asset-one')
    expect(assetOne?.alt).toBe('First asset')
  })

  it('returns summaries with expected shape', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'a.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'shape-test',
        alt: 'Shape',
      }),
    })

    const res = await app.request('/api/assets')
    const [summary] = (await res.json()) as Array<Record<string, unknown>>
    // Summary fields present
    expect(summary.name).toBe('shape-test')
    expect(summary.kind).toBe('embedded')
    expect(summary.mime).toBe('image/jpeg')
    expect(typeof summary.size).toBe('number')
    expect(typeof summary.hash).toBe('string')
    expect(summary.alt).toBe('Shape')
    // Private fields NOT in summary
    expect('uploadedBy' in summary).toBe(false)
  })
})

describe('GET /api/assets/:name', () => {
  it('returns a single-asset summary by name', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'a.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'single',
        alt: 'Single asset',
      }),
    })

    const res = await app.request('/api/assets/single')
    expect(res.status).toBe(200)
    const summary = (await res.json()) as Record<string, unknown>
    expect(summary.name).toBe('single')
    expect(summary.mime).toBe('image/jpeg')
    expect(summary.alt).toBe('Single asset')
    // Same summary shape as the list endpoint — no private fields.
    expect('uploadedBy' in summary).toBe(false)
  })

  it('404s when the asset does not exist', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/nope')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MANIFEST_NOT_FOUND')
  })
})

describe('DELETE /api/assets/:name', () => {
  async function uploadHero(app: Hono) {
    const bytes = await jpegBuffer()
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
        alt: 'Hero',
      }),
    })
  }

  it('204s when the asset has no refs', async () => {
    const { app } = buildApp()
    await uploadHero(app)

    const res = await app.request('/api/assets/hero', { method: 'DELETE' })
    expect(res.status).toBe(204)

    // Asset is gone from the list.
    const listRes = await app.request('/api/assets')
    expect(await listRes.json()).toEqual([])
  })

  it('409s with the usage list when a page references the asset', async () => {
    const { app } = buildApp()
    await uploadHero(app)

    // Seed a page referencing "hero" under the site root.
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(testDir, 'pages/home'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/',
        content: { hero: { _asset: 'hero' } },
      }),
    )

    const res = await app.request('/api/assets/hero', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      assetName: string
      refs: Array<{ source: string; path: string; componentPath: string }>
    }
    expect(body.code).toBe('ASSET_IN_USE')
    expect(body.assetName).toBe('hero')
    expect(body.refs).toHaveLength(1)
    expect(body.refs[0]).toMatchObject({
      source: 'page',
      path: 'pages/home/page.json',
      componentPath: 'hero',
    })

    // Asset files are untouched.
    const listRes = await app.request('/api/assets')
    const list = (await listRes.json()) as Array<{ name: string }>
    expect(list.some(a => a.name === 'hero')).toBe(true)
  })

  it('404s when the asset does not exist', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MANIFEST_NOT_FOUND')
  })
})
