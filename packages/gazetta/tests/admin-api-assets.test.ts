/**
 * HTTP-level tests for `POST /api/assets`. These verify the route adapter
 * correctly wires multipart → ingest → HTTP response. Ingest correctness
 * itself is covered by assets-ingest.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm } from 'node:fs/promises'
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
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function buildApp() {
  const storage = createFilesystemProvider(testDir)
  const source = createSourceContext({ storage, siteDir: testDir })
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
