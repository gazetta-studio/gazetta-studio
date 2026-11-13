/**
 * The Cloudflare worker (`workers/cloudflare-r2.ts`) through its real
 * `createWorker()` app: an in-memory R2 bucket in `env`, a stub
 * `ctx.waitUntil`, and a stubbed `caches.default` (#1061).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'

interface FakeObject {
  text(): Promise<string>
  body: ReadableStream<Uint8Array>
  size: number
}

function objectFor(value: string): FakeObject {
  const bytes = new TextEncoder().encode(value)
  return {
    async text() {
      return value
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    size: bytes.byteLength,
  }
}

function fakeBucket(seed: Record<string, string>) {
  const files = new Map(Object.entries(seed))
  return {
    async get(key: string) {
      const value = files.get(key)
      return value === undefined ? null : objectFor(value)
    },
    async head(key: string) {
      const value = files.get(key)
      return value === undefined ? null : { size: new TextEncoder().encode(value).byteLength }
    },
    async list(options: { prefix?: string; delimiter?: string } = {}) {
      const prefix = options.prefix ?? ''
      const rests = [...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
      const delimitedPrefixes = [
        ...new Set(rests.filter(r => r.includes('/')).map(r => `${prefix}${r.slice(0, r.indexOf('/') + 1)}`)),
      ]
      return { objects: [], delimitedPrefixes, truncated: false }
    },
  }
}

let originalCaches: PropertyDescriptor | undefined
let cacheStore: Map<string, Response>
let cacheMatches: string[]
let cachePuts: string[]
let waitUntils: Promise<unknown>[]

beforeEach(() => {
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  cacheStore = new Map()
  cacheMatches = []
  cachePuts = []
  waitUntils = []
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        match: async (request: Request) => {
          cacheMatches.push(request.url)
          return cacheStore.get(request.url)?.clone()
        },
        put: async (request: Request, response: Response) => {
          cachePuts.push(request.url)
          cacheStore.set(request.url, response.clone())
        },
      },
    },
  })
})

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
  else delete (globalThis as { caches?: unknown }).caches
})

async function get(
  app: ReturnType<typeof createWorker>,
  bucket: ReturnType<typeof fakeBucket>,
  path: string,
  headers?: Record<string, string>,
) {
  const res = await app.fetch(
    new Request(`https://example.com${path}`, { headers }),
    { SITE_BUCKET: bucket } as never,
    { waitUntil: (p: Promise<unknown>) => waitUntils.push(p), passThroughOnException: () => {} } as never,
  )
  await Promise.all(waitUntils)
  return res
}

const PAGE = [
  '<!DOCTYPE html><html><head><title>About</title><!--esi-head:/fragments/header/index.html--></head>',
  '<body><!--esi:/fragments/header/index.html--><main>About body</main></body></html>',
].join('')
const HEADER = '<head><link rel="stylesheet" href="/fragments/header/styles.abc.css"></head><nav>Header nav</nav>'

describe('Cloudflare worker: pages', () => {
  it('replaces ESI placeholders with fragment HTML and puts the fragment head in <head>', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': PAGE, 'fragments/header/index.html': HEADER })
    const res = await get(createWorker(), bucket, '/about')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).not.toContain('<!--esi')
    expect(html).toContain('<nav>Header nav</nav>')
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    expect(head).toContain('<link rel="stylesheet" href="/fragments/header/styles.abc.css">')
  })

  it('serves the home page at /', async () => {
    const bucket = fakeBucket({ 'pages/home/index.html': '<html><body>Home</body></html>' })
    const res = await get(createWorker(), bucket, '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Home')
  })

  it('turns the cache comment into Cache-Control', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': `<!--cache:browser=60,edge=300-->\n${PAGE}` })
    const res = await get(createWorker(), bucket, '/about')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300')
    expect(await res.text()).not.toContain('<!--cache:')
  })

  it('applies the default cache policy when there is no cache comment', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': PAGE })
    const res = await get(createWorker(), bucket, '/about')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=86400')
  })

  it('answers 304 when If-None-Match equals the ETag', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': PAGE })
    const app = createWorker()
    const first = await get(app, bucket, '/about')
    const etag = first.headers.get('ETag')
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)

    cacheStore.clear()
    const second = await get(app, bucket, '/about', { 'If-None-Match': etag! })
    expect(second.status).toBe(304)
    expect(second.headers.get('ETag')).toBe(etag)
    expect(await second.text()).toBe('')
  })

  it('answers 200 when If-None-Match differs from the ETag', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': PAGE })
    const res = await get(createWorker(), bucket, '/about', { 'If-None-Match': '"0000000000000000"' })
    expect(res.status).toBe(200)
  })

  it('stores the first response in caches.default and serves the second from it', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': PAGE })
    const app = createWorker()
    const first = await get(app, bucket, '/about')
    expect(await first.text()).toContain('About body')
    expect(cachePuts).toHaveLength(1)

    // A cache hit never reads the page again: changing it in R2 doesn't show.
    const files = bucket as unknown as { get(key: string): Promise<FakeObject | null> }
    const originalGet = files.get
    files.get = async (key: string) =>
      key === 'pages/about/index.html' ? objectFor('<html><body>Changed</body></html>') : originalGet(key)

    const second = await get(app, bucket, '/about')
    expect(cacheMatches).toHaveLength(2)
    expect(cacheMatches[1]).toBe(cachePuts[0])
    expect(cachePuts).toHaveLength(1)
    expect(await second.text()).toContain('About body')
  })
})

describe('Cloudflare worker: languages', () => {
  const app = () => createWorker({ locales: ['en', 'fr'], defaultLocale: 'en' })

  it('serves index.fr.html for /fr/about', async () => {
    const bucket = fakeBucket({
      'pages/about/index.html': '<html><body>About</body></html>',
      'pages/about/index.fr.html': '<html><body>À propos</body></html>',
    })
    const res = await get(app(), bucket, '/fr/about')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('À propos')
  })

  it('serves the French home page at /fr', async () => {
    const bucket = fakeBucket({
      'pages/home/index.html': '<html><body>Home</body></html>',
      'pages/home/index.fr.html': '<html><body>Accueil</body></html>',
    })
    const res = await get(app(), bucket, '/fr')
    expect(await res.text()).toContain('Accueil')
  })

  it('falls back to index.html for a page without a French version', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': '<html><body>About</body></html>' })
    const res = await get(app(), bucket, '/fr/about')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('About')
  })

  it('falls back to the default fragment when the fragment has no French version', async () => {
    const bucket = fakeBucket({
      'pages/about/index.fr.html': '<html><body><!--esi:/fragments/header/index.fr.html--></body></html>',
      'fragments/header/index.html': '<nav>Default header</nav>',
    })
    const res = await get(app(), bucket, '/fr/about')
    const html = await res.text()
    expect(html).toContain('<nav>Default header</nav>')
    expect(html).not.toContain('fragment not found')
  })

  it('serves the French fragment when there is one', async () => {
    const bucket = fakeBucket({
      'pages/about/index.fr.html': '<html><body><!--esi:/fragments/header/index.fr.html--></body></html>',
      'fragments/header/index.html': '<nav>Default header</nav>',
      'fragments/header/index.fr.html': '<nav>En-tête</nav>',
    })
    const res = await get(app(), bucket, '/fr/about')
    expect(await res.text()).toContain('En-tête')
  })

  it('treats an unknown prefix as part of the path', async () => {
    const bucket = fakeBucket({ 'pages/es/about/index.html': '<html><body>Spanish folder</body></html>' })
    const res = await get(app(), bucket, '/es/about')
    expect(await res.text()).toContain('Spanish folder')
  })
})

describe('Cloudflare worker: dynamic routes', () => {
  it('serves a [param] page for a matching path', async () => {
    const bucket = fakeBucket({ 'pages/blog/[slug]/index.html': '<html><body>Post</body></html>' })
    const res = await get(createWorker(), bucket, '/blog/hello')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Post')
  })

  it('falls back to the default language of a [param] page', async () => {
    const bucket = fakeBucket({ 'pages/blog/[slug]/index.html': '<html><body>Post</body></html>' })
    const res = await get(createWorker({ locales: ['en', 'fr'] }), bucket, '/fr/blog/hello')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Post')
  })
})

describe('Cloudflare worker: not found', () => {
  it("serves the site's /404 page with status 404, fragments assembled", async () => {
    const bucket = fakeBucket({
      'pages/404/index.html':
        '<!--cache:browser=0,edge=60-->\n<html><body><!--esi:/fragments/header/index.html-->Missing</body></html>',
      'fragments/header/index.html': '<nav>Header nav</nav>',
    })
    const res = await get(createWorker(), bucket, '/nowhere')
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain('Missing')
    expect(html).toContain('<nav>Header nav</nav>')
    expect(html).not.toContain('<!--cache:')
  })

  it('serves the built-in 404 when the site has no /404 page', async () => {
    const res = await get(createWorker(), fakeBucket({}), '/nowhere')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('404 — Page not found')
  })
})

describe('Cloudflare worker: page and fragment files', () => {
  it('serves /pages/* files with an immutable cache policy', async () => {
    const bucket = fakeBucket({ 'pages/about/styles.abc.css': 'main{color:red}' })
    const res = await get(createWorker(), bucket, '/pages/about/styles.abc.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/css')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe('main{color:red}')
  })

  it('serves /fragments/* scripts with an immutable cache policy', async () => {
    const bucket = fakeBucket({ 'fragments/header/script.abc.js': 'console.log(1)' })
    const res = await get(createWorker(), bucket, '/fragments/header/script.abc.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/javascript')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('serves a /pages/* HTML file with an immutable cache policy', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': '<html><body>About</body></html>' })
    const res = await get(createWorker(), bucket, '/pages/about/index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('answers 404 for a missing file', async () => {
    const res = await get(createWorker(), fakeBucket({}), '/fragments/header/missing.css')
    expect(res.status).toBe(404)
  })
})

describe('Cloudflare worker: site files and health', () => {
  it('serves /sitemap.xml from R2', async () => {
    const bucket = fakeBucket({ 'sitemap.xml': '<urlset></urlset>' })
    const res = await get(createWorker(), bucket, '/sitemap.xml')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(await res.text()).toBe('<urlset></urlset>')
  })

  it('serves /robots.txt from R2', async () => {
    const bucket = fakeBucket({ 'robots.txt': 'User-agent: *' })
    const res = await get(createWorker(), bucket, '/robots.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('User-agent: *')
  })

  it('answers 404 for /sitemap.xml and /robots.txt when R2 has none', async () => {
    const app = createWorker()
    expect((await get(app, fakeBucket({}), '/sitemap.xml')).status).toBe(404)
    expect((await get(app, fakeBucket({}), '/robots.txt')).status).toBe(404)
  })

  it('reports page and fragment counts at /health', async () => {
    const bucket = fakeBucket({
      'pages/home/index.html': 'h',
      'pages/about/index.html': 'a',
      'fragments/header/index.html': 'f',
    })
    const res = await get(createWorker(), bucket, '/health')
    expect(await res.json()).toEqual({ ok: true, pages: 2, fragments: 1 })
  })
})

describe('Cloudflare worker: options', () => {
  it('reads the bucket from a custom binding', async () => {
    const bucket = fakeBucket({ 'pages/about/index.html': '<html><body>About</body></html>' })
    const app = createWorker({ bucketBinding: 'CONTENT' })
    const res = await app.fetch(
      new Request('https://example.com/about'),
      { CONTENT: bucket } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    )
    expect(res.status).toBe(200)
  })

  it('runs custom middleware before page serving', async () => {
    const app = createWorker({
      middleware: a => a.use('*', async (c, next) => (c.req.path === '/blocked' ? c.text('no', 403) : next())),
    })
    expect((await get(app, fakeBucket({}), '/blocked')).status).toBe(403)
  })
})
