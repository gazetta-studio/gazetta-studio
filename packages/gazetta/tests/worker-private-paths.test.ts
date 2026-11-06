import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'
import { archiveMarker } from '../src/runtime/archive-marker.js'

const IMMUTABLE = 'public, max-age=31536000, immutable'

const SEED: Record<string, string> = {
  'pages/home/index.html':
    '<!--cache:browser=60,edge=300-->\n<!DOCTYPE html><html><head></head><body>Home<!--esi:/fragments/header/index.html--></body></html>',
  'pages/about/index.html':
    '<!--cache:browser=60,edge=300-->\n<!DOCTYPE html><html><head></head><body>About<!--esi:/fragments/header/index.html--></body></html>',
  'pages/legacy/index.html': archiveMarker({ kind: 'gone' }),
  'pages/old/index.html': archiveMarker({ kind: 'alias', target: 'about' }),
  'pages/home/styles.ab12cd34.css': '.home{color:red}',
  'pages/home/.cf120e4b.hash': 'cf120e4b',
  'pages/home/.pub-20260417T220000Z': '',
  'pages/home/page.json': '{"reviewState":"draft"}',
  'pages/home/page.fr.json': '{"reviewState":"draft"}',
  'fragments/header/index.html': '<head></head><body>Header fragment</body>',
  'fragments/header/fragment.json': '{"reviewState":"draft"}',
}

function fakeBucket(seed: Record<string, string>) {
  const getCalls: string[] = []
  const bucket = {
    async get(key: string) {
      getCalls.push(key)
      const value = seed[key]
      if (value === undefined) return null
      const bytes = new TextEncoder().encode(value)
      return {
        text: async () => value,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
      }
    },
    async list() {
      return { objects: [], delimitedPrefixes: [], truncated: false }
    },
  }
  return { bucket, getCalls }
}

let originalCaches: PropertyDescriptor | undefined

beforeEach(() => {
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: { default: { match: async () => undefined, put: async () => {} } },
  })
})

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
  else delete (globalThis as { caches?: unknown }).caches
})

function get(bucket: unknown, path: string) {
  return createWorker().fetch(
    new Request(`https://example.com${path}`),
    { SITE_BUCKET: bucket } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
}

describe('worker refuses private storage under /pages/* and /fragments/*', () => {
  it.each([
    '/pages/home/.cf120e4b.hash',
    '/pages/home/.pub-20260417T220000Z',
    '/pages/home/page.json',
    '/pages/home/page.fr.json',
    '/fragments/header/fragment.json',
  ])('GET %s answers 404 without reading the bucket', async path => {
    const { bucket, getCalls } = fakeBucket(SEED)
    const res = await get(bucket, path)
    expect(res.status).toBe(404)
    expect(getCalls).not.toContain(path.slice(1))
  })

  it.each([
    ['/pages/home/styles.ab12cd34.css', 'text/css', '.home{color:red}'],
    ['/fragments/header/index.html', 'text/html', 'Header fragment'],
  ])('GET %s still answers 200 with %s', async (path, type, body) => {
    const { bucket } = fakeBucket(SEED)
    const res = await get(bucket, path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(type)
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(await res.text()).toContain(body)
  })

  it('answers an archived page index with its archive response', async () => {
    const { bucket } = fakeBucket(SEED)
    expect((await get(bucket, '/pages/legacy/index.html')).status).toBe(410)
    const alias = await get(bucket, '/pages/old/index.html')
    expect(alias.status).toBe(301)
    expect(alias.headers.get('location')).toBe('/about')
  })

  it.each([
    ['/', 'Home'],
    ['/about', 'About'],
  ])('assembles %s with its fragment', async (path, text) => {
    const { bucket } = fakeBucket(SEED)
    const res = await get(bucket, path)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(text)
    expect(html).toContain('Header fragment')
  })
})
