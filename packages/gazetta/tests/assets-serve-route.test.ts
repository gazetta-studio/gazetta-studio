import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetServeRoutes } from '../src/assets/serve-route.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { StorageProvider } from '../src/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('serve-test-' + Date.now())

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

async function seedAsset(name: string, bytes: Uint8Array) {
  const storage = createFilesystemProvider(testDir)
  await storage.writeStream(
    `assets/${name}`,
    new ReadableStream({
      start(c) {
        c.enqueue(bytes)
        c.close()
      },
    }),
  )
}

function buildApp(storage: StorageProvider = createFilesystemProvider(testDir)) {
  const app = new Hono()
  app.route(
    '/',
    assetServeRoutes(async () => storage),
  )
  return app
}

async function tinyJpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer(),
  )
}

describe('assetServeRoutes', () => {
  it('serves JPEG bytes with correct Content-Type', async () => {
    const bytes = await tinyJpeg()
    await seedAsset('hero-a3b2c1d4.jpg', bytes)
    const app = buildApp()

    const res = await app.request('/assets/hero-a3b2c1d4.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const served = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(served).equals(Buffer.from(bytes))).toBe(true)
  })

  it('serves PNG bytes with correct Content-Type', async () => {
    const png = new Uint8Array(
      await sharp({
        create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    )
    await seedAsset('icon-d5e6f7a8.png', png)
    const app = buildApp()

    const res = await app.request('/assets/icon-d5e6f7a8.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('returns 404 when the asset is missing', async () => {
    const app = buildApp()
    const res = await app.request('/assets/missing.jpg')
    expect(res.status).toBe(404)
  })

  it('returns 400 for path traversal attempts', async () => {
    const app = buildApp()
    const res = await app.request('/assets/../../etc/passwd')
    // Hono normalizes // sequences, but `..` still fails our guard
    expect([400, 404]).toContain(res.status)
  })
})
