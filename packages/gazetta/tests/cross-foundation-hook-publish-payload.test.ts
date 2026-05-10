/**
 * Cross-foundation gap #7 (per testing-plan.md punch list):
 * Publish to a non-editable target observes the hook-modified manifest
 * payload (post-beforeSave), not the pre-hook input.
 *
 * The contract chain (per design-hooks.md "Save flow with hooks"):
 *   1. PUT /api/pages → validators run → beforeSave hooks fire →
 *      hook returns mutated payload → manifest written to source
 *      with post-hook content
 *   2. POST /api/publish source → non-editable destination → publish
 *      reads source manifest verbatim (no hook re-fire) → destination
 *      receives post-hook content
 *
 * The forensic concern this guards: if publish bypassed storage and
 * re-read the request body somehow, the destination would receive the
 * pre-hook payload — silently breaking hook-as-payload-transformer
 * contracts (auto-slugify, EXIF-derived metadata, etc.). Today's
 * publish path reads manifests from storage; this test pins that.
 *
 * Per rule 26 (test-isolation paranoia): fresh memoryStorage + fresh
 * createAdminApp per test.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { HookRegistry } from '../src/hooks/index.js'
import type { BeforeSaveHook } from '../src/hooks/index.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let sourceStorage: MemoryStorage
let stagingStorage: MemoryStorage

beforeEach(() => {
  sourceStorage = memoryStorage()
  stagingStorage = memoryStorage()
  // Seed source with a fragment that the hook will mutate on save.
  // Static-mode publish copies source → target verbatim; we read
  // back from staging to verify the post-hook bytes survived.
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({
      template: 'header-layout',
      content: { title: 'Original' },
    }),
  })

  // beforeSave hook: append a marker to content.title so we can
  // distinguish pre-hook vs post-hook content in the destination.
  const hooks = new HookRegistry()
  const stamper: BeforeSaveHook = async (_scope, payload, _ctx) => {
    const p = payload as { template: string; content?: Record<string, unknown> }
    return {
      ...p,
      content: { ...(p.content ?? {}), title: `${p.content?.title} [post-hook]` },
    } as unknown as Record<string, unknown>
  }
  hooks.register('beforeSave', stamper, { name: 'append-post-hook' })
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
      ['staging', stagingStorage],
    ]),
    targetConfigs: {
      local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
      // editable: false (default) — destination cannot itself receive
      // direct writes, only publishes from local.
      staging: { storage: stagingStorage, type: 'esi', environment: 'staging' },
    },
    disableCacheStatsLogger: true,
    hooks,
    // Empty validators — we're testing the save→publish chain, not
    // template-existence rules.
    validators: createValidatorRegistry([]),
  })
})

describe('Cross-foundation gap #7 — publish observes hook-modified manifest', () => {
  it('save → beforeSave hook mutates content → publish copies post-hook bytes to non-editable target', async () => {
    // Save a fragment update through the full pipeline. The hook
    // appends '[post-hook]' to content.title before storage write.
    const saveRes = await app.request('/api/fragments/header', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'header-layout',
        content: { title: 'Updated' },
      }),
    })
    expect(saveRes.status).toBe(200)

    // Source manifest should have post-hook content on disk.
    const sourceManifest = JSON.parse(await sourceStorage.readFile('fragments/header/fragment.json'))
    expect(sourceManifest.content.title).toBe('Updated [post-hook]')

    // Publish source → staging (editable: false).
    const publishRes = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['staging'],
      }),
    })
    expect(publishRes.status).toBeLessThan(300)

    // Staging should have the post-hook content — what's on source
    // disk, not the pre-hook payload from the original save request.
    const stagingManifest = JSON.parse(await stagingStorage.readFile('fragments/header/fragment.json'))
    expect(stagingManifest.content.title).toBe('Updated [post-hook]')
  })

  it('publish bypasses re-firing beforeSave (the hook ran at save time, not publish time)', async () => {
    // Save once (hook fires, content gets the marker).
    await app.request('/api/fragments/header', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'header-layout',
        content: { title: 'Once' },
      }),
    })
    // Source has 'Once [post-hook]'.

    // Publish — beforeSave should NOT fire here; the manifest is
    // already in its post-hook state from the save. If it did fire,
    // the destination would have 'Once [post-hook] [post-hook]'.
    await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['fragments/header'],
        targets: ['staging'],
      }),
    })

    const stagingManifest = JSON.parse(await stagingStorage.readFile('fragments/header/fragment.json'))
    expect(stagingManifest.content.title).toBe('Once [post-hook]')
    // Critically: NOT the double-marker that would mean beforeSave
    // re-fired during publish.
    expect(stagingManifest.content.title).not.toContain('[post-hook] [post-hook]')
  })
})
