/**
 * Cut 5 tests: end-to-end audit recording via createAdminApp.
 *
 * Validates the full stack: site.config.ts admin.audit → AuditConfigSchema
 * parse → buildAuthProvider → principalMiddleware → auditMiddleware →
 * route handler → c.var.audit.record() → HistoryAuditProvider →
 * .gazetta/audit/events-{instance}.jsonl.
 *
 * Strategy: build admin apps via createAdminApp, perform writes
 * (save / publish / delete), then read the audit events directly
 * from the storage layer to confirm they were recorded with the
 * right action + outcome + actor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const projectRoot = tempDir('audit-integ-' + Date.now())
const projectSiteDir = resolve(projectRoot, 'sites/main')
const localTargetDir = resolve(projectSiteDir, 'targets/local')
const storage = createFilesystemProvider(localTargetDir)
let app: Hono

beforeAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error('site.config.ts missing')
  const manifest = siteConfigToManifest(loaded.config)
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  app = createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
})

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

/** Read events directly from storage for assertion. */
async function readAuditEvents(): Promise<AuditEvent[]> {
  // Use the same provider the admin uses — handles instance-file
  // aggregation. The instance id is non-deterministic (hostname /
  // K_REVISION); we just read everything.
  const reader = createHistoryAuditProvider({ storage, instance: 'reader-only' })
  const events = await reader.query!({})
  return events
}

describe('Cut 5 — end-to-end audit recording', () => {
  it('successful page save records action: save, outcome: success', async () => {
    // Create the page first (this also produces a save event).
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-save-test', template: 'page-default' }),
    })
    // Then update it — that's the wired PUT handler we record from.
    const res = await app.request('/api/pages/audit-save-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hi' } }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    // The PUT should have produced exactly one save / success event
    // for this scope. POST creates don't go through the wired
    // PUT handler so they don't appear here.
    const matched = events.filter(
      e => e.action === 'save' && e.outcome === 'success' && e.scope.name === 'audit-save-test',
    )
    expect(matched).toHaveLength(1)
    expect(matched[0].actor.role).toBe('admin') // none-mode default
    expect(matched[0].actor.trustMode).toBe('none')
    await rm(resolve(localTargetDir, 'pages/audit-save-test'), { recursive: true, force: true })
  })

  it('validation-failed save records action: save, outcome: validation-failed', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-vf-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/audit-vf-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { hero: { _asset: 'definitely-not-an-asset-name' } } }),
    })
    expect(res.status).toBe(409)
    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'save' && e.outcome === 'validation-failed' && e.scope.name === 'audit-vf-test',
    )
    expect(matched).toHaveLength(1)
    await rm(resolve(localTargetDir, 'pages/audit-vf-test'), { recursive: true, force: true })
  })

  it('DELETE on a page records action: archive (soft-delete per Cut 7 cutover)', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-delete-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/audit-delete-test', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'archive' && e.outcome === 'success' && e.scope.name === 'audit-delete-test',
    )
    expect(matched).toHaveLength(1)
  })

  it('DELETE with ?permanent=true records action: purge', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-purge-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/audit-purge-test?permanent=true', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'purge' && e.outcome === 'success' && e.scope.name === 'audit-purge-test',
    )
    expect(matched).toHaveLength(1)
  })

  it('audit events carry scope.kind correctly per route', async () => {
    // Fragment save → kind: 'fragment'.
    await app.request('/api/fragments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-frag-test', template: 'footer-layout' }),
    })
    const res = await app.request('/api/fragments/audit-frag-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { copyright: 'test' } }),
    })
    expect(res.status).toBe(200)
    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'save' && e.scope.kind === 'fragment' && e.scope.name === 'audit-frag-test',
    )
    expect(matched).toHaveLength(1)
    await rm(resolve(localTargetDir, 'fragments/audit-frag-test'), { recursive: true, force: true })
  })

  it('events carry timestamp in ISO 8601', async () => {
    const events = await readAuditEvents()
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      // Confirm parseable.
      expect(Number.isFinite(new Date(e.timestamp).getTime())).toBe(true)
    }
  })

  it('actor.id is "unknown" under none-mode default', async () => {
    const events = await readAuditEvents()
    expect(events.length).toBeGreaterThan(0)
    // Every event's actor.id should be 'unknown' since no auth
    // is configured in the test fixture's site.config.ts.
    expect(events.every(e => e.actor.id === 'unknown')).toBe(true)
  })
})
