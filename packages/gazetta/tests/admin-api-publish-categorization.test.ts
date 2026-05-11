/**
 * Mutation-coverage tests for `toPublishItem()` + `evaluatePublishGate()`
 * in `src/admin-api/routes/publish.ts`.
 *
 * Closes the gap reported on issue #307. The internal helpers aren't
 * exported, so we exercise them through the route surface:
 *
 *   - `toPublishItem()` is called when mapping body.items to
 *     `PublishItem` for the `beforePublish` hook dispatch. We register
 *     a recording hook and assert the categorization (kind + name +
 *     path) for each branch: `pages/*`, `fragments/*`, `assets/*`, and
 *     the prefix-less fallback path.
 *   - `evaluatePublishGate()` filters out asset items before running
 *     pre-publish validators. We register an always-fail validator and
 *     verify the gate triggers (409) on a page publish but does NOT
 *     trigger on an asset-only publish.
 *
 * Per [team-preferences rule 31](.claude/rules/team-preferences.md):
 * API-first tier for admin-API surface; mutation testing is the
 * discovery tool.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { HookRegistry } from '../src/hooks/index.js'
import type { BeforePublishHook, PublishItem } from '../src/hooks/index.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { Validator } from '../src/validation/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

interface CapturedBefore {
  target: string
  items: ReadonlyArray<PublishItem>
}

function buildApp(opts?: { capture?: CapturedBefore[]; validator?: Validator }): {
  app: Hono
  sourceStorage: MemoryStorage
  targetStorage: MemoryStorage
} {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
  })

  const hooks = new HookRegistry()
  if (opts?.capture) {
    const capture = opts.capture
    const recordBefore: BeforePublishHook = async (target, items) => {
      capture.push({ target, items: [...items] })
      return items
    }
    hooks.register('beforePublish', recordBefore, { name: 'capture-before' })
  }
  hooks.seal()

  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: { storage: targetStorage, type: 'esi' as const, environment: 'staging' as const },
  }

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    hooks,
    ...(opts?.validator ? { validators: createValidatorRegistry([opts.validator]) } : {}),
  })

  return { app, sourceStorage, targetStorage }
}

function alwaysFailValidator(): Validator {
  return {
    source: 'gazetta',
    name: 'test-always-fail',
    stages: ['pre-publish'] as const,
    defaultSeverity: () => 'error',
    async validate(input) {
      if (input.scope.kind !== 'pre-publish') return []
      return input.scope.items.map(item => ({
        validator: 'test-always-fail',
        severity: 'error' as const,
        message: `synthetic error for ${item.name}`,
        itemPath: item.itemPath,
      }))
    },
  }
}

describe('publish route — toPublishItem categorization (covers publish.ts:85-97)', () => {
  it('pages/* paths surface as kind=page with the slug-only name', async () => {
    const capture: CapturedBefore[] = []
    const { app } = buildApp({ capture })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
    expect(res.status).toBeLessThan(500)

    expect(capture).toHaveLength(1)
    expect(capture[0].items).toEqual([{ kind: 'page', name: 'home', path: 'pages/home' }])
  })

  it('fragments/* paths surface as kind=fragment with the slug-only name', async () => {
    const capture: CapturedBefore[] = []
    const { app } = buildApp({ capture })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['fragments/header'], targets: ['staging'] }),
    })
    expect(res.status).toBeLessThan(500)

    expect(capture).toHaveLength(1)
    expect(capture[0].items).toEqual([{ kind: 'fragment', name: 'header', path: 'fragments/header' }])
  })

  it('assets/* paths surface as kind=asset with the assets/ prefix stripped from the name', async () => {
    const capture: CapturedBefore[] = []
    const { app } = buildApp({ capture })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['assets/hero'], targets: ['staging'] }),
    })
    expect(res.status).toBeLessThan(500)

    // Kills line 89 mutations ("startsWith('fragments/')" → true / "")
    // by asserting kind=asset (would be 'fragment' under the mutation).
    // Kills line 94 mutations (slice / endsWith / empty-string variants)
    // by asserting name === 'hero' (would be 'assets/hero' under the
    // mutations that bypass the slice).
    expect(capture).toHaveLength(1)
    expect(capture[0].items).toEqual([{ kind: 'asset', name: 'hero', path: 'assets/hero' }])
  })

  it('paths without a known prefix fall back to kind=asset with the full path as the name', async () => {
    const capture: CapturedBefore[] = []
    const { app } = buildApp({ capture })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['orphan-thing'], targets: ['staging'] }),
    })
    expect(res.status).toBeLessThan(500)

    // Kills the line 94 mutation that swaps the slice for the raw
    // itemPath — the fallback IS the raw itemPath here, so its variant
    // surfaces against the `assets/...` test above.
    expect(capture).toHaveLength(1)
    expect(capture[0].items).toEqual([{ kind: 'asset', name: 'orphan-thing', path: 'orphan-thing' }])
  })

  it('nested asset paths preserve the slash structure in name', async () => {
    const capture: CapturedBefore[] = []
    const { app } = buildApp({ capture })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['assets/folder/nested-asset'], targets: ['staging'] }),
    })
    expect(res.status).toBeLessThan(500)

    expect(capture).toHaveLength(1)
    expect(capture[0].items).toEqual([
      { kind: 'asset', name: 'folder/nested-asset', path: 'assets/folder/nested-asset' },
    ])
  })

  it('mixed publish set categorizes each path independently', async () => {
    const capture: CapturedBefore[] = []
    const { app } = buildApp({ capture })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['pages/home', 'fragments/header', 'assets/hero'],
        targets: ['staging'],
      }),
    })
    expect(res.status).toBeLessThan(500)

    expect(capture).toHaveLength(1)
    expect(capture[0].items).toEqual([
      { kind: 'page', name: 'home', path: 'pages/home' },
      { kind: 'fragment', name: 'header', path: 'fragments/header' },
      { kind: 'asset', name: 'hero', path: 'assets/hero' },
    ])
  })
})

describe('publish route — evaluatePublishGate kind filter (covers publish.ts:121)', () => {
  it('triggers the gate (409) for page items when a pre-publish validator errors', async () => {
    const { app } = buildApp({ validator: alwaysFailValidator() })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })

    // Line 121 mutation (filter → false) would empty `items` and skip
    // the gate; this assertion fails under that mutation because the
    // publish would proceed past the gate rather than returning 409.
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      blocked: Array<{ target: string; issues: Array<{ severity: string }> }>
    }
    expect(body.code).toBe('PUBLISH_AUDIT_FAILED')
    expect(body.blocked).toHaveLength(1)
    expect(body.blocked[0].target).toBe('staging')
    expect(body.blocked[0].issues[0].severity).toBe('error')
  })

  it('triggers the gate (409) for fragment items when a pre-publish validator errors', async () => {
    const { app } = buildApp({ validator: alwaysFailValidator() })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['fragments/header'], targets: ['staging'] }),
    })

    // Confirms the kind filter accepts fragments in addition to pages
    // (the `||` branch on line 121).
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; blocked: Array<{ target: string }> }
    expect(body.code).toBe('PUBLISH_AUDIT_FAILED')
    expect(body.blocked).toHaveLength(1)
  })

  it('skips the gate for an asset-only publish (no 409 even with an always-fail validator)', async () => {
    const { app } = buildApp({ validator: alwaysFailValidator() })

    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['assets/hero'], targets: ['staging'] }),
    })

    // The publish may still 4xx/5xx for unrelated reasons (memory
    // storage doesn't carry an asset manifest); the contract this test
    // pins is that the GATE is not the blocker — no PUBLISH_AUDIT_FAILED.
    if (res.status === 409) {
      const body = (await res.json()) as { code?: string }
      expect(body.code).not.toBe('PUBLISH_AUDIT_FAILED')
    }
  })
})
