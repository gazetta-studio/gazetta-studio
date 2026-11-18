/**
 * Items a beforePublish hook adds go through the same item parser as
 * request items (#1200): a hook can't route a `..` segment or an
 * unknown item into the copy.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { HookRegistry } from '../src/hooks/index.js'
import type { BeforePublishHook } from '../src/hooks/index.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function setup(added: string) {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
    'secret/fragment.json': JSON.stringify({ template: 'header-layout' }),
  })
  const hooks = new HookRegistry()
  const addItem: BeforePublishHook = async (_target, items) => [
    ...items,
    { kind: 'fragment', name: added.replace(/^fragments\//, ''), path: added },
  ]
  hooks.register('beforePublish', addItem, { name: 'add-item' })
  hooks.seal()
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site' },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: {
      local: { storage: sourceStorage, type: 'esi', environment: 'local', editable: true },
      staging: { storage: targetStorage, type: 'esi', environment: 'staging', publicStorage: false },
    },
    disableCacheStatsLogger: true,
    hooks,
  })
  return { app, targetStorage }
}

describe('beforePublish hook items are validated (#1200)', () => {
  it.each([
    ['/api/v1/publish', 'fragments/../secret', 'Invalid item'],
    ['/api/v1/publish/stream', 'fragments/../secret', 'Invalid item'],
    ['/api/v1/publish', 'fragments/missing', 'Unknown item'],
    ['/api/v1/publish/stream', 'fragments/missing', 'Unknown item'],
  ])('%s refuses a hook-added %s with 400 before copying', async (path, added, message) => {
    const { app, targetStorage } = setup(added)
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['fragments/header'], targets: ['staging'] }),
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain(message)
    expect([...targetStorage.dump().keys()]).toEqual([])
  })
})
