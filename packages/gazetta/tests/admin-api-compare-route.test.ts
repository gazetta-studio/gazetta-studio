/**
 * GET /api/v1/compare: the route's target lookup and its serialization of
 * `compareTargets`. Fragments rendered with the starter's templates; a
 * publish puts them on the target, then the source changes.
 *
 * Each test builds fresh `memoryStorage()` source and target (rule 26).
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { compareTargets } from '../src/compare.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function build(): {
  app: Hono
  source: MemoryStorage
  staging: MemoryStorage
  ctx: ReturnType<typeof createSourceContext>
} {
  const source = memoryStorage()
  source.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout' }),
  })
  const staging = memoryStorage()
  const targetConfigs = {
    local: { storage: source, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: { storage: staging, publicStorage: false, type: 'esi' as const, environment: 'staging' as const },
  }
  const ctx = createSourceContext({
    storage: source,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'compare-site', targets: targetConfigs },
  })
  const app = createAdminApp({
    source: ctx,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', source],
      ['staging', staging],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, source, staging, ctx }
}

async function publish(app: Hono, items: string[]): Promise<void> {
  const res = await app.request('/api/v1/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, targets: ['staging'] }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

describe('GET /api/v1/compare', { timeout: 30_000 }, () => {
  it('lists every source item as added against a target never published to', async () => {
    const { app } = build()
    const res = await app.request('/api/v1/compare?target=staging')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ modified: [], deleted: [], unchanged: [], firstPublish: true })
    expect([...(body.added as string[])].sort()).toEqual(['fragments/footer', 'fragments/header'])
  })

  it('returns added, modified, unchanged and deleted items as compareTargets returns them', async () => {
    const { app, source, staging, ctx } = build()
    await publish(app, ['fragments/header', 'fragments/footer'])
    // header changes, footer is deleted from the source, banner is new.
    await source.writeFile(
      'fragments/header/fragment.json',
      JSON.stringify({ template: 'header-layout', content: { title: 'changed' } }),
    )
    await source.rm('fragments/footer/fragment.json')
    await source.writeFile('fragments/banner/fragment.json', JSON.stringify({ template: 'footer-layout' }))
    await publish(app, ['fragments/banner'])
    await source.writeFile('fragments/promo/fragment.json', JSON.stringify({ template: 'footer-layout' }))

    const res = await app.request('/api/v1/compare?target=staging')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      added: ['fragments/promo'],
      modified: ['fragments/header'],
      deleted: ['fragments/footer'],
      unchanged: ['fragments/banner'],
      firstPublish: false,
    })

    const direct = await compareTargets({
      sourceRoot: ctx.contentRoot,
      target: staging,
      templatesDir: starterTemplatesDir,
      projectRoot: '/test-project',
      type: 'esi',
      manifest: ctx.manifest,
    })
    expect(body).toEqual(JSON.parse(JSON.stringify(direct)))
  })

  it('answers 400 for an unknown target', async () => {
    const { app } = build()
    const res = await app.request('/api/v1/compare?target=nowhere')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST', detail: 'Unknown target: nowhere' })
  })

  it('answers 400 when no target is named', async () => {
    const { app } = build()
    const res = await app.request('/api/v1/compare')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST', detail: 'Missing "target" query parameter' })
  })
})
