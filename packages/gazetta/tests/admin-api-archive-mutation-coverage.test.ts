/**
 * Mutation-coverage tests for `admin-api/routes/archive.ts` — closes
 * surviving / no-coverage mutants identified by the StrykerJS run
 * (issue #309). Coverage gaps targeted:
 *
 *  - StringLiteral mutants on `PAGE_HANDLE.label` / `FRAGMENT_HANDLE.label`
 *    (`'Page'` / `'Fragment'`) — current tests assert status codes but
 *    not error-message bodies, so replacing the labels with `''` doesn't
 *    fail any assertion. Pinning error messages catches this class.
 *
 *  - NoCoverage on the PATCH `/api/fragments/:name/alias` route
 *    registration + the `handleSetAlias` fragment branch — the existing
 *    fragment-alias test in `admin-api-archive.test.ts` is a single
 *    happy-path case; this file pins the same matrix the page-alias
 *    tests cover (404 / 409 / 400 / drop / idempotent / move sidecar).
 *
 *  - NoCoverage / surviving ObjectLiteral on `notifyScanner` for the
 *    `setAlias` code path — `admin-api-archive-scanner.test.ts` covers
 *    archive / unarchive / purge but does NOT exercise PATCH `/alias`,
 *    so the scanner notification on that branch survives mutation.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. No module-level state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext, type SourceContext } from '../src/admin-api/source-context.js'
import type { RescanCause, ValidationScanner } from '../src/validation/scanner.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage
let source: SourceContext
let rescanCalls: RescanCause[]
let stubScanner: ValidationScanner

function setup(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/top-bar/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    ...seed,
  })

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })

  rescanCalls = []
  stubScanner = {
    scanAll: vi.fn().mockResolvedValue(undefined),
    rescan: vi.fn(async (cause: RescanCause) => {
      rescanCalls.push(cause)
    }),
    getIssues: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as ValidationScanner

  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    validationScanner: stubScanner,
  })
}

/**
 * Variant of `setup()` that intentionally OMITS `targetConfigs` so
 * `createAdminApp` uses `staticSourceResolver(source)` and every
 * route resolves to the same bootstrap `source` instance we spy on.
 *
 * `setup()`'s `registrySourceResolver` path builds a fresh
 * SourceContext (with its own fresh `memoryCache()`) inside
 * `createSourceContextFromRegistry` for each requested target — the
 * bootstrap source's cache is orthogonal to what routes actually
 * touch, so spying on `source.cache.invalidatePrefix` there would
 * always see zero calls.
 */
function setupStaticResolver(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/top-bar/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    ...seed,
  })

  source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: {} },
  })

  rescanCalls = []
  stubScanner = {
    scanAll: vi.fn().mockResolvedValue(undefined),
    rescan: vi.fn(async (cause: RescanCause) => {
      rescanCalls.push(cause)
    }),
    getIssues: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as ValidationScanner

  // No `targetConfigs` — createAdminApp uses staticSourceResolver(source),
  // so all route requests resolve to the bootstrap source. That makes
  // `vi.spyOn(source.cache, 'invalidatePrefix')` observe the route's
  // actual invalidation calls.
  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    disableCacheStatsLogger: true,
    validationScanner: stubScanner,
  })
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await storage.readFile(path)
  return JSON.parse(raw) as Record<string, unknown>
}

describe('Error message labels — pin PAGE_HANDLE.label / FRAGMENT_HANDLE.label', () => {
  beforeEach(() => setup())

  // The label string IS the load-bearing piece: the surviving StringLiteral
  // mutants replace `'Page'` / `'Fragment'` with `''`. Without these
  // assertions, the error body becomes ` "name" not found` (leading space)
  // and no test fails. Asserting the exact body kills the mutant.

  it('POST /api/pages/missing/archive → 404 body uses "Page" label', async () => {
    const res = await app.request('/api/pages/missing/archive', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Page "missing" not found')
  })

  it('POST /api/pages/missing/unarchive → 404 body uses "Page" label', async () => {
    const res = await app.request('/api/pages/missing/unarchive', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Page "missing" not found')
  })

  it('DELETE /api/pages/missing/purge → 404 body uses "Page" label', async () => {
    const res = await app.request('/api/pages/missing/purge', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Page "missing" not found')
  })

  it('PATCH /api/pages/missing/alias → 404 body uses "Page" label', async () => {
    const res = await app.request('/api/pages/missing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Page "missing" not found')
  })

  it('PATCH /api/pages/home/alias on a live page → 409 body uses "Page" label', async () => {
    const res = await app.request('/api/pages/home/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'landing' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Page "home" is not archived; cannot set alias on a live item')
  })

  it('POST /api/fragments/missing/archive → 404 body uses "Fragment" label', async () => {
    const res = await app.request('/api/fragments/missing/archive', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Fragment "missing" not found')
  })

  it('POST /api/fragments/missing/unarchive → 404 body uses "Fragment" label', async () => {
    const res = await app.request('/api/fragments/missing/unarchive', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Fragment "missing" not found')
  })

  it('DELETE /api/fragments/missing/purge → 404 body uses "Fragment" label', async () => {
    const res = await app.request('/api/fragments/missing/purge', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Fragment "missing" not found')
  })

  it('PATCH /api/fragments/missing/alias → 404 body uses "Fragment" label', async () => {
    const res = await app.request('/api/fragments/missing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Fragment "missing" not found')
  })

  it('PATCH /api/fragments/header/alias on a live fragment → 409 body uses "Fragment" label', async () => {
    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'footer' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Fragment "header" is not archived; cannot set alias on a live item')
  })
})

describe('PATCH /api/fragments/:name/alias — full parity matrix with pages', () => {
  beforeEach(() => setup())

  // The pages PATCH alias route has 8 tests in admin-api-archive.test.ts;
  // fragments has only 1 ("works for fragments (parity with pages)").
  // The NoCoverage on the fragment alias route registration survives
  // because the fragment branch of handleSetAlias is barely exercised.
  // These tests pin the full matrix.

  it('sets aliasOf on an archived fragment + writes the sidecar', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; aliasOf?: string }
    expect(body.ok).toBe(true)
    expect(body.aliasOf).toBe('top-bar')
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.aliasOf).toBe('top-bar')
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(true)
  })

  it('drops aliasOf when set to null + tears down sidecar', async () => {
    await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(true)

    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(res.status).toBe(200)
    const manifest = await readJson('fragments/header/fragment.json')
    expect(manifest.aliasOf).toBeUndefined()
    expect(manifest.archived).toBe(true) // still archived; only alias dropped
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(false)
  })

  it('moves the sidecar when alias target changes (top-bar → footer)', async () => {
    await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(true)

    await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'footer' }),
    })
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(false)
    expect(await storage.exists('.gazetta/alias-targets/footer/fragments.header')).toBe(true)
  })

  it('returns 400 on missing aliasOf field', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('idempotent — same alias returns 200 without rewriting', async () => {
    await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    const before = await readJson('fragments/header/fragment.json')
    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(res.status).toBe(200)
    const after = await readJson('fragments/header/fragment.json')
    expect(after).toEqual(before)
  })
})

describe('notifyScanner — PATCH /alias must notify the validation scanner', () => {
  beforeEach(() => setup())

  // The `notifyScanner` body and the `setAlias` call to it have
  // NoCoverage on the corresponding lines of archive.ts. Pages +
  // fragments archive/unarchive/purge are covered by
  // admin-api-archive-scanner.test.ts; PATCH /alias is not.

  it('PATCH /api/pages/:name/alias triggers rescan with page scope', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    rescanCalls.length = 0 // ignore the archive's rescan

    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)

    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'page', name: 'landing', itemPath: 'pages/landing/page.json' },
    })
  })

  it('PATCH /api/fragments/:name/alias triggers rescan with fragment scope', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    rescanCalls.length = 0

    const res = await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(res.status).toBe(200)

    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'fragment', name: 'header', itemPath: 'fragments/header/fragment.json' },
    })
  })

  it('PATCH /alias with null (drop) still notifies the scanner', async () => {
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    rescanCalls.length = 0

    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: null }),
    })
    expect(res.status).toBe(200)

    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'page', name: 'landing' },
    })
  })

  it('idempotent PATCH /alias (no change) does NOT notify the scanner', async () => {
    // Pins the early-return path in handleSetAlias: when the new
    // aliasOf equals the current one, the manifest isn't rewritten,
    // so notifyScanner shouldn't fire either. Catches a future
    // regression that drops the early-return.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    rescanCalls.length = 0

    const res = await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)

    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(0)
  })
})

describe('Cache invalidation — pin `source.cache.invalidatePrefix` calls', () => {
  // Kills the highest-blast-radius cluster on lines 299-302 + 300 + 301
  // of archive.ts:
  //
  //   await Promise.all([
  //     source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
  //     handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  //   ])
  //
  // Surviving mutants:
  //   - ArrayDeclaration → `[]` : both invalidatePrefix calls skipped
  //   - StringLiteral on line 300 → `` `` `` : wrong prefix invalidated
  //   - ConditionalExpression on line 301 → `true` : page archives also invalidate `pages:` twice
  //
  // Cache invalidation on fragment archive is load-bearing per
  // `design-cache.md` Q2 — fragments referenced by pages must
  // invalidate the pages summary cache too, or authors see stale
  // page state after a fragment archive.
  //
  // These tests use `setupStaticResolver()` (no `targetConfigs`) so
  // routes resolve to the SAME `source` instance we spy on — the
  // default `setup()` uses `registrySourceResolver` which builds a
  // fresh SourceContext (with its own cache) per resolved target,
  // making the bootstrap source's cache unreachable from routes.

  beforeEach(() => setupStaticResolver())

  it('POST /pages/:name/archive → invalidatePrefix("pages:") called exactly once', async () => {
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    expect(spy).toHaveBeenCalledWith('pages:')
    // Page archive must NOT invalidate the fragments prefix, and must
    // NOT invalidate the pages prefix twice (the mutant on line 301
    // that flips the conditional to `true` would do the latter).
    expect(spy).not.toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('POST /fragments/:name/archive → invalidatePrefix called with BOTH "fragments:" and "pages:"', async () => {
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    expect(spy).toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('POST /pages/:name/unarchive → invalidatePrefix("pages:") called exactly once', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/pages/landing/unarchive', { method: 'POST' })
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).not.toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('POST /fragments/:name/unarchive → invalidatePrefix called with BOTH "fragments:" and "pages:"', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/fragments/header/unarchive', { method: 'POST' })
    expect(spy).toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('PATCH /pages/:name/alias → invalidatePrefix("pages:") called exactly once', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/pages/landing/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).not.toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('PATCH /fragments/:name/alias → invalidatePrefix called with BOTH "fragments:" and "pages:"', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/fragments/header/alias', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })
    expect(spy).toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('DELETE /pages/:name/purge → invalidatePrefix("pages:") called exactly once', async () => {
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/pages/landing/purge', { method: 'DELETE' })
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).not.toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('DELETE /fragments/:name/purge → invalidatePrefix called with BOTH "fragments:" and "pages:"', async () => {
    await app.request('/api/fragments/header/archive', { method: 'POST' })
    const spy = vi.spyOn(source.cache, 'invalidatePrefix')
    await app.request('/api/fragments/header/purge', { method: 'DELETE' })
    expect(spy).toHaveBeenCalledWith('fragments:')
    expect(spy).toHaveBeenCalledWith('pages:')
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('Idempotent archive-return with aliasOf field (line 267)', () => {
  // Kills the ObjectLiteral mutant on line 267:
  //   ...(manifest.aliasOf ? { aliasOf: manifest.aliasOf } : {})
  //
  // Mutating to `...{}` means aliasOf never appears in the response
  // body for the idempotent-return path (already-archived items).
  // The current happy-path test in admin-api-archive.test.ts asserts
  // `ok: true` on the second archive but never inspects `aliasOf` on
  // the response — the mutant survives that assertion. These tests
  // pin the round-trip contract of the response body.

  beforeEach(() => setup())

  it('archive already-archived page WITH aliasOf → response includes aliasOf', async () => {
    // First archive sets aliasOf.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })

    // Second archive hits the idempotent-return branch (line 262-269).
    // Response body must round-trip the aliasOf from the existing
    // manifest. Mutant on line 267 spreads `{}` instead of `{aliasOf}`,
    // dropping the field.
    const res = await app.request('/api/pages/landing/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; archivedAt: string; aliasOf?: string }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('landing')
    expect(body.aliasOf).toBe('home')
  })

  it('archive already-archived page WITHOUT aliasOf → response omits aliasOf', async () => {
    // Pure soft-delete (no aliasOf).
    await app.request('/api/pages/about/archive', { method: 'POST' })

    // Second archive — idempotent-return. Response body should NOT
    // contain aliasOf (existing manifest has none). Pins the truthy
    // check on line 267 — a mutant like `manifest.aliasOf ? ... : { aliasOf: manifest.aliasOf }`
    // (inverting the ternary) would surface an aliasOf-undefined field.
    const res = await app.request('/api/pages/about/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; aliasOf?: string }
    expect(body.ok).toBe(true)
    expect(body.aliasOf).toBeUndefined()
    // Distinct from `undefined` after JSON round-trip — the field
    // should be entirely absent from the response.
    expect('aliasOf' in body).toBe(false)
  })

  it('archive already-archived fragment WITH aliasOf → response includes aliasOf (parity with pages)', async () => {
    await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'top-bar' }),
    })

    const res = await app.request('/api/fragments/header/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; aliasOf?: string }
    expect(body.aliasOf).toBe('top-bar')
  })
})
