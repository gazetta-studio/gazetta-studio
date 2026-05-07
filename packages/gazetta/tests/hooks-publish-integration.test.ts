/**
 * Cut 5 tests: end-to-end publish hook firing.
 *
 * Validates the publish-route wiring: HookRegistry →
 * createAdminApp → POST /api/publish → dispatchBeforePublish (per
 * target) → publishItems → audit → dispatchAfterPublish (per
 * target).
 *
 * Strategy: in-memory source + in-memory target (both via
 * memoryStorage()). Seed the source with a minimal page manifest;
 * post a publish request; assert the hooks fired with the expected
 * shape AND the target storage received the copied bytes.
 *
 * We test publish for fragments only — pages would also need a
 * template-resolution path (publish-rendered.ts) which trips on
 * memoryStorage's lack of a real templates directory. Fragments
 * still publish in static mode but the renderer reads template
 * fixtures from `templatesDir`, which the test passes empty to
 * skip rendering entirely. We pin the BEFORE/AFTER hook firing
 * (the load-bearing wire-through path); rendered-output testing
 * lives in publish-rendered.test.ts and is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { HookRegistry } from '../src/hooks/index.js'
import type { AfterPublishHook, BeforePublishHook, PublishHookResult, PublishItem } from '../src/hooks/index.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

interface CapturedBefore {
  target: string
  items: ReadonlyArray<PublishItem>
}
interface CapturedAfter {
  target: string
  result: PublishHookResult
}

let app: Hono
let sourceStorage: MemoryStorage
let targetStorage: MemoryStorage
const beforeCalls: CapturedBefore[] = []
const afterCalls: CapturedAfter[] = []

beforeEach(() => {
  beforeCalls.length = 0
  afterCalls.length = 0
  sourceStorage = memoryStorage()
  targetStorage = memoryStorage()

  // Seed the source with a minimal fragment that the publish flow
  // can copy. Static-mode publish copies source → target verbatim;
  // we don't render, so the manifest's contents don't matter for
  // hook firing.
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout' }),
  })

  const hooks = new HookRegistry()

  // beforePublish — record + filter (drop fragments matching a
  // synthetic predicate).
  const recordBefore: BeforePublishHook = async (target, items, _ctx) => {
    beforeCalls.push({ target, items: [...items] })
    return items
  }
  hooks.register('beforePublish', recordBefore, { name: 'record-before' })

  // afterPublish — record per-target results.
  const recordAfter: AfterPublishHook = async (target, result, _ctx) => {
    afterCalls.push({ target, result })
  }
  hooks.register('afterPublish', recordAfter, { name: 'record-after' })

  hooks.seal()

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site' },
  })

  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: {
      local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
      staging: { storage: targetStorage, type: 'esi', environment: 'staging' },
    },
    disableCacheStatsLogger: true,
    hooks,
  })
})

afterEach(() => {
  // memoryStorage is per-test fresh via beforeEach.
})

describe('Cut 5 — end-to-end publish hooks', () => {
  it('beforePublish receives the requested items + target', async () => {
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['staging'],
      }),
    })
    expect(res.status).toBeLessThan(300)
    expect(beforeCalls).toHaveLength(1)
    expect(beforeCalls[0].target).toBe('staging')
    expect(beforeCalls[0].items).toEqual([{ kind: 'fragment', name: 'header', path: 'fragments/header' }])
  })

  it('afterPublish fires with success result per target', async () => {
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['staging'],
      }),
    })
    expect(res.status).toBeLessThan(300)
    expect(afterCalls).toHaveLength(1)
    expect(afterCalls[0].target).toBe('staging')
    expect(afterCalls[0].result.target).toBe('staging')
    // Target storage actually received the manifest
    expect(await targetStorage.exists('fragments/header/fragment.json')).toBe(true)
  })

  it('beforePublish chain mutation propagates to publish + afterPublish', async () => {
    // Add a second hook that DROPS fragments/footer. Should result
    // in only fragments/header reaching the target.
    sourceStorage.seed({
      'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout' }),
    })
    const hooks2 = new HookRegistry()
    hooks2.register('beforePublish', async (_target, items) => items.filter(i => i.name !== 'footer'), {
      name: 'drop-footer',
      priority: 50,
    })
    const recordBefore2: BeforePublishHook = async (target, items, _ctx) => {
      beforeCalls.push({ target, items: [...items] })
      return items
    }
    hooks2.register('beforePublish', recordBefore2, { name: 'record', priority: 100 })
    hooks2.seal()

    const source = createSourceContext({
      storage: sourceStorage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site' },
    })
    const targetStorage2 = memoryStorage()
    const app2 = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targets: new Map([
        ['local', sourceStorage],
        ['staging', targetStorage2],
      ]),
      targetConfigs: {
        local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
        staging: { storage: targetStorage2, type: 'esi', environment: 'staging' },
      },
      disableCacheStatsLogger: true,
      hooks: hooks2,
    })

    beforeCalls.length = 0
    const res = await app2.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header', 'fragments/footer'],
        targets: ['staging'],
      }),
    })
    expect(res.status).toBeLessThan(300)
    // Recorder saw the post-filter list (lower-priority drop-footer
    // ran first, then recorder).
    expect(beforeCalls).toHaveLength(1)
    expect(beforeCalls[0].items).toHaveLength(1)
    expect(beforeCalls[0].items[0].name).toBe('header')
    // Target storage shows the filter — only header copied.
    expect(await targetStorage2.exists('fragments/header/fragment.json')).toBe(true)
    expect(await targetStorage2.exists('fragments/footer/fragment.json')).toBe(false)
  })

  it('beforePublish throw returns 409 HOOK_CANCELLED', async () => {
    const hooks2 = new HookRegistry()
    hooks2.register(
      'beforePublish',
      async () => {
        throw new Error('publish blocked')
      },
      { name: 'block-publish' },
    )
    hooks2.seal()
    const source = createSourceContext({
      storage: sourceStorage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site' },
    })
    const targetStorage2 = memoryStorage()
    const app2 = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targets: new Map([
        ['local', sourceStorage],
        ['staging', targetStorage2],
      ]),
      targetConfigs: {
        local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
        staging: { storage: targetStorage2, type: 'esi', environment: 'staging' },
      },
      disableCacheStatsLogger: true,
      hooks: hooks2,
    })
    const res = await app2.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['staging'],
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; hook: string; reason: string }
    expect(body.code).toBe('HOOK_CANCELLED')
    expect(body.hook).toBe('block-publish')
    expect(body.reason).toContain('publish blocked')
    // Target storage didn't receive anything
    expect(await targetStorage2.exists('fragments/header/fragment.json')).toBe(false)
  })

  it('multi-target publish dispatches beforePublish + afterPublish per target', async () => {
    // Set up two targets.
    const targetA = memoryStorage()
    const targetB = memoryStorage()
    const hooks2 = new HookRegistry()
    const recordBefore2: BeforePublishHook = async (target, items, _ctx) => {
      beforeCalls.push({ target, items: [...items] })
      return items
    }
    const recordAfter2: AfterPublishHook = async (target, result, _ctx) => {
      afterCalls.push({ target, result })
    }
    hooks2.register('beforePublish', recordBefore2, { name: 'record-before' })
    hooks2.register('afterPublish', recordAfter2, { name: 'record-after' })
    hooks2.seal()

    const source = createSourceContext({
      storage: sourceStorage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site' },
    })
    const app2 = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targets: new Map([
        ['local', sourceStorage],
        ['target-a', targetA],
        ['target-b', targetB],
      ]),
      targetConfigs: {
        local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
        'target-a': { storage: targetA, type: 'esi', environment: 'staging' },
        'target-b': { storage: targetB, type: 'esi', environment: 'staging' },
      },
      disableCacheStatsLogger: true,
      hooks: hooks2,
    })

    beforeCalls.length = 0
    afterCalls.length = 0
    const res = await app2.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['target-a', 'target-b'],
      }),
    })
    expect(res.status).toBeLessThan(300)
    // beforePublish fires once per target
    expect(beforeCalls.map(c => c.target)).toEqual(['target-a', 'target-b'])
    // afterPublish fires once per result
    expect(afterCalls.map(c => c.target).sort()).toEqual(['target-a', 'target-b'])
    expect(await targetA.exists('fragments/header/fragment.json')).toBe(true)
    expect(await targetB.exists('fragments/header/fragment.json')).toBe(true)
  })

  it('publish works without hooks (opts.hooks undefined)', async () => {
    const source = createSourceContext({
      storage: sourceStorage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site' },
    })
    const targetNoHooks = memoryStorage()
    const appNoHooks = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targets: new Map([
        ['local', sourceStorage],
        ['staging', targetNoHooks],
      ]),
      targetConfigs: {
        local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
        staging: { storage: targetNoHooks, type: 'esi', environment: 'staging' },
      },
      disableCacheStatsLogger: true,
      // hooks omitted
    })
    beforeCalls.length = 0
    afterCalls.length = 0
    const res = await appNoHooks.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['staging'],
      }),
    })
    expect(res.status).toBeLessThan(300)
    // No hooks fired
    expect(beforeCalls).toHaveLength(0)
    expect(afterCalls).toHaveLength(0)
    // Publish still happened
    expect(await targetNoHooks.exists('fragments/header/fragment.json')).toBe(true)
  })
})
