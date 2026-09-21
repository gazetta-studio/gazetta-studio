/**
 * Mutation-coverage tests for `admin-api/routes/rename.ts` — closes
 * surviving / no-coverage mutants identified by the StrykerJS run
 * (issue #808). Coverage gaps targeted:
 *
 *  - StringLiteral mutants on `PAGE_HANDLE.label` / `FRAGMENT_HANDLE.label`
 *    (`'Page'` / `'Fragment'`) — existing tests assert 404 status but
 *    not the message body, so blanking the label survives. The 404
 *    handler at line 157 renders `${handle.label} "${fromName}" not found`;
 *    asserting exact body kills the mutant.
 *
 *  - NoCoverage on the invalid-JSON catch block (lines 126-128) —
 *    no existing test POSTs a malformed body, so the entire catch
 *    branch (BlockStatement mutant → `{}`, ObjectLiteral mutant on the
 *    400 body, StringLiteral mutant on the error text) survives. POSTing
 *    non-JSON bytes reaches the branch.
 *
 *  - Surviving ObjectLiteral on the Zod safeParse failure body
 *    (lines 132-135) — the existing "400 on missing to field" test
 *    only asserts status; blanking the response body to `{}` survives.
 *    Asserting the `issues[]` shape structurally kills the mutant.
 *
 *  - Audit metadata surfaces — existing tests assert the response body
 *    but never read the audit event. The `metadata` object built at
 *    lines 217-219 has three conditional / literal fields (`fromName`,
 *    `keepAlias`, conditional `flattenedAliases`, conditional
 *    `localeVariants`); each is a mutant candidate. Reading the audit
 *    event and asserting the metadata shape pins them.
 *
 *  - Locale-variant discovery (lines 184-185) — no existing test seeds
 *    a page with locale variants and asserts they surface in the
 *    audit's `metadata.localeVariants`. Renders the whole
 *    `handle.scopeKind === 'page' ?` conditional dead-branchable
 *    without coverage.
 *
 *  - No-op rename response shape (lines 143-152) — existing test
 *    checks status + non-mutation but doesn't assert the response body,
 *    so ObjectLiteral / StringLiteral mutants on the response body
 *    survive. Asserting the full RenameResponse shape kills them.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. No module-level state.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

function setup(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Landing' } }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    ...seed,
  })

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
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

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader-only' })
  return await reader.query!({})
}

describe('Error message labels — pin PAGE_HANDLE.label / FRAGMENT_HANDLE.label', () => {
  beforeEach(() => setup())

  // The label string IS load-bearing: surviving StringLiteral mutants
  // replace `'Page'` / `'Fragment'` with `''`. Without these assertions,
  // the 404 body becomes ` "name" not found` (leading space) and no
  // existing rename test fails. Asserting exact body kills them.

  it('POST /api/pages/missing/rename → 404 body uses "Page" label', async () => {
    const res = await app.request('/api/pages/missing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'whatever' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Page "missing" not found')
  })

  it('POST /api/fragments/missing/rename → 404 body uses "Fragment" label', async () => {
    const res = await app.request('/api/fragments/missing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'whatever' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Fragment "missing" not found')
  })
})

describe('Invalid-body handling — 400 branches', () => {
  beforeEach(() => setup())

  it('malformed JSON body → 400 with "Invalid JSON body" error', async () => {
    // The catch block on lines 126-128 has no coverage — no existing
    // test POSTs bytes that aren't valid JSON. Sending a body that
    // fails c.req.json() reaches the catch and returns the 400.
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json at all }',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Invalid JSON body')
  })

  it('malformed JSON on fragment rename → same 400 shape', async () => {
    const res = await app.request('/api/fragments/header/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json at all }',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Invalid JSON body')
  })

  it('body missing required `to` field → 400 with structured issues[]', async () => {
    // Existing "400 on missing to field" only checks status. The
    // response body's shape (issues[] with path + message) is a
    // surviving ObjectLiteral mutant target. Asserting the shape
    // structurally kills the mutant.
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(body.error).toBe('Invalid request body')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)
    // The Zod error MUST name the missing field.
    const toIssue = body.issues.find(i => i.path === 'to')
    expect(toIssue).toBeDefined()
    expect(toIssue?.message.length).toBeGreaterThan(0)
  })

  it('body with `to` of wrong type → 400 with issues[] naming `to`', async () => {
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 42 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(body.error).toBe('Invalid request body')
    const toIssue = body.issues.find(i => i.path === 'to')
    expect(toIssue).toBeDefined()
  })

  it('body with empty `to` string → 400 with issues[] naming `to`', async () => {
    // Zod `.min(1)` on `to` — empty string fails validation.
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: string
      issues: Array<{ path: string; message: string }>
    }
    expect(body.error).toBe('Invalid request body')
    const toIssue = body.issues.find(i => i.path === 'to')
    expect(toIssue).toBeDefined()
  })
})

describe('No-op rename (to === from) — response body shape', () => {
  beforeEach(() => setup())

  it('returns RenameResponse with name === fromName + empty arrays', async () => {
    // Existing test checks status + non-mutation but not response body.
    // ObjectLiteral mutant on lines 144-150 (`RenameResponse` literal)
    // would replace the object with `{}`, and StringLiteral mutants on
    // any field values would blank them — none of which trip existing
    // assertions. Pin the shape.
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'landing' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      name: string
      fromName: string
      flattenedAliases: string[]
      localeVariants: string[]
    }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('landing')
    expect(body.fromName).toBe('landing')
    expect(body.flattenedAliases).toEqual([])
    expect(body.localeVariants).toEqual([])
  })
})

describe('Audit metadata — pin the metadata literal on line 217-219', () => {
  beforeEach(() => setup())

  // The `metadata` object at lines 217-219 has three write sites:
  //   { fromName, keepAlias }                              (always)
  //   if (flattened.length > 0) metadata.flattenedAliases  (conditional)
  //   if (localeVariants.length > 0) metadata.localeVariants (conditional)
  // Each field + conditional is a mutant candidate. Reading the audit
  // event and asserting the shape covers them.

  it('records action=rename with metadata.fromName + keepAlias=true', async () => {
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'new-landing' }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const renameEvent = events.find(e => e.action === 'rename')
    expect(renameEvent).toBeDefined()
    expect(renameEvent?.outcome).toBe('success')
    expect(renameEvent?.scope).toEqual({ kind: 'page', name: 'new-landing' })
    expect(renameEvent?.metadata).toMatchObject({
      fromName: 'landing',
      keepAlias: true,
    })
    // No flatten happened; metadata should NOT carry flattenedAliases.
    expect(renameEvent?.metadata).not.toHaveProperty('flattenedAliases')
    // No locale variants seeded; metadata should NOT carry localeVariants.
    expect(renameEvent?.metadata).not.toHaveProperty('localeVariants')
  })

  it('records metadata.keepAlias=false when keepAlias=false is passed', async () => {
    // Pins the `keepAlias` field's identity — a StringLiteral mutant
    // that blanks the key wouldn't be detectable without checking the
    // value round-trips.
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'new-landing', keepAlias: false }),
    })
    expect(res.status).toBe(200)
    const events = await readAuditEvents()
    const renameEvent = events.find(e => e.action === 'rename')
    expect(renameEvent?.metadata).toMatchObject({
      fromName: 'landing',
      keepAlias: false,
    })
  })

  it('records metadata.flattenedAliases when flatten runs (conditional add)', async () => {
    // Pins the `if (flattened.length > 0)` branch on line 218. Without
    // this coverage, mutating the conditional to `if (true)` or
    // `if (false)` would survive on the happy path.
    // Archive `landing` aliasing `home` first.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    const res = await app.request('/api/pages/home/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'welcome' }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const renameEvent = events.find(e => e.action === 'rename')
    expect(renameEvent?.metadata).toMatchObject({
      fromName: 'home',
      keepAlias: true,
      flattenedAliases: ['landing'],
    })
  })

  it('records metadata.localeVariants when the page has locale variants', async () => {
    // Pins the `if (localeVariants.length > 0)` branch on line 219 AND
    // the ternary on line 184 (`handle.scopeKind === 'page' ?`).
    // Without a locale-variant test, both mutants survive.
    setup({
      'pages/landing/page.fr.json': JSON.stringify({ template: 'page-default', content: { title: 'Atterrissage' } }),
      'pages/landing/page.es.json': JSON.stringify({ template: 'page-default', content: { title: 'Aterrizaje' } }),
    })
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'new-landing' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { localeVariants: string[] }
    expect(body.localeVariants.sort()).toEqual(['es', 'fr'])

    const events = await readAuditEvents()
    const renameEvent = events.find(e => e.action === 'rename')
    expect(renameEvent?.metadata).toMatchObject({
      fromName: 'landing',
      keepAlias: true,
    })
    const meta = renameEvent?.metadata as { localeVariants: string[] } | undefined
    expect(meta?.localeVariants?.sort()).toEqual(['es', 'fr'])

    // New-name directory carries the locale variants.
    expect(await storage.exists('pages/new-landing/page.fr.json')).toBe(true)
    expect(await storage.exists('pages/new-landing/page.es.json')).toBe(true)
  })

  it('fragment rename records metadata with fragmentLocales branch', async () => {
    // Pins the ELSE branch of `handle.scopeKind === 'page' ? site.pageLocales : site.fragmentLocales`
    // on line 184. Without a locale-variant test on a fragment,
    // mutating the ternary condition survives.
    setup({
      'fragments/header/fragment.fr.json': JSON.stringify({ template: 'header-layout', content: { label: 'En-tête' } }),
    })
    const res = await app.request('/api/fragments/header/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'top-bar' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { localeVariants: string[] }
    expect(body.localeVariants).toEqual(['fr'])

    const events = await readAuditEvents()
    const renameEvent = events.find(e => e.action === 'rename')
    expect(renameEvent?.scope).toEqual({ kind: 'fragment', name: 'top-bar' })
    const meta = renameEvent?.metadata as { localeVariants: string[] } | undefined
    expect(meta?.localeVariants).toEqual(['fr'])

    // New-name directory carries the locale variant.
    expect(await storage.exists('fragments/top-bar/fragment.fr.json')).toBe(true)
  })
})

describe('Conflict response bodies — pin the 409 literals', () => {
  beforeEach(() => setup())

  // Existing tests assert `code` + `conflictKind` + `toName` on
  // NAME_COLLISION and ARCHIVED_NAME_CONFLICT bodies. These add
  // coverage for the archive metadata sub-object on ARCHIVED_NAME_CONFLICT
  // — an ObjectLiteral mutant on `body.archive` (lines 164-172) would
  // replace it with `{}` and existing tests only spot-check `aliasOf`.

  it('ARCHIVED_NAME_CONFLICT body includes archivedAt + archivedBy from the archive manifest', async () => {
    // Archive `home` first with an alias — the archive manifest gets
    // archivedAt (timestamp) + archivedBy (actor) written.
    await app.request('/api/pages/home/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'landing' }),
    })
    // Try to rename landing → home; 409 with archive body.
    const res = await app.request('/api/pages/landing/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'home' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      toName: string
      conflictKind: string
      archive: { archivedAt?: string; archivedBy?: string; aliasOf?: string }
    }
    expect(body.code).toBe('ARCHIVED_NAME_CONFLICT')
    expect(body.toName).toBe('home')
    expect(body.conflictKind).toBe('archived')
    // The archive sub-object carries archivedAt + aliasOf conditionally.
    expect(body.archive.aliasOf).toBe('landing')
    expect(typeof body.archive.archivedAt).toBe('string')
    expect(body.archive.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
