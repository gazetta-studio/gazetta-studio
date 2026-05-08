/**
 * Validation Cut 4 tests: server-side audit endpoint + publish gate.
 *
 * Wires a custom `ValidatorRegistry` with a synthetic pre-publish-stage
 * validator into `createAdminApp`, exercising:
 *   - POST /api/publish/audit returns issues + the per-target strict flag
 *   - POST /api/publish refuses with 409 when the audit produces error-
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

describe('Validation Cut 4 — POST /api/publish/audit', () => {
  beforeEach(() => {
    setupApp({ validator: buildAlwaysFailValidator('error') })
  })

  it('returns the validator-emitted issues + the target strict flag', async () => {
    const res = await app.request('/api/publish/audit', {
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
    const res = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging' }),
    })
    expect(res.status).toBe(400)
  })

  it('promotes warns to errors when target.publishAudit.strict is set', async () => {
    setupApp({ validator: buildAlwaysFailValidator('warn'), publishAuditStrict: true })
    const res = await app.request('/api/publish/audit', {
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
    const res = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issues: unknown[] }
    expect(body.issues).toEqual([])
  })
})

describe('Validation Cut 4 — POST /api/publish gate', () => {
  it('refuses with 409 PUBLISH_AUDIT_FAILED when the audit produces errors', async () => {
    setupApp({ validator: buildAlwaysFailValidator('error') })
    const res = await app.request('/api/publish', {
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
    const res = await app.request('/api/publish', {
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
    const res = await app.request('/api/publish', {
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
