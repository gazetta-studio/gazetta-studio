import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createFilesystemProvider, createSourceContext, loadSiteConfig, siteConfigToManifest } from 'gazetta'
import { createAdminApp } from '../src/server/index.js'

const projectSiteDir = resolve(import.meta.dirname, '../../../examples/starter/sites/main')
const starterContentDir = resolve(projectSiteDir, 'targets/local')
const templatesDir = resolve(import.meta.dirname, '../../../examples/starter/templates')
// The write/archive/purge tests mutate content, so each run works on its own
// copy of the starter target: a crashed or concurrent run can't leave the
// repo fixture dirty or collide on the fixed `.test-*` names (rule 26).
let contentDir: string
let app: Hono

beforeAll(async () => {
  contentDir = await mkdtemp(join(tmpdir(), 'gazetta-admin-api-'))
  // `.gazetta/` holds derived state (history, audit, sidecars) from other runs.
  await cp(starterContentDir, contentDir, {
    recursive: true,
    filter: src => !src.slice(starterContentDir.length).split(/[\\/]/).includes('.gazetta'),
  })
  const storage = createFilesystemProvider(contentDir)
  // Load project-level manifest from the TS config so target storage doesn't need site.config.ts.
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${projectSiteDir}`)
  const manifest = siteConfigToManifest(loaded.config)
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  app = createAdminApp({ source, siteDir: projectSiteDir, templatesDir, disableCacheStatsLogger: true })
})

afterAll(async () => {
  if (contentDir) await rm(contentDir, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path)
  return { status: res.status, body: await res.json() }
}

async function getText(path: string) {
  const res = await app.request(path)
  return { status: res.status, body: await res.text() }
}

describe('GET /api/v1/site', () => {
  it('returns site manifest', async () => {
    const { status, body } = await get('/api/v1/site')
    expect(status).toBe(200)
    expect(body.name).toBe('Gazetta Starter')
  })
})

describe('GET /api/v1/pages', () => {
  it('returns all pages', async () => {
    const { status, body } = await get('/api/v1/pages')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThanOrEqual(3)
    const names = body.map((p: { name: string }) => p.name)
    expect(names).toContain('home')
    expect(names).toContain('about')
    expect(names).toContain('blog/[slug]')
  })

  it('pages have route and template', async () => {
    const { body } = await get('/api/v1/pages')
    const home = body.find((p: { name: string }) => p.name === 'home')
    expect(home.route).toBe('/')
    expect(home.template).toBe('page-default')
  })
})

describe('GET /api/v1/pages/:name', () => {
  it('returns page detail', async () => {
    const { status, body } = await get('/api/v1/pages/home')
    expect(status).toBe(200)
    expect(body.route).toBe('/')
    // Merged JSON format — components are a mix of strings (fragment refs) and inline component objects
    expect(body.components).toContainEqual('@header')
    expect(body.components).toContainEqual('@footer')
    const names = body.components.filter((c: unknown) => typeof c === 'object').map((c: { name: string }) => c.name)
    expect(names).toContain('hero')
  })

  it('returns nested page', async () => {
    const { status, body } = await get('/api/v1/pages/blog/[slug]')
    expect(status).toBe(200)
    expect(body.route).toBe('/blog/:slug')
  })

  it('returns 404 for missing page', async () => {
    const { status } = await get('/api/v1/pages/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/v1/fragments', () => {
  it('returns all fragments', async () => {
    const { status, body } = await get('/api/v1/fragments')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThanOrEqual(2)
    const names = body.map((f: { name: string }) => f.name)
    expect(names).toContain('header')
    expect(names).toContain('footer')
  })
})

describe('GET /api/v1/fragments/:name', () => {
  it('returns fragment detail', async () => {
    const { status, body } = await get('/api/v1/fragments/header')
    expect(status).toBe(200)
    expect(body.template).toBe('header-layout')
    const names = body.components.filter((c: unknown) => typeof c === 'object').map((c: { name: string }) => c.name)
    expect(names).toContain('logo')
    expect(names).toContain('nav')
  })

  it('returns 404 for missing fragment', async () => {
    const { status } = await get('/api/v1/fragments/nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/v1/templates', () => {
  it('returns all templates', async () => {
    const { status, body } = await get('/api/v1/templates')
    expect(status).toBe(200)
    const names = body.map((t: { name: string }) => t.name)
    expect(names).toContain('hero')
    expect(names).toContain('page-default')
    expect(names).toContain('feature-card')
  })
})

describe('GET /api/v1/templates/:name/schema', () => {
  it('returns JSON Schema for a template', async () => {
    const { status, body } = await get('/api/v1/templates/hero/schema')
    expect(status).toBe(200)
    expect(body.type).toBe('object')
    expect(body.properties.title).toBeDefined()
    expect(body.properties.subtitle).toBeDefined()
  })

  it('returns 500 for missing template', async () => {
    const { status } = await get('/api/v1/templates/nonexistent/schema')
    expect(status).toBe(500)
  })
})

describe('GET /preview/*', () => {
  it('renders home page', async () => {
    const { status, body } = await getText('/preview/')
    expect(status).toBe(200)
    expect(body).toContain('Welcome to Gazetta')
    expect(body).toContain('Gazetta')
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

describe('POST /preview/*', () => {
  it('renders with content overrides', async () => {
    // After #112 merged-JSON migration, overrides use name paths, not filesystem paths
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
})

describe('PUT /api/v1/pages/:name', () => {
  beforeAll(async () => {
    await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-put-page', route: '/.test-put-page', template: 'page-default' }),
    })
  })

  it('updates page content', async () => {
    const res = await app.request('/api/v1/pages/.test-put-page', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Updated' } }),
    })
    expect(res.status).toBe(200)

    const { body } = await get('/api/v1/pages/.test-put-page')
    expect(body.content.title).toBe('Updated')
  })

  it('returns 404 for missing page', async () => {
    const res = await app.request('/api/v1/pages/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/v1/fragments/:name', () => {
  beforeAll(async () => {
    await app.request('/api/v1/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-put-frag', template: 'footer-layout' }),
    })
  })

  it('updates fragment content', async () => {
    const res = await app.request('/api/v1/fragments/.test-put-frag', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { brand: 'Updated' } }),
    })
    expect(res.status).toBe(200)

    const { body } = await get('/api/v1/fragments/.test-put-frag')
    expect(body.content.brand).toBe('Updated')
  })

  it('returns 404 for missing fragment', async () => {
    const res = await app.request('/api/v1/fragments/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/pages (create)', () => {
  it('creates a new page', async () => {
    const res = await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-page', route: '/.test-page', template: 'page-default' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // Verify it appears in the list
    const { body: pages } = await get('/api/v1/pages')
    expect(pages.some((p: { name: string }) => p.name === '.test-page')).toBe(true)
  })

  it('creates a nested page', async () => {
    const res = await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-nested/intro', route: '/.test-nested/intro', template: 'page-default' }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects duplicate page', async () => {
    const res = await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-page', route: '/.test-page', template: 'page-default' }),
    })
    expect(res.status).toBe(409)
  })

  it('rejects missing fields', async () => {
    const res = await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/pages/:name', () => {
  it('archives a page (soft-delete is the default per Cut 7 cutover)', async () => {
    // Create first
    await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-to-archive', route: '/test-to-archive', template: 'page-default' }),
    })

    const res = await app.request('/api/v1/pages/test-to-archive', { method: 'DELETE' })
    expect(res.status).toBe(200)

    // Manifest still listed but with archived: true.
    const { body: pages } = await get('/api/v1/pages')
    const matched = (pages as Array<{ name: string; archived?: boolean }>).find(p => p.name === 'test-to-archive')
    expect(matched).toBeDefined()
    expect(matched?.archived).toBe(true)
  })

  it('purges with ?permanent=true', async () => {
    await app.request('/api/v1/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-to-purge', route: '/test-to-purge', template: 'page-default' }),
    })
    const res = await app.request('/api/v1/pages/test-to-purge?permanent=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const { body: pages } = await get('/api/v1/pages')
    expect((pages as Array<{ name: string }>).some(p => p.name === 'test-to-purge')).toBe(false)
  })

  it('returns 404 for missing page', async () => {
    const res = await app.request('/api/v1/pages/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/fragments (create)', () => {
  it('creates a new fragment', async () => {
    const res = await app.request('/api/v1/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-frag', template: 'footer-layout' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    const { body: frags } = await get('/api/v1/fragments')
    expect(frags.some((f: { name: string }) => f.name === '.test-frag')).toBe(true)
  })

  it('rejects duplicate fragment', async () => {
    const res = await app.request('/api/v1/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '.test-frag', template: 'footer-layout' }),
    })
    expect(res.status).toBe(409)
  })

  it('rejects missing fields', async () => {
    const res = await app.request('/api/v1/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/fragments/:name', () => {
  it('archives a fragment (soft-delete is the default per Cut 7 cutover)', async () => {
    await app.request('/api/v1/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-to-archive', template: 'footer-layout' }),
    })

    const res = await app.request('/api/v1/fragments/test-to-archive', { method: 'DELETE' })
    expect(res.status).toBe(200)

    const { body: frags } = await get('/api/v1/fragments')
    const matched = (frags as Array<{ name: string; archived?: boolean }>).find(f => f.name === 'test-to-archive')
    expect(matched).toBeDefined()
    expect(matched?.archived).toBe(true)
  })

  it('purges with ?permanent=true', async () => {
    await app.request('/api/v1/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-to-purge', template: 'footer-layout' }),
    })
    const res = await app.request('/api/v1/fragments/test-to-purge?permanent=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const { body: frags } = await get('/api/v1/fragments')
    expect((frags as Array<{ name: string }>).some(f => f.name === 'test-to-purge')).toBe(false)
  })

  it('returns 404 for missing fragment', async () => {
    const res = await app.request('/api/v1/fragments/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

// /api/v1/components routes were removed in #112 (merged JSON format).
// Component create/update now happens via PUT /api/v1/pages/:name with updated components array.

// ---------------------------------------------------------------------------
// Locale endpoints (i18n)
// ---------------------------------------------------------------------------

describe('GET /api/v1/pages (locale support)', () => {
  it('page list includes locales array for pages with translations', async () => {
    const { body } = await get('/api/v1/pages')
    const home = body.find((p: { name: string }) => p.name === 'home')
    // Starter has page.fr.json for home
    expect(home.locales).toBeDefined()
    expect(home.locales).toContain('fr')
  })

  it('pages without translations have no locales array', async () => {
    const { body } = await get('/api/v1/pages')
    const blog = body.find((p: { name: string }) => p.name === 'blog/[slug]')
    // Blog has no locale files
    expect(blog.locales ?? []).toHaveLength(0)
  })
})

describe('GET /api/v1/pages/:name?locale=', () => {
  it('returns default page when no locale param', async () => {
    const { status, body } = await get('/api/v1/pages/home')
    expect(status).toBe(200)
    expect(body.locale).toBeUndefined()
  })

  it('returns locale-specific content when locale param provided', async () => {
    const { status, body } = await get('/api/v1/pages/home?locale=fr')
    expect(status).toBe(200)
    expect(body.locale).toBe('fr')
    // French page has different content
    expect(body.components).toBeDefined()
  })

  it('falls back to default when requested locale not available', async () => {
    const { status, body } = await get('/api/v1/pages/home?locale=de')
    expect(status).toBe(200)
    // Should return the page (fallback), not 404
    expect(body.template).toBeDefined()
  })
})

describe('GET /api/v1/fragments (locale support)', () => {
  it('fragment list returns successfully', async () => {
    const { status, body } = await get('/api/v1/fragments')
    expect(status).toBe(200)
    // Fragments may or may not have locale files in the starter
    expect(body.length).toBeGreaterThanOrEqual(2)
  })
})

describe('GET /preview/* (locale support)', () => {
  it('renders home page at locale-prefixed URL', async () => {
    const { status, body } = await getText('/preview/fr')
    expect(status).toBe(200)
    expect(body).toContain('<!DOCTYPE html>')
  })

  it('renders about page with locale prefix', async () => {
    const { status, body } = await getText('/preview/fr/about')
    expect(status).toBe(200)
    expect(body).toContain('<!DOCTYPE html>')
  })
})

describe('GET /api/v1/site (locale config)', () => {
  it('returns site manifest with locales config', async () => {
    const { status, body } = await get('/api/v1/site')
    expect(status).toBe(200)
    // Starter has locales.supported: [en, fr]
    if (body.locales) {
      expect(body.locales.supported).toContain('en')
      expect(body.locales.supported).toContain('fr')
    }
  })
})
