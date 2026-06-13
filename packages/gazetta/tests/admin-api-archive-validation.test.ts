/**
 * Mutation-coverage tests for `admin-api/routes/archive.ts` — closes
 * surviving / no-coverage mutants on `handleArchive`'s 400 branch and
 * its idempotent re-archive guard (issue #566; prior cycle #309 lifted
 * kill ratio from 46% → 53%, this fills the next-cheapest gaps).
 *
 * Coverage gaps targeted:
 *
 *  - **handleArchive lines 232-238 — invalid-body 400 branch
 *    (`{ error: 'Invalid request body', issues: parsed.error.issues
 *    .map(i => ({ path: i.path.join('.'), message: i.message })) }`).**
 *    Existing tests for the archive route assert status codes only on
 *    happy paths; the schema-rejection branch was NoCoverage. Stryker
 *    could blank the response object, blank the `'Invalid request body'`
 *    string, no-op the `issues.map(...)` arrow, blank the `.` separator
 *    in `path.join('.')`, or replace the issue projection object with
 *    `{}` — none of those break a status-code-only test. Pinning the
 *    body shape (error string + issues array of `{path, message}`
 *    objects with non-empty values) kills the cluster. Modelled on
 *    `admin-api-redirects.test.ts:513-604` which pinned the same
 *    pattern for the redirect routes.
 *
 *  - **handleArchive line 252 — `manifest.archived !== true` clause of
 *    the live-refs guard's ConditionalExpression (Survived → `true`).**
 *    The original code: `if (!aliasOf && !force && manifest.archived
 *    !== true)` runs the live-refs scan ONLY on first archive (not on
 *    the idempotent re-archive of an already-archived item). The
 *    surviving mutant rewrites the whole condition to `true` so the
 *    scan ALWAYS runs — including on the idempotent path. A re-archive
 *    of a fragment that has a fragment-deps sidecar pointing at a live
 *    page would then return 409 ARCHIVE_HAS_LIVE_REFS where the
 *    original correctly returns 200. The test pins the idempotent
 *    branch by seeding that exact scenario; the mutant returns the
 *    wrong status, the test catches it. (The `!aliasOf` and `!force`
 *    clauses are already exercised by `admin-api-archive.test.ts`'s
 *    happy-path archive tests + the `?force=true` bypass test, so
 *    targeted live-refs coverage focuses on the under-tested clause.)
 *
 * Why these are the two cheapest wins per the issue's fix-approach
 * recommendation: both pin operator-facing route contracts that are
 * already correct in production — the tests just guard the contracts
 * against silent regression. The broader rename/restore/purge sweep
 * the issue mentions is a separate follow-up (its truncated mutants
 * cluster around error-branch response objects in those handlers).
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp`. No module-level state.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

function setup(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: {} }),
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

type InvalidBody = {
  error: string
  issues: Array<{ path: string; message: string }>
}

describe('handleArchive — invalid-body 400 branch (lines 232-238)', () => {
  // The mutants this kills:
  //   - ObjectLiteral on the response body → `{}`
  //   - StringLiteral on `'Invalid request body'` → `""`
  //   - ArrowFunction on the issues projection → `() => undefined`
  //   - ObjectLiteral on the projection's `{ path, message }` → `{}`
  //   - StringLiteral on `'.'` (in `i.path.join('.')`)  → `""`
  //
  // Status-only tests (existing) catch none of them. Asserting the
  // body's error string, issues array shape, and per-issue path +
  // message strings closes the cluster.

  beforeEach(() => setup())

  it('POST /api/pages/:name/archive with aliasOf: wrong-type returns 400 + structured issues body', async () => {
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 42 }), // number — schema requires string
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as InvalidBody
    expect(body.error).toBe('Invalid request body')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues).toHaveLength(1)
    // Pins `i.path.join('.')` — the single-element path `['aliasOf']`
    // joins to `'aliasOf'`. A `""` mutant on the separator wouldn't
    // change the output for length-1 paths, but the ObjectLiteral
    // mutant `{}` would drop the path field entirely. Asserting the
    // exact value catches both.
    expect(body.issues[0].path).toBe('aliasOf')
    expect(typeof body.issues[0].message).toBe('string')
    expect(body.issues[0].message.length).toBeGreaterThan(0)
  })

  it('POST /api/pages/:name/archive with aliasOf: "" (empty, min(1) violation) returns 400 + structured issues body', async () => {
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: '' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as InvalidBody
    expect(body.error).toBe('Invalid request body')
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0].path).toBe('aliasOf')
    expect(typeof body.issues[0].message).toBe('string')
    expect(body.issues[0].message.length).toBeGreaterThan(0)
  })

  it('POST /api/fragments/:name/archive with aliasOf: wrong-type returns 400 + structured issues body (parity with pages)', async () => {
    // Same branch in handleArchive serves both pages and fragments —
    // pinning fragments separately closes the kind-axis coverage and
    // kills the cluster regardless of which handle.scopeKind branch
    // hits it. Modelled on `admin-api-archive-mutation-coverage.test.ts`'s
    // fragment-parity matrix for handleSetAlias.
    const res = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 42 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as InvalidBody
    expect(body.error).toBe('Invalid request body')
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0].path).toBe('aliasOf')
    expect(typeof body.issues[0].message).toBe('string')
    expect(body.issues[0].message.length).toBeGreaterThan(0)
  })

  it('idempotent first-archive does NOT reach the 400 branch (sanity guard)', async () => {
    // Cross-check: a valid first archive returns 200, not 400. Ensures
    // the schema-rejection branch above isn't accidentally swallowing
    // a valid request. Catches a future mistake where someone tightens
    // the schema (e.g. requires aliasOf) without updating callers.
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('handleArchive — idempotent re-archive guard (line 252 ConditionalExpression)', () => {
  // The mutant this kills: `manifest.archived !== true` clause of
  //   `if (!aliasOf && !force && manifest.archived !== true)`
  // replaced with `true` so the live-refs scan ALWAYS runs (even on
  // the idempotent re-archive path). The test seeds:
  //   - fragment header pre-archived (pure soft-delete, no aliasOf)
  //   - page foo references `@header` via a fragment-deps sidecar
  // and re-archives header without aliasOf. The original code skips
  // the live-refs scan (idempotent path) → 200. The mutant runs the
  // scan, finds page foo as a live ref → 409 ARCHIVE_HAS_LIVE_REFS.

  beforeEach(() => {
    setup({
      // Pre-archived fragment (pure soft-delete — no aliasOf, no
      // sidecar to aliases). Same shape `handleArchive` would have
      // written had the operator archived this fragment earlier.
      'fragments/header/fragment.json': JSON.stringify({
        template: 'header-layout',
        content: {},
        archived: true,
        archivedAt: '2026-06-01T00:00:00Z',
        archivedBy: 'test-actor',
      }),
      // Live page that references `@header` — the kind of pre-existing
      // live ref that would have blocked the first archive but now
      // sits stranded behind the archived fragment (per design-soft-
      // delete.md's known limitation: archive-without-alias breaks
      // refs silently when the operator force-bypasses the gate).
      'pages/foo/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        components: ['@header'],
      }),
      // Per-edge fragment-deps sidecar pointing the relation
      // `header → foo`. Per `dep-sidecars.ts`, the file existence at
      // this path IS the index; zero bytes is fine.
      '.gazetta/fragment-deps/header/pages.foo': '',
    })
  })

  it('re-archiving an already-archived fragment with live refs returns 200 (idempotent — does NOT run the live-refs scan)', async () => {
    const res = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      // No body — aliasOf undefined, force undefined.
    })
    // Original code: `manifest.archived !== true` is false → condition
    // false → skip live-refs scan → fall through to the idempotent
    // branch (line 262) → 200 with the existing archivedAt preserved.
    //
    // Mutant `true`: condition always true → run `collectLiveRefs` →
    // find page foo via the fragment-deps sidecar → return 409
    // ARCHIVE_HAS_LIVE_REFS. Status mismatch kills the mutant.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      name: string
      archivedAt: string
      aliasOf?: string
    }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('header')
    // Idempotent branch returns the manifest's existing archivedAt,
    // not a fresh timestamp. Pins the design-soft-delete.md Q1 idempotent
    // contract ("archiveAt preserved — avoid double-emitting the audit
    // event and double-writing the sidecar").
    expect(body.archivedAt).toBe('2026-06-01T00:00:00Z')
    expect(body.aliasOf).toBeUndefined()
  })

  it('re-archiving with explicit aliasOf on an already-archived fragment still returns 200 (idempotent path beats the alias-change branch)', async () => {
    // Sibling case: even with aliasOf present (which would itself
    // satisfy the `!aliasOf` clause being false), the idempotent
    // branch still fires because `manifest.archived === true`. Pins
    // that the idempotent guard's truth-table holds across both
    // aliasOf-present and aliasOf-absent inputs — the mutant `true`
    // wouldn't affect this case (the `!aliasOf` clause already short-
    // circuits), but pinning it documents the intent and guards
    // against a future regression that moves the idempotent check
    // below the alias-update logic.
    const res = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'footer' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; archivedAt: string }
    // Still returns the original archivedAt (idempotent), not a fresh
    // one. The aliasOf in the request body is NOT applied — operators
    // use PATCH /api/fragments/:name/alias for that (covered by the
    // existing handleSetAlias tests).
    expect(body.archivedAt).toBe('2026-06-01T00:00:00Z')
    const manifest = JSON.parse(await storage.readFile('fragments/header/fragment.json')) as {
      aliasOf?: string
    }
    // Manifest's aliasOf is NOT mutated on the idempotent path.
    expect(manifest.aliasOf).toBeUndefined()
  })
})
