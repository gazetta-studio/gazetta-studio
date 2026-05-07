/**
 * Cut 7 tests: hook firing → audit event emission.
 *
 * Pins design-hooks.md "Audit events" + design-audit.md's locked
 * action/outcome enum extensions:
 *
 *   action: 'hook-fired' (added in Cut 7)
 *   outcome: 'success' | 'hook-cancelled' | 'timeout' (latter two
 *     added in Cut 7)
 *   metadata: { hookName, phase, source, priority, durationMs }
 *
 * Two test layers:
 *   - dispatch-level: HookContext.auditEmit fires once per hook
 *     firing with the right shape (success / cancelled / timeout)
 *   - admin-api-level: PUT /api/pages with hooks → audit log
 *     contains both the original 'save' event AND a 'hook-fired'
 *     event
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
import {
  HookCancellation,
  HookRegistry,
  HookTimeout,
  dispatchAfterSave,
  dispatchBeforeSave,
} from '../src/hooks/index.js'
import type {
  AfterSaveHook,
  BeforeSaveHook,
  HookContext,
  HookFiringEvent,
  HookLogger,
  ReadOnlySiteConfig,
  ReadOnlyStorageProvider,
} from '../src/hooks/index.js'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')

// ---- dispatch-layer tests --------------------------------------

const NOOP_LOGGER: HookLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
const READ_ONLY_STORAGE: ReadOnlyStorageProvider = {
  readFile: async () => '',
  readDir: async () => [],
  exists: async () => false,
  readBytes: async () => new Uint8Array(),
  readStream: async () => new ReadableStream(),
}
const SITE: ReadOnlySiteConfig = { name: 'test' }

function makeCtx(emitter?: (e: HookFiringEvent) => void): HookContext {
  return {
    principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
    target: 'local',
    requestId: 'req-1',
    now: new Date('2026-05-04T14:23:05Z'),
    log: NOOP_LOGGER,
    site: SITE,
    storage: READ_ONLY_STORAGE,
    auditEmit: emitter,
  }
}

describe('Cut 7 — dispatch emits hook-firing events to ctx.auditEmit', () => {
  it('successful before* handler fires one event with outcome success', async () => {
    const events: HookFiringEvent[] = []
    const r = new HookRegistry()
    const ok: BeforeSaveHook = async (_s, p, _c) => p
    r.register('beforeSave', ok, { name: 'auto-slugify', priority: 1000 })
    await dispatchBeforeSave(
      r,
      { kind: 'page', name: 'home' },
      {},
      makeCtx(e => {
        events.push(e)
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0].phase).toBe('beforeSave')
    expect(events[0].hookName).toBe('auto-slugify')
    expect(events[0].priority).toBe(1000)
    expect(events[0].outcome).toBe('success')
    expect(events[0].source).toBe('site-local')
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('throwing before* handler fires one event with outcome hook-cancelled', async () => {
    const events: HookFiringEvent[] = []
    const r = new HookRegistry()
    const bad: BeforeSaveHook = async () => {
      throw new Error('nope')
    }
    r.register('beforeSave', bad, { name: 'reject' })
    try {
      await dispatchBeforeSave(
        r,
        { kind: 'page', name: 'home' },
        {},
        makeCtx(e => {
          events.push(e)
        }),
      )
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HookCancellation)
    }
    expect(events).toHaveLength(1)
    expect(events[0].outcome).toBe('hook-cancelled')
    expect(events[0].hookName).toBe('reject')
  })

  it('timing-out before* handler fires one event with outcome timeout', async () => {
    const events: HookFiringEvent[] = []
    const r = new HookRegistry()
    const slow: BeforeSaveHook = async (_s, p, _c) => new Promise(resolve => setTimeout(() => resolve(p), 200))
    r.register('beforeSave', slow, { name: 'slow', timeout: 50 })
    try {
      await dispatchBeforeSave(
        r,
        { kind: 'page', name: 'home' },
        {},
        makeCtx(e => {
          events.push(e)
        }),
      )
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HookTimeout)
    }
    expect(events).toHaveLength(1)
    expect(events[0].outcome).toBe('timeout')
  })

  it('every handler in the chain fires its own event', async () => {
    const events: HookFiringEvent[] = []
    const r = new HookRegistry()
    const ok: BeforeSaveHook = async (_s, p, _c) => p
    r.register('beforeSave', ok, { name: 'a', priority: 50 })
    r.register('beforeSave', ok, { name: 'b', priority: 100 })
    r.register('beforeSave', ok, { name: 'c', priority: 200 })
    await dispatchBeforeSave(
      r,
      { kind: 'page', name: 'home' },
      {},
      makeCtx(e => {
        events.push(e)
      }),
    )
    expect(events.map(e => e.hookName)).toEqual(['a', 'b', 'c'])
    for (const e of events) expect(e.outcome).toBe('success')
  })

  it('after* parallel chain emits one event per handler (success or cancelled)', async () => {
    const events: HookFiringEvent[] = []
    const r = new HookRegistry()
    const ok: AfterSaveHook = async () => {}
    const bad: AfterSaveHook = async () => {
      throw new Error('boom')
    }
    r.register('afterSave', ok, { name: 'good' })
    r.register('afterSave', bad, { name: 'crash' })
    await dispatchAfterSave(
      r,
      { kind: 'page', name: 'home' },
      { payload: {} },
      makeCtx(e => {
        events.push(e)
      }),
    )
    expect(events).toHaveLength(2)
    const byName = Object.fromEntries(events.map(e => [e.hookName, e.outcome]))
    expect(byName.good).toBe('success')
    expect(byName.crash).toBe('hook-cancelled')
  })

  it('emitter throwing does not break dispatch', async () => {
    const r = new HookRegistry()
    const ok: BeforeSaveHook = async (_s, p, _c) => p
    r.register('beforeSave', ok, { name: 'a' })
    const result = await dispatchBeforeSave(
      r,
      { kind: 'page', name: 'home' },
      { x: 1 },
      makeCtx(() => {
        throw new Error('audit recorder down')
      }),
    )
    expect(result).toEqual({ x: 1 })
  })

  it('no emitter (ctx.auditEmit undefined) is silent', async () => {
    const r = new HookRegistry()
    const ok: BeforeSaveHook = async (_s, p, _c) => p
    r.register('beforeSave', ok, { name: 'a' })
    // Plain ctx with no emitter — should not throw.
    await expect(dispatchBeforeSave(r, { kind: 'page', name: 'home' }, {}, makeCtx())).resolves.toBeDefined()
  })
})

// ---- admin-api-layer integration test ---------------------------

const projectRoot = tempDir('hooks-audit-' + Date.now())
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

  const hooks = new HookRegistry()
  const inject: BeforeSaveHook<Record<string, unknown>> = async (_s, p, _c) => p
  hooks.register('beforeSave', inject as BeforeSaveHook, { name: 'audit-test-hook' })
  hooks.seal()

  app = createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
    hooks,
  })
})

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader-only' })
  return reader.query!({})
}

describe('Cut 7 — end-to-end hook-fired audit events', () => {
  it('hook firing during PUT /api/pages records action: hook-fired', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-hook-test', template: 'page-default' }),
    })
    const res = await app.request('/api/pages/audit-hook-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hi' } }),
    })
    expect(res.status).toBe(200)

    const events = await readAuditEvents()
    const hookFired = events.filter(e => e.action === 'hook-fired')
    expect(hookFired.length).toBeGreaterThan(0)
    const ours = hookFired.find(e => (e.metadata?.hookName as string) === 'audit-test-hook')
    expect(ours).toBeDefined()
    expect(ours!.outcome).toBe('success')
    expect(ours!.metadata?.phase).toBe('beforeSave')
    expect(ours!.metadata?.source).toBe('site-local')
    expect(typeof ours!.metadata?.durationMs).toBe('number')
  })
})
