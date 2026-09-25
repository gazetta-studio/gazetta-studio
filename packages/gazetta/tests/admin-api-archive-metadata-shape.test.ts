/**
 * Mutation-coverage tests for `admin-api/routes/archive.ts`'s
 * `handleArchive` audit-metadata construction (issue #813; prior
 * cycles #309, #566, #650, #737 lifted kill ratio to ~69%; this
 * closes the "bare archive → metadata undefined" boundary).
 *
 * Coverage gaps this file targets:
 *
 *   - **Line 309 ConditionalExpression Survived → `true`.** The
 *     `if (aliasOf) archiveMetadata.aliasOf = aliasOf` branch mutated
 *     so the assignment runs unconditionally. On a bare archive
 *     (no `aliasOf` in the request), `aliasOf` is `undefined`; the
 *     mutant injects `archiveMetadata.aliasOf = undefined`. Then
 *     `Object.keys(archiveMetadata)` sees the `aliasOf` key (length
 *     1), so the ternary on line 328 picks `archiveMetadata` instead
 *     of `undefined`. JSON serialization drops the `undefined` value,
 *     so on read the audit event's `metadata` is `{}` — NOT
 *     `undefined`. Discriminates via strict `expect(metadata).toBe(undefined)`.
 *
 *   - **Line 328 ConditionalExpression Survived → `true`.** The
 *     `metadata: Object.keys(archiveMetadata).length > 0 ? archiveMetadata : undefined`
 *     ternary mutated to always pick `archiveMetadata`. On a bare
 *     archive (empty archiveMetadata), the audit event's `metadata`
 *     becomes `{}` — NOT `undefined`. Same discriminator.
 *
 *   - **Line 328 EqualityOperator Survived → `>= 0`.** For an empty
 *     object, `Object.keys(...).length >= 0` is `true` (0 >= 0), so
 *     `metadata` also becomes `{}` on bare archive. Same discriminator.
 *
 * All three mutants collapse to the same discriminating test: a
 * bare archive (no `aliasOf`, no `?force=true`, no prior review
 * state) must emit an audit event with `metadata` field entirely
 * absent (i.e. `undefined` after read-back). The paired assertion
 * — archive WITH `aliasOf` yields `metadata.aliasOf === target` —
 * kills the `→ false` counterpart of line 309.
 *
 * Why the metadata-absence boundary matters (per design-soft-delete.md
 * Q8): audit metadata is the forensic surface for "what was special
 * about this archive?" (aliasOf, forced, priorReviewState). A bare
 * archive has none of those; the `metadata: undefined` shape declares
 * that positively. A regression that emits `metadata: {}` on bare
 * archives silently degrades the contract — future consumers filtering
 * on `metadata !== undefined` would false-positive on every draft
 * archive. Pinning the boundary now protects the contract.
 *
 * Equivalent / unkillable mutants documented for future cycles:
 *
 *   - **Line 213 ObjectLiteral `{}` + StringLiteral `""` (NoCoverage).**
 *     The `if (!name) return c.json({ error: 'Missing name parameter' }, 400)`
 *     defensive guard in `handleArchive`. Verified empirically via
 *     Hono probe (`/api/pages//archive` → 404, not routed to handler):
 *     the branch is unreachable via HTTP with the `:name` route
 *     pattern. Killing would require direct handler invocation with
 *     a synthetic Context — high cost, no forensic value (the guard
 *     is defense in depth).
 *
 *   - **Line 348 ObjectLiteral `{}` (NoCoverage).** Same guard in
 *     `handleUnarchive`; same reasoning.
 *
 *   - **Line 235 StringLiteral `""` (Survived).** The `.` separator
 *     in `parsed.error.issues.map(i => ({ path: i.path.join('.'), ... }))`.
 *     `ArchiveRequestSchema` is a flat single-field object
 *     (`aliasOf` only), so every validation issue has a single-
 *     element path. `['aliasOf'].join('.')` and `['aliasOf'].join('')`
 *     both produce `'aliasOf'` — equivalent under the current schema
 *     shape. Killable only if the schema grows a nested object field.
 *
 *   - **Line 283 ConditionalExpression `→ true` (Survived).** The
 *     `if (aliasOf) archived.aliasOf = aliasOf` branch mutated to
 *     always assign. On a bare archive, `archived.aliasOf = undefined`
 *     executes. `JSON.stringify` drops the `undefined` value; the
 *     persisted manifest and the history-recorder's serialized blob
 *     both show no `aliasOf` field. Equivalent under JSON
 *     serialization semantics. The `→ false` counterpart (mutant
 *     that would drop the assignment when `aliasOf` IS present) is
 *     already killed by `admin-api-archive.test.ts` line 74's
 *     `expect(manifest.aliasOf).toBe('home')`.
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
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/about/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
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

function findArchiveEvent(events: AuditEvent[], name: string): AuditEvent {
  const event = events.find(e => e.action === 'archive' && e.scope.name === name && e.outcome === 'success')
  if (!event) throw new Error(`no archive event for name=${name} found in ${JSON.stringify(events)}`)
  return event
}

describe('bare archive audit event — metadata field is entirely absent', () => {
  beforeEach(() => setup())

  it('archive page without aliasOf, without ?force=true → metadata is undefined (not `{}`)', async () => {
    // The load-bearing test. Discriminates:
    //   - Line 328 `→ true`: emits `metadata: archiveMetadata` (an
    //     empty `{}`) instead of `metadata: undefined`.
    //   - Line 328 `>= 0`: same effect (`0 >= 0` is true for empty).
    //   - Line 309 `→ true`: injects `archiveMetadata.aliasOf = undefined`;
    //     the `Object.keys.length > 0` check then picks archiveMetadata
    //     (length 1 for the `aliasOf` key). JSON serialization drops
    //     the `undefined` value, so on read the metadata is `{}`.
    //
    // All three mutants land at `metadata === {}` (empty object,
    // truthy but with zero keys after JSON round-trip). Correct
    // behavior: `metadata === undefined`. `.toBe(undefined)` is strict
    // and rejects both `{}` and `null`.
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'landing')
    expect(archive.metadata).toBe(undefined)
  })

  it('archive fragment without aliasOf, without ?force=true → metadata is undefined (parity with pages)', async () => {
    // Parity with the page case above. Kills the same three mutants
    // if they only survive on the fragment branch of the shared
    // handler — cheap belt-and-suspenders coverage per the fragment-
    // parity pattern in `admin-api-archive-mutation-coverage.test.ts`.
    const res = await app.request('/api/fragments/footer/archive', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'footer')
    expect(archive.metadata).toBe(undefined)
  })
})

describe('archive with aliasOf → metadata.aliasOf carries the target', () => {
  beforeEach(() => setup())

  it('archive page with aliasOf → audit metadata.aliasOf === target (kills line 309 `→ false`)', async () => {
    // The paired assertion to the "bare archive → metadata undefined"
    // test above. Kills the `→ false` counterpart of line 309: the
    // mutant that drops the assignment entirely so `archiveMetadata`
    // never gets `aliasOf` even when the request provides one.
    //
    // Correct behavior: `metadata = { aliasOf: 'home' }`.
    // Mutant `→ false`: `metadata = undefined` (empty archiveMetadata
    // falls through the length check to `undefined`).
    // Discriminator: assert the specific field value.
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'landing')
    expect(archive.metadata).toBeDefined()
    expect(archive.metadata!.aliasOf).toBe('home')
  })

  it('archive fragment with aliasOf → audit metadata.aliasOf === target (parity with pages)', async () => {
    const res = await app.request('/api/fragments/footer/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'header' }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'footer')
    expect(archive.metadata).toBeDefined()
    expect(archive.metadata!.aliasOf).toBe('header')
  })

  it('archive page with aliasOf → metadata has NO extra keys beyond aliasOf (bare + aliased shape)', async () => {
    // Guards against a future regression that would inject spurious
    // keys into archiveMetadata on the aliased-but-non-forced path.
    // The forensic contract per design-soft-delete.md Q8: metadata
    // present ⇒ operator-declared intent (aliasOf / forced /
    // priorReviewState). A drift adding, say, `defaultAlias: true`
    // silently would degrade the contract.
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'landing')
    expect(archive.metadata).toBeDefined()
    // Exactly one key — aliasOf — on the aliased-but-non-forced,
    // no-priorReviewState path.
    expect(Object.keys(archive.metadata!).sort()).toEqual(['aliasOf'])
  })
})
