/**
 * Cut 4 tests: end-to-end hook firing via createAdminApp.
 *
 * Validates the full stack: HookRegistry → discoverSiteLocalHooks
 * (or programmatic registration) → admin app boot → PUT /api/pages
 * → dispatchBeforeSave + dispatchAfterSave → response includes
 * mutated payload + audit + afterSave hooks observed the result.
 *
 * Strategy: programmatic registration (skips disk discovery) so
 * test handlers are inlined; the dispatch path through the route
 * handler is exercised end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { HookRegistry } from '../src/hooks/index.js'
import type { AfterLoadHook, AfterSaveHook, BeforeSaveHook } from '../src/hooks/index.js'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')

interface CapturedAfterSave {
  scope: { kind: string; name?: string; locale?: string }
  etag?: string
}

interface CapturedAfterLoad {
  before: Record<string, unknown>
  after: Record<string, unknown>
}

const projectRoot = tempDir('hooks-integ-' + Date.now())
const projectSiteDir = resolve(projectRoot, 'sites/main')
const localTargetDir = resolve(projectSiteDir, 'targets/local')
const storage = createFilesystemProvider(localTargetDir)

let app: Hono
const afterSaveCalls: CapturedAfterSave[] = []
const afterLoadCalls: CapturedAfterLoad[] = []

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

  // Build the hook registry programmatically — bypasses disk
  // discovery so tests don't need to write fixture files.
  const hooks = new HookRegistry()

  // beforeSave that auto-injects a synthetic metadata field. Lets
  // the integration test assert the disk write reflects the hook's
  // mutation, not the original PUT body.
  const injectMeta: BeforeSaveHook<Record<string, unknown>> = async (_scope, payload, _ctx) => {
    const meta =
      typeof payload.metadata === 'object' && payload.metadata !== null
        ? { ...(payload.metadata as Record<string, unknown>) }
        : {}
    meta.modifiedByHook = true
    return { ...payload, metadata: meta }
  }
  hooks.register('beforeSave', injectMeta as BeforeSaveHook, { name: 'inject-meta' })

  // afterSave that records the event for assertion.
  const recordAfterSave: AfterSaveHook<unknown> = async (scope, result, _ctx) => {
    afterSaveCalls.push({
      scope: { kind: scope.kind, name: scope.name, locale: scope.locale },
      etag: result.etag,
    })
  }
  hooks.register('afterSave', recordAfterSave as AfterSaveHook, { name: 'record-after-save' })

  // afterLoad that injects a synthetic field into the response.
  const enrichLoad: AfterLoadHook<Record<string, unknown>> = async (_scope, payload, _ctx) => {
    const enriched = { ...payload, _hookEnriched: true }
    afterLoadCalls.push({ before: payload, after: enriched })
    return enriched
  }
  hooks.register('afterLoad', enrichLoad as AfterLoadHook, { name: 'enrich-load' })

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

describe('Cut 4 — end-to-end hook firing', () => {
  it('beforeSave mutates the manifest before storage write', async () => {
    // Create a page first (creates the directory + manifest).
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hooks-test-1', template: 'page-default' }),
    })
    // PUT updates the manifest. The beforeSave hook adds
    // `metadata.modifiedByHook: true` before storage write.
    const res = await app.request('/api/pages/hooks-test-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hi' } }),
    })
    expect(res.status).toBe(200)

    // Read the persisted manifest to confirm the mutation landed
    // on disk (not just in the response).
    const persisted = await storage.readFile('pages/hooks-test-1/page.json')
    const parsed = JSON.parse(persisted)
    expect(parsed.metadata?.modifiedByHook).toBe(true)
  })

  it('afterSave fires with the persisted result + etag', async () => {
    afterSaveCalls.length = 0
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hooks-test-2', template: 'page-default' }),
    })
    await app.request('/api/pages/hooks-test-2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Two' } }),
    })
    // afterSave fires after storage write; should have 1 PUT-driven
    // event. (POST goes through a different create path that
    // doesn't run beforeSave/afterSave at the moment — only PUT.)
    expect(afterSaveCalls).toHaveLength(1)
    expect(afterSaveCalls[0].scope).toEqual({ kind: 'page', name: 'hooks-test-2' })
    expect(afterSaveCalls[0].etag).toMatch(/^[a-f0-9]+$/)
  })

  it('afterLoad enriches GET responses', async () => {
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hooks-test-3', template: 'page-default' }),
    })
    afterLoadCalls.length = 0
    const res = await app.request('/api/pages/hooks-test-3')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body._hookEnriched).toBe(true)
    expect(afterLoadCalls).toHaveLength(1)
    expect(afterLoadCalls[0].after._hookEnriched).toBe(true)
  })

  it('beforeSave mutation flows through to the etag computation', async () => {
    // The etag must be computed against the post-hook manifest,
    // not the original. If etag was on the pre-hook manifest, a
    // subsequent GET would compute a different etag and the next
    // PUT's If-Match would fail with STALE.
    await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hooks-test-4', template: 'page-default' }),
    })
    const putRes = await app.request('/api/pages/hooks-test-4', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Four' } }),
    })
    expect(putRes.status).toBe(200)
    const putBody = (await putRes.json()) as { etag: string }
    const putEtag = putBody.etag

    // Subsequent GET should yield the same etag (afterLoad doesn't
    // affect etag — it transforms the response body, not the source).
    const getRes = await app.request('/api/pages/hooks-test-4')
    const getEtag = getRes.headers.get('etag')?.replace(/"/g, '')
    expect(getEtag).toBe(putEtag)
  })

  it('saves work normally without a hooks registry', async () => {
    // Construct a fresh app without hooks. Confirms the optional
    // `hooks` field truly defaults to no-op.
    const noHooksRoot = tempDir('hooks-integ-no-hooks-' + Date.now())
    await cp(realStarter, noHooksRoot, {
      recursive: true,
      filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
    })
    try {
      const noHooksSiteDir = resolve(noHooksRoot, 'sites/main')
      const noHooksLocalDir = resolve(noHooksSiteDir, 'targets/local')
      const noHooksStorage = createFilesystemProvider(noHooksLocalDir)
      const loaded = await loadSiteConfig(noHooksSiteDir)
      const manifest = siteConfigToManifest(loaded!.config)
      const source = createSourceContext({
        storage: noHooksStorage,
        siteDir: '',
        projectSiteDir: noHooksSiteDir,
        manifest,
      })
      const noHooksApp = createAdminApp({
        source,
        siteDir: noHooksSiteDir,
        templatesDir: resolve(noHooksRoot, 'templates'),
        adminDir: resolve(noHooksRoot, 'admin'),
        disableCacheStatsLogger: true,
        // hooks omitted — should be no-op
      })
      await noHooksApp.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-hooks', template: 'page-default' }),
      })
      const res = await noHooksApp.request('/api/pages/no-hooks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { title: 'No hooks' } }),
      })
      expect(res.status).toBe(200)
      const persisted = await noHooksStorage.readFile('pages/no-hooks/page.json')
      const parsed = JSON.parse(persisted)
      // No injection happened
      expect(parsed.metadata?.modifiedByHook).toBeUndefined()
    } finally {
      await rm(noHooksRoot, { recursive: true, force: true })
    }
  })
})

describe('Cut 4 — beforeSave cancellation', () => {
  let cancellingApp: Hono
  let cancellingRoot: string
  let cancellingStorage: ReturnType<typeof createFilesystemProvider>

  beforeAll(async () => {
    cancellingRoot = tempDir('hooks-integ-cancel-' + Date.now())
    await cp(realStarter, cancellingRoot, {
      recursive: true,
      filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
    })
    const siteDir = resolve(cancellingRoot, 'sites/main')
    const localDir = resolve(siteDir, 'targets/local')
    cancellingStorage = createFilesystemProvider(localDir)
    const loaded = await loadSiteConfig(siteDir)
    const manifest = siteConfigToManifest(loaded!.config)
    const source = createSourceContext({
      storage: cancellingStorage,
      siteDir: '',
      projectSiteDir: siteDir,
      manifest,
    })
    const hooks = new HookRegistry()
    const cancel: BeforeSaveHook = async (_scope, _payload, _ctx) => {
      throw new Error('test cancellation')
    }
    hooks.register('beforeSave', cancel, { name: 'cancel-everything' })
    hooks.seal()
    cancellingApp = createAdminApp({
      source,
      siteDir,
      templatesDir: resolve(cancellingRoot, 'templates'),
      adminDir: resolve(cancellingRoot, 'admin'),
      disableCacheStatsLogger: true,
      hooks,
    })
    await cancellingApp.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cancel-test', template: 'page-default' }),
    })
  })

  afterAll(async () => {
    await rm(cancellingRoot, { recursive: true, force: true })
  })

  it('beforeSave throw returns 409 with HOOK_CANCELLED code', async () => {
    const res = await cancellingApp.request('/api/pages/cancel-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Should fail' } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; hook: string; reason: string }
    expect(body.code).toBe('HOOK_CANCELLED')
    expect(body.hook).toBe('cancel-everything')
    expect(body.reason).toContain('test cancellation')
  })

  it('cancelled save does not write to disk', async () => {
    // Read what's on disk after the cancelled PUT — should be the
    // POST-created manifest (content.title defaults to page name),
    // NOT the PUT body that was cancelled.
    const persisted = await cancellingStorage.readFile('pages/cancel-test/page.json')
    const parsed = JSON.parse(persisted)
    // POST created content: { title: 'cancel-test' } (default).
    // PUT tried to write content: { title: 'Should fail' } but the
    // hook cancelled — disk still reflects the POST default.
    expect(parsed.content?.title).toBe('cancel-test')
  })
})
