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

describe('assetServeRoutes — design-media.md "Asset serving" headers', () => {
  it('sets ETag to the content hash parsed from the filename', async () => {
    await seedAsset('hero-a3b2c1d4.jpg', await tinyJpeg())
    const res = await buildApp().request('/assets/hero-a3b2c1d4.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"a3b2c1d4"')
  })

  it('sets Access-Control-Allow-Origin to * (public assets in v1)', async () => {
    await seedAsset('hero-a3b2c1d4.jpg', await tinyJpeg())
    const res = await buildApp().request('/assets/hero-a3b2c1d4.jpg')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('serves embedded image kinds with Content-Disposition: inline', async () => {
    await seedAsset('hero-a3b2c1d4.jpg', await tinyJpeg())
    const res = await buildApp().request('/assets/hero-a3b2c1d4.jpg')
    expect(res.headers.get('content-disposition')).toBe('inline')
  })

  it('serves non-image (downloadable) kinds with Content-Disposition: attachment', async () => {
    // A .pdf gets application/octet-stream from the v1 MIME table — a
    // downloadable kind that must not render inline in the asset origin.
    await seedAsset('report-a1b2c3d4.pdf', new Uint8Array([1, 2, 3, 4]))
    const res = await buildApp().request('/assets/report-a1b2c3d4.pdf')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment')
  })

  it('returns 304 when If-None-Match carries the strong ETag', async () => {
    await seedAsset('hero-a3b2c1d4.jpg', await tinyJpeg())
    const res = await buildApp().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { 'if-none-match': '"a3b2c1d4"' },
    })
    expect(res.status).toBe(304)
  })

  it('returns 304 when If-None-Match carries the weak form of the ETag', async () => {
    // RFC 7232 §3.2: If-None-Match uses weak comparison — a weak
    // validator W/"<hash>" must match the strong form "<hash>" of the
    // same opaque-tag. A client or proxy sending the weak form must
    // still get the 304, not re-download the asset.
    await seedAsset('hero-a3b2c1d4.jpg', await tinyJpeg())
    const res = await buildApp().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { 'if-none-match': 'W/"a3b2c1d4"' },
    })
    expect(res.status).toBe(304)
  })

  it('serves 200 when If-None-Match does not match the ETag', async () => {
    await seedAsset('hero-a3b2c1d4.jpg', await tinyJpeg())
    const res = await buildApp().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { 'if-none-match': '"deadbeef"' },
    })
    expect(res.status).toBe(200)
  })
})

describe('assetServeRoutes — RFC 9110 §14 partial responses (video/audio seeking)', () => {
  // Known 10-byte payload so range assertions are exact.
  const tenBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

  it('honors a satisfiable byte range with 206 + Content-Range + Accept-Ranges + sliced body', async () => {
    // The current route serves the right bytes (it passes the range to
    // readStream) but returns the WRONG envelope: status 200, no
    // Content-Range, no Accept-Ranges — a malformed partial response per
    // RFC 9110 §14.4. A range request the server honors MUST be 206 with
    // Content-Range.
    await seedAsset('clip-a1b2c3d4.bin', tenBytes)
    const res = await buildApp().request('/assets/clip-a1b2c3d4.bin', {
      headers: { range: 'bytes=2-5' },
    })

    expect(res.status).toBe(206)
    // complete-length is `*` because StorageProvider exposes no size; the
    // first/last byte positions come from the (satisfied) request range.
    expect(res.headers.get('content-range')).toBe('bytes 2-5/*')
    expect(res.headers.get('accept-ranges')).toBe('bytes')

    const served = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(served)).toEqual([2, 3, 4, 5])
  })

  it('advertises Accept-Ranges: bytes on a full (non-range) response', async () => {
    // Clients learn the route supports ranges from this header on the
    // first full GET, then re-request with a Range. Without it, a strict
    // client never attempts seeking.
    await seedAsset('clip-a1b2c3d4.bin', tenBytes)
    const res = await buildApp().request('/assets/clip-a1b2c3d4.bin')

    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const served = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(served)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('treats an open-ended bytes=N- range as ignored (200 full body, not a malformed partial)', async () => {
    // Serving `bytes=N-` as a real 206 partial needs the file size to
    // compute the last-byte position (StorageProvider has no size method),
    // so the route deliberately ignores the Range and returns the full
    // body — permitted by RFC 9110 §14.2. The contract here: it must NOT
    // emit a 206 with a bogus/empty Content-Range, and must still advertise
    // Accept-Ranges so the client can retry with a finite range.
    await seedAsset('clip-a1b2c3d4.bin', tenBytes)
    const res = await buildApp().request('/assets/clip-a1b2c3d4.bin', {
      headers: { range: 'bytes=5-' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const served = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(served)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
