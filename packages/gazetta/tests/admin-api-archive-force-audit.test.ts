/**
 * Mutation-coverage tests for `handleArchive`'s force-branch audit
 * metadata (issue #737; prior cycles #309, #566, #650 lifted kill
 * ratio from 46% → 66% but the force-branch audit shape stayed
 * unmeasured).
 *
 * Coverage gaps this file targets, all clustered on lines 308-314
 * of `admin-api/routes/archive.ts`:
 *
 *   const archiveMetadata: Record<string, unknown> = { ...archiveReviewMetadata(manifest) }
 *   if (aliasOf) archiveMetadata.aliasOf = aliasOf                     // line 309
 *   if (force) {                                                        // line 310
 *     archiveMetadata.forced = true                                     // line 311
 *     const bypassedRefs = await collectLiveRefs(source, handle, site, name)
 *     if (bypassedRefs.length > 0) archiveMetadata.bypassedRefs = bypassedRefs  // line 313
 *   }
 *
 * Surviving / no-coverage mutants:
 *
 *   - **Line 310 BlockStatement Survived → `{}`.** The entire `if (force) { ... }`
 *     body replaced with an empty block. `archiveMetadata.forced` never
 *     set; `bypassedRefs` never collected. Existing archive tests assert
 *     that `?force=true` bypasses the live-refs check and returns 200
 *     (admin-api-archive.test.ts line 393-398) but never inspect the
 *     resulting audit event's metadata — so the whole block can vanish
 *     and no test fails.
 *
 *   - **Line 310 ConditionalExpression Survived → `true`.** `if (force)`
 *     replaced with `if (true)` — force branch runs on EVERY archive.
 *     Non-force archives would then get `metadata.forced = true` +
 *     potentially `metadata.bypassedRefs`. No existing test pins the
 *     absence of these fields on a normal archive.
 *
 *   - **Line 311 BooleanLiteral Survived → `false`.** `archiveMetadata.forced = true`
 *     replaced with `= false`. A force archive would then audit with
 *     `metadata.forced === false`, semantically opposite to the intent.
 *     Existing tests don't discriminate.
 *
 *   - **Line 313 ConditionalExpression (implied by the cluster).** The
 *     inner `if (bypassedRefs.length > 0)` gates whether the array
 *     lands on metadata. Two mutants:
 *       - `→ true`: always assigns bypassedRefs, including as `[]` on
 *         no-refs case. Kills forensic contract that "bypassedRefs is
 *         present ONLY when refs were bypassed."
 *       - `→ false`: never assigns bypassedRefs, dropping the forensic
 *         trail on the force-with-refs case.
 *
 * Why the force-branch audit metadata matters (per design-soft-delete.md
 * Q5 E1 lock): `?force=true` bypasses the P8 save-handler check that
 * refuses archive-without-aliasOf when live refs exist. The bypass
 * silently strands those references. Audit metadata (`forced: true` +
 * `bypassedRefs: [...]`) is the forensic trail that lets operators
 * later reconstruct which refs got stranded. Losing that trail means
 * "why is /home now serving broken fragment refs?" becomes an
 * unanswerable investigation.
 *
 * Test approach — targeted API-tier tests per issue #737's fix approach
 * #1: seed a fragment-deps sidecar for the "force with refs" case;
 * exercise the three force × refs axis combinations; assert metadata
 * shape via the audit provider's read-back interface.
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

describe('archive ?force=true + live refs → metadata records forced + bypassedRefs', () => {
  beforeEach(() => {
    // Fragment `header` referenced by live page `home` via the
    // fragment-deps sidecar. Same shape as
    // admin-api-archive.test.ts's "Purge-blocked" setup — seeding the
    // sidecar directly bypasses the PUT pipeline and keeps this test
    // focused on the force-branch audit shape.
    setup({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: {},
        components: ['@header'],
      }),
      '.gazetta/fragment-deps/header/pages.home': '',
    })
  })

  it('emits audit event with metadata.forced === true (not omitted, not false)', async () => {
    const res = await app.request('/api/fragments/header/archive?force=true', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'header')
    // Pins Line 310 BlockStatement `{}` (would drop `forced` entirely)
    // AND Line 311 BooleanLiteral `false` (would set forced === false).
    // A strict `=== true` check discriminates both.
    expect(archive.metadata).toBeDefined()
    expect(archive.metadata!.forced).toBe(true)
  })

  it('emits audit event with metadata.bypassedRefs populated with the stranded refs', async () => {
    const res = await app.request('/api/fragments/header/archive?force=true', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'header')
    // Pins Line 313 inner ConditionalExpression `false` (would drop
    // bypassedRefs entirely on the force-with-refs case, losing the
    // forensic trail per design-soft-delete.md Q5 E1). The `home` page
    // referencing `@header` is the exact stranded ref the operator
    // bypassed.
    expect(archive.metadata!.bypassedRefs).toEqual([{ kind: 'page', name: 'home' }])
  })
})

describe('archive ?force=true + NO live refs → metadata records forced but NOT bypassedRefs', () => {
  beforeEach(() => setup())

  it('emits audit event with metadata.forced === true even when no refs to bypass', async () => {
    // Fragment `footer` has no fragment-deps sidecars — no live refs
    // to bypass. Force still applies (operator's declared intent), so
    // `forced: true` records.
    const res = await app.request('/api/fragments/footer/archive?force=true', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'footer')
    expect(archive.metadata!.forced).toBe(true)
  })

  it('emits audit event withOUT metadata.bypassedRefs when no refs were bypassed', async () => {
    // Pins Line 313 ConditionalExpression `true` (would always add
    // bypassedRefs, including as `[]`). The forensic contract per
    // design-soft-delete.md Q5 E1: bypassedRefs present ONLY when
    // refs were actually bypassed — its absence is meaningful.
    const res = await app.request('/api/fragments/footer/archive?force=true', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'footer')
    expect(archive.metadata).not.toHaveProperty('bypassedRefs')
  })
})

describe('archive WITHOUT ?force=true → metadata records neither forced nor bypassedRefs', () => {
  beforeEach(() => setup())

  it('emits audit event withOUT metadata.forced on a normal archive', async () => {
    // Pins Line 310 ConditionalExpression `true` (would apply the
    // force branch on every archive). A regular archive without
    // `?force=true` must NOT carry `forced` — that's the operator's
    // declared intent, not a system default.
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'landing')
    // `metadata` may be undefined on a bare draft-archive (no aliasOf,
    // no review state, no force) because the route sets
    // `metadata: Object.keys(archiveMetadata).length > 0 ? archiveMetadata : undefined`.
    // Either way, `forced` must not be present.
    if (archive.metadata) {
      expect(archive.metadata).not.toHaveProperty('forced')
    }
  })

  it('emits audit event withOUT metadata.bypassedRefs on a normal archive', async () => {
    // Same shape — belt-and-suspenders check for the paired assertion
    // above. Kills any mutant that would spuriously add bypassedRefs
    // to non-force audits.
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const archive = findArchiveEvent(events, 'landing')
    if (archive.metadata) {
      expect(archive.metadata).not.toHaveProperty('bypassedRefs')
    }
  })
})
