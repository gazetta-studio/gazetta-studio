/**
 * POST /api/v1/publish/stream: the streaming publish the admin's Publish
 * button calls. It runs the same steps as POST /api/v1/publish before the
 * stream opens (beforePublish hooks, the publish gate, the strict-audit
 * pre-record), so a refusal there is a plain JSON problem, not an SSE
 * event. Once the stream is open, progress arrives as named SSE events,
 * one audit event records the publish, and afterPublish hooks see what
 * each target received.
 *
 * Two fragments rendered with the starter's templates, on ESI targets.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { HookRegistry } from '../src/hooks/index.js'
import type { PublishHookResult } from '../src/hooks/index.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { Validator } from '../src/validation/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

interface BuildOpts {
  hooks?: HookRegistry
  validator?: Validator
  strictAudit?: boolean
  /** Target storage whose writes all fail. */
  failTargetWrites?: boolean
}

function build(opts: BuildOpts = {}): { app: Hono; sourceStorage: MemoryStorage; targetStorage: MemoryStorage } {
  const sourceStorage = memoryStorage()
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout' }),
  })
  const inner = memoryStorage()
  const targetStorage: MemoryStorage = opts.failTargetWrites
    ? {
        ...inner,
        async writeFile(path: string): Promise<void> {
          throw new Error(`target write refused: ${path}`)
        },
      }
    : inner
  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: { storage: targetStorage, publicStorage: false, type: 'esi' as const, environment: 'staging' as const },
  }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      ...(opts.strictAudit ? { admin: { audit: { provider: 'history', strict: true } } } : {}),
    },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, MemoryStorage>([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.validator ? { validators: createValidatorRegistry([opts.validator]) } : {}),
  })
  return { app, sourceStorage, targetStorage }
}

function stream(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request('/api/v1/publish/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter(block => block.trim())
    .map(block => {
      const lines = block.split('\n')
      const event = lines.find(l => l.startsWith('event: '))?.slice('event: '.length) ?? ''
      const data = lines
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice('data: '.length))
        .join('\n')
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

async function publishEvents(app: Hono): Promise<Array<Record<string, unknown>>> {
  const res = await app.request('/api/v1/audit')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { events: Array<Record<string, unknown>> }
  return body.events.filter(e => e.action === 'publish')
}

function alwaysFail(severity: 'error' | 'warn'): Validator {
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

// These render through the starter's templates, which can take seconds on a loaded CI runner.
describe('POST /api/v1/publish/stream', { timeout: 30_000 }, () => {
  it('streams start, per-target and done events, and records one successful publish', async () => {
    const { app, targetStorage } = build()
    const res = await stream(app, { items: ['fragments/header'], targets: ['staging'] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = parseSse(await res.text())
    const kinds = events.map(e => e.event)
    expect(kinds[0]).toBe('start')
    expect(kinds).toContain('target-start')
    expect(kinds).toContain('target-result')
    expect(kinds.at(-1)).toBe('done')
    // Each event's name is its payload's kind.
    for (const e of events) expect(e.data.kind).toBe(e.event)
    const done = events.at(-1)!.data as { results: Array<{ target: string; success: boolean }> }
    expect(done.results).toEqual([expect.objectContaining({ target: 'staging', success: true })])

    expect(await targetStorage.exists('fragments/header/fragment.json')).toBe(true)
    const recorded = await publishEvents(app)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].outcome).toBe('success')
    expect(recorded[0].metadata).toMatchObject({ items: ['fragments/header'], targets: ['staging'] })
  })

  it('refuses with 409 HOOK_CANCELLED before the stream opens when a beforePublish hook throws', async () => {
    const hooks = new HookRegistry()
    hooks.register(
      'beforePublish',
      async () => {
        throw new Error('publish blocked')
      },
      { name: 'block-publish' },
    )
    hooks.seal()
    const { app, targetStorage } = build({ hooks })

    const res = await stream(app, { items: ['fragments/header'], targets: ['staging'] })
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).not.toContain('text/event-stream')
    const body = (await res.json()) as { code: string; hook: string; reason: string }
    expect(body.code).toBe('HOOK_CANCELLED')
    expect(body.hook).toBe('block-publish')
    expect(body.reason).toContain('publish blocked')

    expect(targetStorage.dump().size).toBe(0)
    const recorded = await publishEvents(app)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].outcome).toBe('hook-cancelled')
    expect(recorded[0].metadata).toMatchObject({
      items: ['fragments/header'],
      targets: ['staging'],
      hookCancelled: 'block-publish',
    })
  })

  it('publishes the items beforePublish returns and reports them to afterPublish', async () => {
    const after: PublishHookResult[] = []
    const hooks = new HookRegistry()
    hooks.register('beforePublish', async (_target, items) => items.filter(i => i.name !== 'footer'), {
      name: 'drop-footer',
    })
    hooks.register(
      'afterPublish',
      async (_target, result) => {
        after.push(result)
      },
      { name: 'record' },
    )
    hooks.seal()
    const { app, targetStorage } = build({ hooks })

    const res = await stream(app, { items: ['fragments/header', 'fragments/footer'], targets: ['staging'] })
    expect(res.status).toBe(200)
    await res.text()

    expect(await targetStorage.exists('fragments/header/fragment.json')).toBe(true)
    expect(await targetStorage.exists('fragments/footer/fragment.json')).toBe(false)
    expect(after).toHaveLength(1)
    expect(after[0].target).toBe('staging')
    expect(after[0].itemsPublished.map(i => i.path)).toEqual(['fragments/header'])
    expect(after[0].itemsFailed).toEqual([])
    const recorded = await publishEvents(app)
    expect(recorded[0].metadata).toMatchObject({ items: ['fragments/header'] })
  })

  it('reports every item as failed to afterPublish when the target fails', async () => {
    const after: PublishHookResult[] = []
    const hooks = new HookRegistry()
    hooks.register(
      'afterPublish',
      async (_target, result) => {
        after.push(result)
      },
      { name: 'record' },
    )
    hooks.seal()
    const { app } = build({ hooks, failTargetWrites: true })

    const res = await stream(app, { items: ['fragments/header'], targets: ['staging'] })
    const events = parseSse(await res.text())
    const done = events.find(e => e.event === 'done')!.data as { results: Array<{ success: boolean; error?: string }> }
    expect(done.results[0].success).toBe(false)

    expect(after).toHaveLength(1)
    expect(after[0].itemsPublished).toEqual([])
    expect(after[0].itemsFailed).toEqual([
      { item: expect.objectContaining({ path: 'fragments/header' }), reason: done.results[0].error },
    ])
  })

  it('refuses with 409 PUBLISH_AUDIT_FAILED before the stream opens when the gate finds errors', async () => {
    const { app, targetStorage } = build({ validator: alwaysFail('error') })

    const res = await stream(app, { items: ['fragments/header'], targets: ['staging'] })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      blocked: Array<{ target: string; issues: Array<{ severity: string }> }>
    }
    expect(body.code).toBe('PUBLISH_AUDIT_FAILED')
    expect(body.blocked).toEqual([{ target: 'staging', issues: [expect.objectContaining({ severity: 'error' })] }])

    expect(targetStorage.dump().size).toBe(0)
    const recorded = await publishEvents(app)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].outcome).toBe('validation-failed')
    expect(recorded[0].metadata).toMatchObject({ blockedTargets: ['staging'] })
  })

  it('lets warnings through the gate', async () => {
    const { app, targetStorage } = build({ validator: alwaysFail('warn') })
    const res = await stream(app, { items: ['fragments/header'], targets: ['staging'] })
    expect(res.status).toBe(200)
    await res.text()
    expect(await targetStorage.exists('fragments/header/fragment.json')).toBe(true)
  })

  it('streams a fatal event for an unknown target and writes nothing', async () => {
    const { app, targetStorage } = build()
    const res = await stream(app, { items: ['fragments/header'], targets: ['nowhere'] })
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    expect(events).toEqual([{ event: 'fatal', data: { kind: 'fatal', error: 'Unknown target: nowhere' } }])
    expect(targetStorage.dump().size).toBe(0)
    // A publish that never ran records no success.
    expect(await publishEvents(app)).toEqual([])
  })

  it('under strict audit, records the publish before writing and a write-failed event when it fails', async () => {
    const { app } = build({ strictAudit: true })
    const res = await stream(app, { items: ['fragments/header'], targets: ['nowhere'] })
    const events = parseSse(await res.text())
    expect(events.map(e => e.event)).toEqual(['fatal'])

    const recorded = await publishEvents(app)
    expect(recorded.map(e => e.outcome).sort()).toEqual(['success', 'write-failed'])
  })

  it('under strict audit, records one event for a publish that succeeds', async () => {
    const { app, targetStorage } = build({ strictAudit: true })
    const res = await stream(app, { items: ['fragments/header'], targets: ['staging'] })
    const events = parseSse(await res.text())
    expect(events.at(-1)!.event).toBe('done')
    expect(await targetStorage.exists('fragments/header/fragment.json')).toBe(true)

    const recorded = await publishEvents(app)
    expect(recorded.map(e => e.outcome)).toEqual(['success'])
  })
})
