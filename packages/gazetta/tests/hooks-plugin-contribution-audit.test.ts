/**
 * Cross-foundation gap #5 (per testing-plan.md punch list):
 * Plugin-contributed hooks fire with the correct `source` round-tripping
 * through audit metadata.
 *
 * Hooks Cut 9 shipped factory contributions (`admin.hooks: HookContribution[]`),
 * with each contribution declaring a `source` field (e.g.
 * `'@example/cdn-purge'`). Per ADR-0009 + design-plugins.md "source
 * convention": audit records `metadata.source` and `metadata.hookName`
 * as separate fields (not a composed `'@scope/pkg:hookName'` string)
 * so forensic queries filter on either alone.
 *
 * Existing `hooks-audit.test.ts` (Cut 7 admin-api-level test) covers the
 * `source: 'site-local'` round-trip via direct `registry.register(...)`.
 * This file covers the COMPLEMENT — what plugin authors actually do:
 * a factory function returning `HookContribution`, registered via
 * `buildHooksRegistry({ contributions })`, fired through the route
 * pipeline, audit metadata showing the package-name source.
 *
 * Per rule 26 (test-isolation paranoia): fresh memoryStorage + fresh
 * createAdminApp per test.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { buildHooksRegistry, createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import type { BeforeSaveHook, HookContribution } from '../src/hooks/index.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage

/**
 * Plugin author's factory shape — exports a function that takes
 * options and returns a HookContribution. Mirrors the example in
 * design-plugins.md "Pattern B — Contribution array".
 */
interface CdnPurgeOptions {
  zone: string
  apiToken: string
}

function cdnPurgePlugin(options: CdnPurgeOptions): HookContribution {
  // Capture options in the handler closure — that's the whole point
  // of the factory pattern (operator config flows through closure).
  const purge: BeforeSaveHook = async (_scope, payload, _ctx) => {
    // No-op for the test; in production this would hit options.zone.
    // We assert the closure capture survived by reading options
    // inside the handler — if it didn't, payload mutation would
    // throw a TypeError on `options.zone`.
    void options.zone
    void options.apiToken
    return payload
  }
  return {
    source: '@example/cdn-purge',
    hooks: [
      {
        phase: 'beforeSave',
        handler: purge,
        options: { name: 'cdn-purge-on-save' },
      },
    ],
  }
}

async function setup(contributions: HookContribution[]) {
  storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: {} }),
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

  // Build the registry through buildHooksRegistry — the canonical path
  // for plugin contributions (operator's `admin.hooks` array flows
  // through here at boot).
  const hooks = await buildHooksRegistry({ contributions })

  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    hooks,
    // Empty validator registry — no template scan; the test is
    // about the hook→audit seam, not validation.
    validators: createValidatorRegistry([]),
  })
}

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader-only' })
  return reader.query!({})
}

describe('Cross-foundation gap #5 — plugin-contributed hooks audit with package source', () => {
  it('plugin factory contribution fires hook with source = package name in audit metadata', async () => {
    await setup([cdnPurgePlugin({ zone: 'cdn.example.com', apiToken: 'test-token' })])

    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hello' } }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const hookFired = events.filter(e => e.action === 'hook-fired')
    const ours = hookFired.find(e => e.metadata?.hookName === 'cdn-purge-on-save')
    expect(ours).toBeDefined()

    // The locked contract: source and hookName are SEPARATE fields
    // (per ADR-0009). Composed strings like '@example/cdn-purge:cdn-purge-on-save'
    // would break forensic queries that filter on source alone.
    expect(ours!.metadata?.source).toBe('@example/cdn-purge')
    expect(ours!.metadata?.hookName).toBe('cdn-purge-on-save')
    expect(ours!.metadata?.phase).toBe('beforeSave')
    expect(ours!.outcome).toBe('success')
  })

  it('two factories contributing to the same phase produce two audit events with distinct sources', async () => {
    // Operator imports two different plugins that both wire beforeSave.
    // Each should produce its own hook-fired event with its own source —
    // forensics need to attribute each firing to its package.
    function loggerPlugin(): HookContribution {
      const log: BeforeSaveHook = async (_s, p, _c) => p
      return {
        source: '@example/save-logger',
        hooks: [{ phase: 'beforeSave', handler: log, options: { name: 'log-saves' } }],
      }
    }

    await setup([cdnPurgePlugin({ zone: 'cdn.example.com', apiToken: 'test-token' }), loggerPlugin()])

    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hello' } }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const sources = events
      .filter(e => e.action === 'hook-fired')
      .map(e => e.metadata?.source as string)
      .filter(s => s !== undefined)

    expect(sources).toContain('@example/cdn-purge')
    expect(sources).toContain('@example/save-logger')
  })

  it('site-local source coexists with plugin source in the audit log', async () => {
    // Mixed registration — the operator wires their own factory
    // alongside an npm-distributed plugin. Each fires; each records
    // its own source.
    function siteLocalAutoSlugify(): HookContribution {
      const slug: BeforeSaveHook = async (_s, p, _c) => p
      return {
        source: 'site-local:auto-slugify',
        hooks: [{ phase: 'beforeSave', handler: slug, options: { name: 'auto-slugify' } }],
      }
    }

    await setup([siteLocalAutoSlugify(), cdnPurgePlugin({ zone: 'cdn.example.com', apiToken: 'test-token' })])

    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hello' } }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const ourEvents = events
      .filter(e => e.action === 'hook-fired')
      .map(e => ({ source: e.metadata?.source, hookName: e.metadata?.hookName }))

    expect(ourEvents).toContainEqual({
      source: 'site-local:auto-slugify',
      hookName: 'auto-slugify',
    })
    expect(ourEvents).toContainEqual({
      source: '@example/cdn-purge',
      hookName: 'cdn-purge-on-save',
    })
  })
})
