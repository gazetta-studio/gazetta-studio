/**
 * Cross-foundation gap #6 (per testing-plan.md punch list):
 * archive transitions must notify the validation scanner so background-
 * stage issues stay accurate.
 *
 * Concrete contract: when a page goes from live → archived, the
 * scanner should `rescan({ kind: 'manifest', item })` for the archived
 * item itself. This clears any prior `referenced-archived-without-alias`
 * (P1) issues that pointed AT this name from cache, AND lets the
 * scanner add new issues for items still referencing the now-archived
 * target.
 *
 * Today the archive route doesn't accept a scanner. Save handlers
 * notify it via `manifest-save.ts`'s `scanner.rescan()` call; archive
 * is a separate write path that bypasses the same notification. These
 * tests exercise the gap end-to-end through the admin app.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp` with a stub scanner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { ValidationScanner, RescanCause } from '../src/validation/scanner.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage
let rescanCalls: RescanCause[]
let stubScanner: ValidationScanner

function setup(seed: Record<string, string> = {}) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
    'pages/landing/page.json': JSON.stringify({ template: 'page-default', content: {} }),
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

describe('Cross-foundation gap #6 — archive notifies validation scanner', () => {
  beforeEach(() => setup())

  it('POST /archive triggers rescan with kind=manifest for the archived page', async () => {
    const res = await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    expect(res.status).toBe(200)

    // Scanner should have been notified about the manifest write so
    // background-stage validators (P1, P5) re-run on the archived item.
    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'page', name: 'landing' },
    })
  })

  it('POST /unarchive triggers rescan with kind=manifest for the restored page', async () => {
    // First archive landing.
    await app.request('/api/pages/landing/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    rescanCalls.length = 0 // reset so we only check unarchive's call

    const res = await app.request('/api/pages/landing/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)

    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'page', name: 'landing' },
    })
  })

  it('DELETE /purge triggers rescan with kind=manifest (issues cleared as item is gone)', async () => {
    // Archive then purge.
    await app.request('/api/pages/landing/archive', { method: 'POST' })
    rescanCalls.length = 0

    const res = await app.request('/api/pages/landing/purge', { method: 'DELETE' })
    expect(res.status).toBe(200)

    // Purge removes the manifest; scanner notification clears stale
    // issues from the cache (any P1 / P2 / P5 issues on this path).
    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'page', name: 'landing' },
    })
  })

  it('archive of a fragment triggers rescan with the fragment scope', async () => {
    const res = await app.request('/api/fragments/header/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasOf: 'home' }),
    })
    // Note: fragment archive may fail with ARCHIVE_HAS_LIVE_REFS if any
    // page references @header. The starter seed has no such ref, but
    // `?force=true` bypasses. Use it to keep the test focused on
    // scanner notification, not P8 logic.
    if (res.status !== 200) {
      const forceRes = await app.request('/api/fragments/header/archive?force=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliasOf: 'home' }),
      })
      expect(forceRes.status).toBe(200)
    }

    const manifestRescans = rescanCalls.filter(c => c.kind === 'manifest')
    expect(manifestRescans).toHaveLength(1)
    expect(manifestRescans[0]).toMatchObject({
      kind: 'manifest',
      item: { kind: 'fragment', name: 'header' },
    })
  })
})
