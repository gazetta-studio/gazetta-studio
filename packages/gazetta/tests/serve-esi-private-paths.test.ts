import { describe, it, expect } from 'vitest'
import { createServer } from '../src/serve.js'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import type { DirEntry, StorageProvider } from '../src/types.js'

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

/** In-memory storage that records every read, so tests can assert none happened. */
function recordingStorage(files: Record<string, string>) {
  const reads: string[] = []
  const key = (path: string) => path.replace(/^\/+/, '')
  const read = (path: string) => {
    reads.push(key(path))
    const content = files[key(path)]
    if (content === undefined) throw new Error(`not found: ${path}`)
    return content
  }
  const storage: StorageProvider = {
    readFile: async path => read(path),
    readBytes: async path => new TextEncoder().encode(read(path)),
    readDir: async (): Promise<DirEntry[]> => [],
    exists: async path => key(path) in files,
    writeFile: async () => {},
    mkdir: async () => {},
    rm: async () => {},
  }
  return { storage, reads }
}

function app(storage: StorageProvider) {
  return createServer({ type: 'dynamic', storage })
}

describe('ESI serve refuses private storage under /pages/* and /fragments/*', () => {
  it.each([
    '/pages/home/.cf120e4b.hash',
    '/pages/home/.pub-20260417T220000Z',
    '/pages/home/page.json',
    '/pages/home/page.fr.json',
    '/fragments/header/fragment.json',
  ])('GET %s answers 404 without reading storage', async path => {
    const { storage, reads } = recordingStorage(SEED)
    const res = await app(storage).request(path)
    expect(res.status).toBe(404)
    expect(reads).not.toContain(path.slice(1))
  })

  it.each([
    ['/pages/home/styles.ab12cd34.css', 'text/css; charset=utf-8', '.home{color:red}'],
    ['/fragments/header/index.html', 'text/html; charset=utf-8', 'Header fragment'],
  ])('GET %s still answers 200 with %s', async (path, type, body) => {
    const { storage } = recordingStorage(SEED)
    const res = await app(storage).request(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(type)
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(await res.text()).toContain(body)
  })

  it('answers an archived page index with its archive response', async () => {
    const { storage } = recordingStorage(SEED)
    expect((await app(storage).request('/pages/legacy/index.html')).status).toBe(410)
    const alias = await app(storage).request('/pages/old/index.html')
    expect(alias.status).toBe(301)
    expect(alias.headers.get('location')).toBe('/about')
  })

  it.each([
    ['/', 'Home'],
    ['/about', 'About'],
  ])('assembles %s with its fragment', async (path, text) => {
    const { storage } = recordingStorage(SEED)
    const res = await app(storage).request(path)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(text)
    expect(html).toContain('Header fragment')
  })
})
