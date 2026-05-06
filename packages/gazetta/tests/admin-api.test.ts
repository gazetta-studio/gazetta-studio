import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { tempDir } from './_helpers/temp.js'

// Copy the starter into .tmp/ so admin API tests can mutate pages/fragments
// without dirtying the real repo. See #123.
const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const projectRoot = tempDir('admin-api-test-' + Date.now())
const projectSiteDir = resolve(projectRoot, 'sites/main')
// Content lives inside the local target (post-transformation layout).
const localTargetDir = resolve(projectSiteDir, 'targets/local')
const storage = createFilesystemProvider(localTargetDir)
let app: Hono

beforeAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  // Read the project-level manifest from the TS config — routes use it
  // instead of reading from the target's storage (targets have no config).
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${projectSiteDir}`)
  const manifest = siteConfigToManifest(loaded.config)
  // Target-rooted source: storage points at targets/local, siteDir is '',
  // projectSiteDir is the actual project site directory.
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir,
    manifest,
  })
  app = createAdminApp({
    source,
    siteDir: projectSiteDir, // used for templatesDir/adminDir defaults
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
})

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

async function get(path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.json() }
}

async function getText(path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.text() }
}

describe('GET /api/site', () => {
  it('returns site manifest', async () => {
    const { status, body } = await get('/api/site')
    expect(status).toBe(200)
    expect(body.name).toBe('Gazetta Starter')
  })
})

describe('GET /api/system/cache/stats', () => {
  it('returns the source cache snapshot', async () => {
    // Hit /api/pages first so the cache has something to report —
    // the stats() shape is provider-defined but the floor (hits,
    // misses, size) is required by the AdminCache contract.
    await get('/api/pages')
    const { status, body } = await get('/api/system/cache/stats')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      hits: expect.any(Number),
      misses: expect.any(Number),
      size: expect.any(Number),
    })
    // /api/pages writes to the cache on miss → at least one entry.
    expect(body.size).toBeGreaterThanOrEqual(1)
  })

  it('includes the instance field for multi-instance correlation (Gap 1)', async () => {
    const { body } = await get('/api/system/cache/stats')
    // Instance is resolved from K_REVISION → os.hostname() → random hex.
    // We don't pin a specific value — only that the field is present
    // and non-empty. Operators in multi-instance deployments use this
    // to know which pod / revision answered.
    expect(typeof body.instance).toBe('string')
    expect(body.instance.length).toBeGreaterThan(0)
  })
})

describe('GET /api/system/cache/invalidations (SSE)', () => {
  it('opens an SSE stream and emits an invalidation event on save', async () => {
    // Use AbortController so we can cleanly close the long-lived
    // stream after asserting. Without it the test runtime would
    // hang waiting on a never-closing connection.
    const ctrl = new AbortController()
    const res = await app.request('/api/system/cache/invalidations', { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.body).toBeTruthy()

    // Read the stream incrementally. After the initial 'ready' event,
    // trigger a save via /api/pages and assert that an invalidation
    // event arrives in a bounded window.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const collected: string[] = []
    let saveTriggered = false

    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        collected.push(decoder.decode(value, { stream: true }))
        // After the first chunk lands ('ready' event) trigger a save.
        if (!saveTriggered) {
          saveTriggered = true
          // Don't await — the save's response cycle is independent
          // of this stream; we just want the invalidation it triggers.
          void app.request('/api/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'sse-cache-test', template: 'page-default' }),
          })
        }
        // Stop reading once an invalidation event arrives.
        if (collected.join('').includes('event: invalidation')) return
      }
    })()

    // Bound the wait so a regression doesn't hang the suite.
    const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 5000))
    await Promise.race([readPromise, timeoutPromise])
    ctrl.abort()
    try {
      reader.cancel()
    } catch {
      // already aborted
    }

    const text = collected.join('')
    expect(text).toContain('event: ready')
    expect(text).toContain('event: invalidation')
    expect(text).toMatch(/data: \{[^}]*"prefix":"pages:"/)

    // Cleanup the page we created.
    await rm(resolve(localTargetDir, 'pages/sse-cache-test'), { recursive: true, force: true })
  }, 15_000)
})

describe('GET /api/pages', () => {
  it('returns all pages', async () => {
    const { status, body } = await get('/api/pages')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThanOrEqual(4)
    const names = body.map((p: { name: string }) => p.name)
    expect(names).toContain('home')
    expect(names).toContain('404')
    expect(names).toContain('about')
    expect(names).toContain('blog/[slug]')
  })

  it('pages have route and template', async () => {
    const { body } = await get('/api/pages')
    const home = body.find((p: { name: string }) => p.name === 'home')
    expect(home.route).toBe('/')
    expect(home.template).toBe('page-default')
  })
})

describe('GET /api/pages/:name', () => {
  it('returns page detail', async () => {
    const { status, body } = await get('/api/pages/home')
    expect(status).toBe(200)
    expect(body.route).toBe('/')
    expect(body.components).toContain('@header')
    expect(body.components).toContain('@footer')
    const hero = body.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
    expect(hero).toBeDefined()
    expect(hero.template).toBe('hero')
  })

  it('returns nested page', async () => {
    const { status, body } = await get('/api/pages/blog/[slug]')
    expect(status).toBe(200)
    expect(body.route).toBe('/blog/:slug')
  })

  it('returns 404 for missing page', async () => {
    const { status } = await get('/api/pages/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/fragments', () => {
  it('returns all fragments', async () => {
    const { status, body } = await get('/api/fragments')
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    const names = body.map((f: { name: string }) => f.name)
    expect(names).toContain('header')
    expect(names).toContain('footer')
  })
})

describe('GET /api/fragments/:name', () => {
  it('returns fragment detail', async () => {
    const { status, body } = await get('/api/fragments/header')
    expect(status).toBe(200)
    expect(body.template).toBe('header-layout')
    const logo = body.components.find((c: any) => typeof c === 'object' && c.name === 'logo')
    const nav = body.components.find((c: any) => typeof c === 'object' && c.name === 'nav')
    expect(logo).toBeDefined()
    expect(nav).toBeDefined()
  })

  it('returns 404 for missing fragment', async () => {
    const { status } = await get('/api/fragments/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/templates', () => {
  it('returns all templates', async () => {
    const { status, body } = await get('/api/templates')
    expect(status).toBe(200)
    const names = body.map((t: { name: string }) => t.name)
    expect(names).toContain('hero')
    expect(names).toContain('page-default')
    expect(names).toContain('feature-card')
  })
})

describe('GET /api/templates/:name/schema', () => {
  it('returns JSON Schema for a template', async () => {
    const { status, body } = await get('/api/templates/hero/schema')
    expect(status).toBe(200)
    expect(body.type).toBe('object')
    expect(body.properties.title).toBeDefined()
    expect(body.properties.subtitle).toBeDefined()
  })

  it('returns 500 for missing template', async () => {
    const { status } = await get('/api/templates/nonexistent/schema')
    expect(status).toBe(500)
  })
})

describe('component data via page API', () => {
  it('page detail includes inline component content', async () => {
    const { status, body } = await get('/api/pages/home')
    expect(status).toBe(200)
    const hero = body.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
    expect(hero.content.title).toBe('Welcome to Gazetta')
  })
})

describe('GET /preview/*', () => {
  it('renders home page', async () => {
    const { status, body } = await getText('/preview/')
    expect(status).toBe(200)
    expect(body).toContain('Welcome to Gazetta')
    expect(body).toContain('<!DOCTYPE html>')
  })

  it('renders about page', async () => {
    const { status, body } = await getText('/preview/about')
    expect(status).toBe(200)
    expect(body).toContain('About Gazetta')
  })

  it('renders dynamic route', async () => {
    const { status, body } = await getText('/preview/blog/hello-world')
    expect(status).toBe(200)
    expect(body).toContain('Hello from Gazetta')
  })

  it('returns 404 for missing route', async () => {
    const { status } = await getText('/preview/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /preview/@fragment', () => {
  it('renders fragment standalone', async () => {
    const { status, body } = await getText('/preview/@header')
    expect(status).toBe(200)
    expect(body).toContain('<!DOCTYPE html>')
  })

  it('returns 500 for missing fragment', async () => {
    const { status } = await getText('/preview/@nonexistent')
    expect(status).toBe(500)
  })
})

describe('POST /preview/@fragment', () => {
  it('renders fragment with content overrides', async () => {
    const footerPath = resolve(localTargetDir, 'fragments/footer')
    const res = await app.request('/preview/@footer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          content: { [footerPath]: { text: 'Draft Footer' } },
          structural: {},
        },
      }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
  })
})

describe('POST /preview/*', () => {
  it('renders with content overrides', async () => {
    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          content: { hero: { title: 'Draft Title', subtitle: 'Draft Subtitle' } },
          structural: {},
        },
      }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Draft Title')
    expect(html).toContain('Draft Subtitle')
  })

  it('renders normally without overrides', async () => {
    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Welcome to Gazetta')
  })

  it('renders with a structural override (reordered components)', async () => {
    // Pull the original components, swap the first two non-fragment children, send as override.
    const original = await app.request('/api/pages/home').then(r => r.json())
    const components = (original as { components: unknown[] }).components.slice()
    // Find the hero (index 1, after @header) and features (index 2) and swap them.
    const heroIdx = components.findIndex(
      c => typeof c === 'object' && c !== null && (c as { name?: string }).name === 'hero',
    )
    const featuresIdx = components.findIndex(
      c => typeof c === 'object' && c !== null && (c as { name?: string }).name === 'features',
    )
    expect(heroIdx).toBeGreaterThan(-1)
    expect(featuresIdx).toBeGreaterThan(-1)
    ;[components[heroIdx], components[featuresIdx]] = [components[featuresIdx], components[heroIdx]]

    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          content: {},
          structural: { 'page:home': components },
        },
      }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // Both components still rendered
    expect(html).toContain('Welcome to Gazetta')
    expect(html).toContain('Why Gazetta?')
    // 'Why Gazetta?' (features heading) now appears before 'Welcome to Gazetta' (hero title).
    expect(html.indexOf('Why Gazetta?')).toBeLessThan(html.indexOf('Welcome to Gazetta'))
  })

  it('does not mutate the underlying Site (concurrent override + plain renders)', async () => {
    // Sequentially: render with structural override, then render without — second
    // render should reflect ORIGINAL order, proving the override did not mutate
    // the in-memory Site.
    const original = await app.request('/api/pages/home').then(r => r.json())
    const components = (original as { components: unknown[] }).components.slice().reverse()

    await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { content: {}, structural: { 'page:home': components } },
      }),
    })

    const res = await app.request('/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { content: {}, structural: {} } }),
    })
    const html = await res.text()
    // Original order: hero before features.
    expect(html.indexOf('Welcome to Gazetta')).toBeLessThan(html.indexOf('Why Gazetta?'))
  })
})

describe('POST /api/pages (create)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/test-page'), { recursive: true, force: true })
    await rm(resolve(localTargetDir, 'pages/docs'), { recursive: true, force: true })
  })

  it('creates a new page', { timeout: 15_000 }, async () => {
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-page', template: 'page-default' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    const { body: pages } = await get('/api/pages')
    expect(pages.some((p: { name: string }) => p.name === 'test-page')).toBe(true)
  })

  it('rejects duplicate page', async () => {
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-page', template: 'page-default' }),
    })
    expect(res.status).toBe(409)
  })

  it('rejects missing fields', async () => {
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/pages/:name', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/update-test'), { recursive: true, force: true })
  })

  it('updates page content', async () => {
    // Create
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'update-test', template: 'page-default' }),
    })

    // Update
    const res = await app.request('/api/pages/update-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Updated Title' } }),
    })
    expect(res.status).toBe(200)

    // Verify
    const { body } = await get('/api/pages/update-test')
    expect(body.content.title).toBe('Updated Title')
  })

  it('returns 404 for missing page', async () => {
    const res = await app.request('/api/pages/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 with VALIDATION_FAILED when save introduces a missing asset ref', async () => {
    // Create a clean page first
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'val-test', template: 'page-default' }),
    })
    // Update with content that references a non-existent asset
    const res = await app.request('/api/pages/val-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { hero: { _asset: 'definitely-not-an-asset-name' } } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; issues: Array<{ validator: string; message: string }> }
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(body.issues.some(i => i.validator === 'referenced-asset-exists')).toBe(true)
    expect(body.issues.some(i => i.message.includes('definitely-not-an-asset-name'))).toBe(true)
    // Cleanup
    await rm(resolve(localTargetDir, 'pages/val-test'), { recursive: true, force: true })
  })

  it('returns 409 when a fragment ref is introduced that does not exist', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'val-frag-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/val-frag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: ['@nonexistent-fragment'] }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; issues: Array<{ validator: string }> }
    expect(body.issues.some(i => i.validator === 'referenced-fragment-exists')).toBe(true)
    await rm(resolve(localTargetDir, 'pages/val-frag-test'), { recursive: true, force: true })
  })
})

describe('PUT /api/pages/:name (metadata round-trip)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'pages/meta-test'), { recursive: true, force: true })
  })

  it('saves and retrieves metadata', async () => {
    // Create page
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'meta-test', template: 'page-default' }),
    })

    // Set metadata
    const res = await app.request('/api/pages/meta-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          title: 'SEO Title',
          description: 'SEO desc',
          ogImage: '/img.jpg',
          canonical: 'https://example.com/meta-test',
          robots: 'noindex',
        },
      }),
    })
    expect(res.status).toBe(200)

    // Verify round-trip
    const { body } = await get('/api/pages/meta-test')
    expect(body.metadata).toEqual({
      title: 'SEO Title',
      description: 'SEO desc',
      ogImage: '/img.jpg',
      canonical: 'https://example.com/meta-test',
      robots: 'noindex',
    })
  })

  it('preserves metadata when updating only content', async () => {
    // Update content only — metadata should be preserved
    const res = await app.request('/api/pages/meta-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'New Content Title' } }),
    })
    expect(res.status).toBe(200)

    const { body } = await get('/api/pages/meta-test')
    expect(body.content.title).toBe('New Content Title')
    expect(body.metadata.title).toBe('SEO Title')
    expect(body.metadata.robots).toBe('noindex')
  })

  it('clears metadata when explicitly set to empty object', async () => {
    const res = await app.request('/api/pages/meta-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: {} }),
    })
    expect(res.status).toBe(200)

    const { body } = await get('/api/pages/meta-test')
    expect(body.metadata).toEqual({})
  })
})

describe('PUT /api/pages/:name (update component content)', () => {
  it('updates page with modified component content', async () => {
    // Read current page
    const { body: page } = await get('/api/pages/home')
    const components = page.components.map((c: any) => {
      if (typeof c === 'object' && c.name === 'hero') {
        return { ...c, content: { title: 'Updated Hero', subtitle: 'New subtitle' } }
      }
      return c
    })

    // Update page
    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components }),
    })
    expect(res.status).toBe(200)

    // Verify
    const { body: updated } = await get('/api/pages/home')
    const hero = updated.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
    expect(hero.content.title).toBe('Updated Hero')

    // Restore original
    const restored = updated.components.map((c: any) => {
      if (typeof c === 'object' && c.name === 'hero') {
        return {
          ...c,
          content: {
            title: 'Welcome to Gazetta',
            subtitle: 'A stateless CMS that composes pages from reusable components',
          },
        }
      }
      return c
    })
    await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: restored }),
    })
  })
})

describe('DELETE /api/pages/:name', () => {
  it('deletes a page', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', template: 'page-default' }),
    })

    const res = await app.request('/api/pages/to-delete', { method: 'DELETE' })
    expect(res.status).toBe(200)

    const { body: pages } = await get('/api/pages')
    expect(pages.some((p: { name: string }) => p.name === 'to-delete')).toBe(false)
  })

  it('returns 404 for missing page', async () => {
    const res = await app.request('/api/pages/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/fragments (create)', () => {
  afterAll(async () => {
    await rm(resolve(localTargetDir, 'fragments/test-frag'), { recursive: true, force: true })
  })

  it('creates a new fragment', async () => {
    const res = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-frag', template: 'footer-layout' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('rejects missing fields', async () => {
    const res = await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/fragments/:name', () => {
  it('deletes a fragment', async () => {
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete-frag', template: 'footer-layout' }),
    })

    const res = await app.request('/api/fragments/to-delete-frag', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('returns 404 for missing fragment', async () => {
    const res = await app.request('/api/fragments/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

// Component create/delete is now done via PUT /api/pages/:name (update components array)
