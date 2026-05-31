/**
 * Integration tests for Cut 3 of redirect-ui — POST /api/page-redirects
 * and POST /api/fragment-redirects.
 *
 * Per `design-redirect-ui.md` Q2 (endpoint shape), Q4 (live-name
 * collision + normalize + edge-case rejections), Q7 (audit event),
 * Q8 (capability gate `edit:pages` / `edit:fragments`).
 *
 * Test-tier: API-first per `testing-plan.md`'s shape-per-sub-system
 * row for admin-API. Routes exercised end-to-end via `app.request()`
 * against `createAdminApp`; happy path + every error / branch in the
 * acceptance bullets gets its own test.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. No module-level state.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import type { SiteManifest } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

interface SetupOpts {
  seed?: Record<string, string>
  /**
   * Optional auth config to inject under `manifest.admin.auth`.
   * Omitting falls back to `none` mode (admin with `*` capability) —
   * useful for happy-path + non-capability error tests. Supplying a
   * forwarded-user config with a viewer roleMapping is how the 403
   * tests exercise the capability gate.
   */
  auth?: SiteManifest['admin'] extends infer A ? (A extends { auth: infer V } ? V : never) : never
}

function setup(opts: SetupOpts = {}) {
  storage = memoryStorage()
  storage.seed({
    // Live pages used as alias targets + live-name conflicts.
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/products/featured/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/products/featured/page.fr.json': JSON.stringify({
      template: 'page-default',
      content: { title: 'En vedette' },
    }),
    // Existing live fragment + alias target for fragment redirects.
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout', content: {} }),
    ...(opts.seed ?? {}),
  })

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  // Wire history so the "exactly ONE history revision per success"
  // assertion can read from `.gazetta/history/index.json`.
  const history = createHistoryProvider({ storage })
  const manifest: SiteManifest = {
    name: 'test-site',
    targets: targetConfigs,
    locales: { default: 'en', supported: ['en', 'fr'] },
    ...(opts.auth ? { admin: { auth: opts.auth } } : {}),
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest,
    history,
  })
  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await storage.readFile(path)
  return JSON.parse(raw) as Record<string, unknown>
}

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader' })
  return reader.query!({})
}

async function readHistoryRevisions(): Promise<unknown[]> {
  if (!(await storage.exists('.gazetta/history/index.json'))) return []
  const raw = await storage.readFile('.gazetta/history/index.json')
  const index = JSON.parse(raw) as { revisions?: unknown[] }
  return index.revisions ?? []
}

// Headers a forwarded-user-mode request needs to be admitted.
const FU_HEADERS = {
  'Content-Type': 'application/json',
  'X-Forwarded-User': 'alice@example.com',
  'X-Forwarded-Email': 'alice@example.com',
  'X-Forwarded-Groups': 'somegroup',
}

describe('POST /api/page-redirects — happy paths', () => {
  beforeEach(() => setup())

  it('creates a page redirect with archive fields + 201 + correct response shape', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      ok: true,
      from: 'old-products',
      to: 'products/featured',
      kind: 'page',
      route: '/old-products',
      targetRoute: '/products/featured',
    })

    // Manifest written at the normalized path with archive fields, no template.
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('products/featured')
    expect(typeof manifest.archivedAt).toBe('string')
    expect(typeof manifest.archivedBy).toBe('string')
    expect(manifest.template).toBeUndefined()
  })

  it('creates a fragment redirect at fragments/{from}/fragment.json', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('fragment')
    expect(body.from).toBe('old-header')
    expect(body.to).toBe('header')

    const manifest = await readJson('fragments/old-header/fragment.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('header')
    expect(manifest.template).toBeUndefined()
  })
})

describe('POST /api/page-redirects — from-route normalization (Q4 lock)', () => {
  beforeEach(() => setup())

  it('strips leading slash — /old-products and old-products produce same manifest path', async () => {
    const r1 = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/old-products', to: 'products/featured' }),
    })
    expect(r1.status).toBe(201)
    const b1 = (await r1.json()) as Record<string, unknown>
    expect(b1.from).toBe('old-products')

    // Manifest path is the normalized name.
    expect(await storage.exists('pages/old-products/page.json')).toBe(true)
  })
})

describe('POST /api/page-redirects — edge-case rejections (absorbs old Cut 5)', () => {
  beforeEach(() => setup())

  it('rejects from="home" with 400 INVALID and a clear message', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'home', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect(typeof body.error).toBe('string')
    expect((body.error as string).toLowerCase()).toContain('home')
  })

  it('rejects from="blog/[slug]" with 400 INVALID — wildcards not supported', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'blog/[slug]', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
    expect((body.error as string).toLowerCase()).toMatch(/wildcard|param|slug/)
  })

  it('rejects from="blog/:slug" with 400 INVALID — normalizes to wildcard then rejects', async () => {
    // Q4 normalize: `:param` → `[param]`. Per the acceptance bullet,
    // `from: 'blog/:slug'` normalizes to `blog/[slug]` which IS a
    // wildcard pattern → reject.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'blog/:slug', to: 'about' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('INVALID')
  })
})

describe('POST /api/page-redirects — collision handling', () => {
  beforeEach(() => setup())

  it('rejects with 409 LIVE_NAME_CONFLICT when from is a live page', async () => {
    // `about` is a live page in the seed.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'about', to: 'products/featured' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('LIVE_NAME_CONFLICT')
    // Per Q4 lock — clear "no destructive shortcut" message.
    expect((body.error as string).toLowerCase()).toContain('about')
  })

  it('rejects with 409 ALIAS_TARGET_NOT_FOUND when to does not resolve', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'does-not-exist' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('ALIAS_TARGET_NOT_FOUND')
    expect((body.error as string).toLowerCase()).toContain('does-not-exist')
  })

  it('rejects with 409 ARCHIVED_NAME_CONFLICT when from is already archived', async () => {
    // Archive 'old-products' first by creating a redirect, then try to re-create.
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })

    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; archive: Record<string, unknown> }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.archive.kind).toBe('page')
    expect(body.archive.name).toBe('old-products')
    expect(body.archive.aliasOf).toBe('home')
  })

  it('?onConflict=restore unarchives existing + skips re-create', async () => {
    // Create the first redirect pointing at 'home'.
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    // Retry with restore — should unarchive (strip archive fields).
    const res = await app.request('/api/page-redirects?onConflict=restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)

    // Manifest should now be live (archive fields stripped).
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.archived).toBeUndefined()
    expect(manifest.aliasOf).toBeUndefined()
  })

  it('?onConflict=replace purges old archive + creates new redirect atomically', async () => {
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    const res = await app.request('/api/page-redirects?onConflict=replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)

    // New redirect — points at products/featured, NOT home.
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('products/featured')
  })

  it('?onConflict=moveAside renames old archive with date suffix + creates new', async () => {
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'home' }),
    })
    const res = await app.request('/api/page-redirects?onConflict=moveAside', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    // New redirect lives at the original name.
    const manifest = await readJson('pages/old-products/page.json')
    expect(manifest.aliasOf).toBe('products/featured')
    // Old archive lives at `<name>-archived-<YYYYMMDD>`.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    expect(await storage.exists(`pages/old-products-archived-${today}/page.json`)).toBe(true)
  })
})

describe('POST /api/page-redirects — audit + history (Q7 lock)', () => {
  beforeEach(() => setup())

  it('emits exactly ONE audit event with action create-redirect + correct metadata', async () => {
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'create-redirect' && e.scope.kind === 'page' && e.scope.name === 'old-products',
    )
    expect(matched).toHaveLength(1)
    const event = matched[0]
    expect(event.outcome).toBe('success')
    expect(event.metadata?.aliasOf).toBe('products/featured')
    // Default `none`-mode wiring → admin actor.
    expect(event.actor.role).toBe('admin')
  })

  it('emits exactly ONE audit event for fragment redirect with scope.kind: fragment', async () => {
    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(201)

    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'create-redirect' && e.scope.kind === 'fragment' && e.scope.name === 'old-header',
    )
    expect(matched).toHaveLength(1)
    expect(matched[0].metadata?.aliasOf).toBe('header')
  })

  it('records exactly ONE history revision per success', async () => {
    // Pre-warm history with a baseline write so the redirect creation
    // produces exactly ONE NEW revision (not 2 — `recordWrite` creates
    // a baseline revision on the very first write to a target, capturing
    // pre-write state; subsequent writes record one revision each).
    await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'warmup-redirect', to: 'home' }),
    })
    const before = (await readHistoryRevisions()).length

    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)

    const after = (await readHistoryRevisions()).length
    expect(after - before).toBe(1)
  })
})

describe('POST /api/page-redirects — locale-variant alias target (Q4 verification)', () => {
  beforeEach(() => setup())

  it('accepts alias target that has locale variants (aliasOf is locale-agnostic per soft-delete Q1)', async () => {
    // `products/featured` has both default + French variants in the seed.
    // The redirect's `aliasOf` resolves to the name (not the URL or locale).
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-promo', to: 'products/featured' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.aliasOf === undefined || body.aliasOf === 'products/featured').toBe(true)
    expect(body.to).toBe('products/featured')

    const manifest = await readJson('pages/old-promo/page.json')
    expect(manifest.aliasOf).toBe('products/featured')
  })
})

describe('POST /api/page-redirects — capability gate (Q8 lock: edit:pages)', () => {
  it('returns 403 FORBIDDEN with code FORBIDDEN when principal lacks edit:pages', async () => {
    // Forwarded-user trust with a roleMapping that resolves to viewer
    // (built-in viewer has `read:*` only — no `edit:pages`).
    setup({
      auth: {
        trust: 'forwarded-user',
        allowAnyOrigin: true,
        roleMapping: {
          claim: 'groups',
          map: { admins: 'admin', editors: 'editor', viewers: 'viewer' },
          defaultRole: 'viewer',
        },
      },
    })

    // X-Forwarded-Groups: somegroup → no match → defaultRole 'viewer' →
    // viewer lacks edit:pages.
    const res = await app.request('/api/page-redirects', {
      method: 'POST',
      headers: FU_HEADERS,
      body: JSON.stringify({ from: 'old-products', to: 'products/featured' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:pages'])
    expect(body.role).toBe('viewer')
  })
})

describe('POST /api/fragment-redirects — capability gate (Q8 lock: edit:fragments)', () => {
  it('returns 403 FORBIDDEN with code FORBIDDEN when principal lacks edit:fragments', async () => {
    setup({
      auth: {
        trust: 'forwarded-user',
        allowAnyOrigin: true,
        roleMapping: {
          claim: 'groups',
          map: { admins: 'admin', editors: 'editor', viewers: 'viewer' },
          defaultRole: 'viewer',
        },
      },
    })

    const res = await app.request('/api/fragment-redirects', {
      method: 'POST',
      headers: FU_HEADERS,
      body: JSON.stringify({ from: 'old-header', to: 'header' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:fragments'])
    expect(body.role).toBe('viewer')
  })
})
