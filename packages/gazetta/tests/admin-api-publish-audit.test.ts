/**
 * Validation Cut 4 tests: server-side audit endpoint + publish gate.
 *
 * Wires a custom `ValidatorRegistry` with a synthetic pre-publish-stage
 * validator into `createAdminApp`, exercising:
 *   - POST /api/v1/publish/audit returns issues + the per-target strict flag
 *   - POST /api/v1/publish refuses with 409 when the audit produces error-
 *     severity issues (same code as the validation cut document calls
 *     out — defense in depth so the dialog can't be bypassed)
 *   - publishAudit.strict promotes warns to errors at the gate
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { Validator } from '../src/validation/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let sourceStorage: MemoryStorage
let targetStorage: MemoryStorage

function buildAlwaysFailValidator(severity: 'error' | 'warn' | 'info' = 'error'): Validator {
  return {
    source: 'gazetta',
    name: 'test-always-fail',
    stages: ['pre-publish'] as const,
    defaultSeverity: () => severity,
    async validate(input) {
      if (input.scope.kind !== 'pre-publish') return []
      return input.scope.items.map(item => ({
        validator: 'test-always-fail',
        severity,
        message: `synthetic ${severity} for ${item.name}`,
        itemPath: item.itemPath,
      }))
    },
  }
}

function setupApp(opts: { validator: Validator; publishAuditStrict?: boolean }): void {
  sourceStorage = memoryStorage()
  targetStorage = memoryStorage()
  sourceStorage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
  })

  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: {
      storage: targetStorage,
      type: 'esi' as const,
      environment: 'staging' as const,
      ...(opts.publishAuditStrict ? { publishAudit: { strict: true } } : {}),
    },
  }

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })

  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    validators: createValidatorRegistry([opts.validator]),
  })
}

describe('Validation Cut 4 — POST /api/v1/publish/audit', () => {
  beforeEach(() => {
    setupApp({ validator: buildAlwaysFailValidator('error') })
  })

  it('returns the validator-emitted issues + the target strict flag', async () => {
    const res = await app.request('/api/v1/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'staging',
        items: [{ kind: 'page', name: 'home' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issues: Array<{ severity: string; message: string }>; strict: boolean }
    expect(body.strict).toBe(false)
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0].severity).toBe('error')
    expect(body.issues[0].message).toContain('home')
  })

  it('400s on a missing items array', async () => {
    const res = await app.request('/api/v1/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging' }),
    })
    expect(res.status).toBe(400)
  })

  it('promotes warns to errors when target.publishAudit.strict is set', async () => {
    setupApp({ validator: buildAlwaysFailValidator('warn'), publishAuditStrict: true })
    const res = await app.request('/api/v1/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'staging',
        items: [{ kind: 'page', name: 'home' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issues: Array<{ severity: string }>; strict: boolean }
    expect(body.strict).toBe(true)
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0].severity).toBe('error')
  })

  it('returns empty issues when no items are pages or fragments', async () => {
    const res = await app.request('/api/v1/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issues: unknown[] }
    expect(body.issues).toEqual([])
  })
})

describe('Validation Cut 4 — POST /api/v1/publish gate', () => {
  it('refuses with 409 PUBLISH_AUDIT_FAILED when the audit produces errors', async () => {
    setupApp({ validator: buildAlwaysFailValidator('error') })
    const res = await app.request('/api/v1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
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

  it('does NOT block when the validator produces only warns (non-strict target)', async () => {
    setupApp({ validator: buildAlwaysFailValidator('warn') })
    const res = await app.request('/api/v1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
    // Publish proceeds (not 409). The actual publish may still fail
    // for unrelated reasons (memory-storage publish quirks), but the
    // gate must not be the blocker.
    expect(res.status).not.toBe(409)
  })

  it('blocks when strict promotion turns warns into errors', async () => {
    setupApp({ validator: buildAlwaysFailValidator('warn'), publishAuditStrict: true })
    const res = await app.request('/api/v1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; blocked: unknown[] }
    expect(body.code).toBe('PUBLISH_AUDIT_FAILED')
    expect(body.blocked).toHaveLength(1)
  })
})

// These publish through the starter's templates: well under a second alone, over 5 s on a loaded CI runner.
describe('the server gate and the render read one snapshot (#1632)', { timeout: 30_000 }, () => {
  const original = JSON.stringify({ template: 'page-default', route: '/', content: {}, metadata: { title: 'Audited' } })
  const changed = JSON.stringify({
    template: 'page-default',
    route: '/',
    content: {},
    metadata: { title: 'Unaudited' },
  })

  // Saves `pages/home` while the gate audits it: what the gate saw is what must go out.
  function saveDuringGate(storage: MemoryStorage): Validator {
    return {
      source: 'gazetta',
      name: 'test-save-during-gate',
      stages: ['pre-publish'] as const,
      defaultSeverity: () => 'error',
      async validate(input) {
        if (input.scope.kind !== 'pre-publish') return []
        await storage.writeFile('pages/home/page.json', changed)
        return []
      },
    }
  }

  async function publishWith(route: '/api/v1/publish' | '/api/v1/publish/stream') {
    const { starterTemplatesDir } = await import('./_helpers/starter.js')
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({ 'pages/home/page.json': original })
    const targetConfigs = {
      local: { storage: source, type: 'esi' as const, environment: 'local' as const, editable: true },
      staging: { storage: target, type: 'esi' as const, environment: 'staging' as const, publicStorage: false },
    }
    const publishApp = createAdminApp({
      source: createSourceContext({
        storage: source,
        siteDir: '',
        projectSiteDir: '/test-project',
        manifest: { name: 'test-site', targets: targetConfigs },
      }),
      siteDir: '/test-project',
      templatesDir: starterTemplatesDir,
      targets: new Map([
        ['local', source],
        ['staging', target],
      ]),
      targetConfigs,
      disableCacheStatsLogger: true,
      validators: createValidatorRegistry([saveDuringGate(source)]),
    })
    const res = await publishApp.request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
    await res.text()
    return { res, source, target }
  }

  it.each(['/api/v1/publish', '/api/v1/publish/stream'] as const)('%s publishes what the gate audited', async route => {
    const { res, source, target } = await publishWith(route)
    expect(res.status).toBe(200)
    expect(await source.readFile('pages/home/page.json')).toBe(changed)
    expect(await target.readFile('pages/home/page.json')).toBe(original)
    expect(await target.readFile('index.html')).toContain('Audited')
  })
})

describe('afterPublish hooks get the items an asset removal kept back (#1632)', { timeout: 30_000 }, () => {
  const page = (title: string) =>
    JSON.stringify({ template: 'page-default', route: '/', content: { image: { _asset: 'sky' } }, metadata: { title } })

  // Removes the asset's bytes while the gate audits, after the snapshot was taken.
  function removeAssetDuringGate(storage: MemoryStorage): Validator {
    return {
      source: 'gazetta',
      name: 'test-remove-asset-during-gate',
      stages: ['pre-publish'] as const,
      defaultSeverity: () => 'error',
      async validate(input) {
        if (input.scope.kind !== 'pre-publish') return []
        await storage.rm('assets/sky-aaaaaaaa.png')
        return []
      },
    }
  }

  it.each(['/api/v1/publish', '/api/v1/publish/stream'] as const)(
    '%s reports a translation as failed, not published',
    async route => {
      const { starterTemplatesDir } = await import('./_helpers/starter.js')
      const { HookRegistry } = await import('../src/hooks/index.js')
      const source = memoryStorage()
      const target = memoryStorage()
      source.seed({
        'pages/home/page.json': page('Home'),
        'pages/home/page.fr.json': page('Accueil'),
        'assets/sky.asset.json': JSON.stringify({
          version: 1,
          name: 'sky',
          kind: 'embedded',
          source: 'internal',
          mime: 'image/png',
          size: 3,
          hash: 'aaaaaaaa',
          width: null,
          height: null,
          variants: [],
          tags: [],
          alt: 'Sky',
          uploadedAt: '2026-11-01T00:00:00.000Z',
          uploadedBy: '',
        }),
        'assets/sky-aaaaaaaa.png': 'png',
      })
      const results: { published: string[]; failed: string[] }[] = []
      const hooks = new HookRegistry()
      hooks.register(
        'afterPublish',
        async (_target, result) => {
          results.push({
            published: result.itemsPublished.map(i => i.path),
            failed: result.itemsFailed.map(f => f.item.path),
          })
        },
        { name: 'record' },
      )
      hooks.seal()
      const targetConfigs = {
        local: { storage: source, type: 'esi' as const, environment: 'local' as const, editable: true },
        staging: { storage: target, type: 'esi' as const, environment: 'staging' as const, publicStorage: false },
      }
      const app = createAdminApp({
        source: createSourceContext({
          storage: source,
          siteDir: '',
          projectSiteDir: '/test-project',
          manifest: { name: 'test-site', targets: targetConfigs, locales: { default: 'en', supported: ['en', 'fr'] } },
        }),
        siteDir: '/test-project',
        templatesDir: starterTemplatesDir,
        targets: new Map([
          ['local', source],
          ['staging', target],
        ]),
        targetConfigs,
        disableCacheStatsLogger: true,
        hooks,
        validators: createValidatorRegistry([removeAssetDuringGate(source)]),
      })
      const res = await app.request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['pages/home:fr'], targets: ['staging'] }),
      })
      expect(await res.text()).not.toContain('"success":false')
      expect(results).toEqual([{ published: [], failed: ['pages/home:fr'] }])
    },
  )
})
