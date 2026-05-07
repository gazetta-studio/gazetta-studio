/**
 * Cut 9 tests: factory-contribution registration through
 * `buildHooksRegistry({ contributions })`.
 *
 * Cut 9 replaces Cut 3's file-discovery walker (deleted) with the
 * locked single registration path: site-local hooks AND
 * npm-distributed plugins both produce a `HookContribution` from a
 * factory call; both wire identically through `admin.hooks` in
 * `site.config.ts`.
 *
 * Per design-hooks.md "Registration (Q4 locked — factory
 * contributions only)":
 *
 *   - One registry; factory contributions register against it
 *   - `source` from each contribution stamps every entry's source
 *     metadata at registration time
 *   - Per-handler `options.priority` overrides the factory-band
 *     default of 100; explicit 1000 puts a contribution in the
 *     site-local band
 *   - Duplicate sources allowed (operator may invoke the same
 *     factory twice with different config)
 *   - Empty / absent contributions array yields a sealed empty
 *     registry (no overhead for sites without hooks)
 */
import { describe, expect, it } from 'vitest'
import { buildHooksRegistry } from '../src/admin-api/index.js'
import type { AfterPublishHook, BeforeSaveHook, HookContribution } from '../src/hooks/index.js'

describe('Cut 9 — factory contributions', () => {
  it('registers each entry with the contribution source', async () => {
    const beforeSave: BeforeSaveHook = async (_scope, payload) => payload
    const afterPublish: AfterPublishHook = async () => {}
    const contribution: HookContribution = {
      source: '@example/cdn-purge',
      hooks: [
        { phase: 'beforeSave', handler: beforeSave, options: { name: 'cdn-purge-on-save' } },
        { phase: 'afterPublish', handler: afterPublish, options: { name: 'cdn-purge-on-publish' } },
      ],
    }
    const registry = await buildHooksRegistry({ contributions: [contribution] })

    const beforeSaveRegs = registry.getByPhase('beforeSave')
    const afterPublishRegs = registry.getByPhase('afterPublish')
    expect(beforeSaveRegs).toHaveLength(1)
    expect(afterPublishRegs).toHaveLength(1)
    expect(beforeSaveRegs[0].source).toBe('@example/cdn-purge')
    expect(beforeSaveRegs[0].name).toBe('cdn-purge-on-save')
    expect(afterPublishRegs[0].source).toBe('@example/cdn-purge')
    expect(afterPublishRegs[0].name).toBe('cdn-purge-on-publish')
  })

  it('defaults entry priority to the factory band (100)', async () => {
    const handler: BeforeSaveHook = async (_scope, payload) => payload
    const contribution: HookContribution = {
      source: 'site-local:auto-slugify',
      hooks: [{ phase: 'beforeSave', handler, options: { name: 'auto-slugify' } }],
    }
    const registry = await buildHooksRegistry({ contributions: [contribution] })
    const [reg] = registry.getByPhase('beforeSave')
    expect(reg.priority).toBe(100)
  })

  it('honors explicit per-entry priority override (site-local band)', async () => {
    const handler: BeforeSaveHook = async (_scope, payload) => payload
    const contribution: HookContribution = {
      source: 'site-local:after-plugins',
      hooks: [{ phase: 'beforeSave', handler, options: { name: 'after-plugins', priority: 1000 } }],
    }
    const registry = await buildHooksRegistry({ contributions: [contribution] })
    const [reg] = registry.getByPhase('beforeSave')
    expect(reg.priority).toBe(1000)
  })

  it('runs contributions in priority order across multiple sources', async () => {
    const handler: BeforeSaveHook = async (_scope, payload) => payload
    const plugin: HookContribution = {
      source: '@example/plugin',
      hooks: [{ phase: 'beforeSave', handler, options: { name: 'plugin-hook' } }], // default 100
    }
    const local: HookContribution = {
      source: 'site-local:after-plugin',
      hooks: [{ phase: 'beforeSave', handler, options: { name: 'local-hook', priority: 1000 } }],
    }
    const registry = await buildHooksRegistry({ contributions: [local, plugin] })
    const order = registry.getByPhase('beforeSave').map(r => r.name)
    expect(order).toEqual(['plugin-hook', 'local-hook'])
  })

  it('allows duplicate sources (same factory invoked twice)', async () => {
    const handler: AfterPublishHook = async () => {}
    const us: HookContribution = {
      source: '@example/cdn-purge',
      hooks: [{ phase: 'afterPublish', handler, options: { name: 'cdn-purge-us' } }],
    }
    const eu: HookContribution = {
      source: '@example/cdn-purge',
      hooks: [{ phase: 'afterPublish', handler, options: { name: 'cdn-purge-eu' } }],
    }
    const registry = await buildHooksRegistry({ contributions: [us, eu] })
    const regs = registry.getByPhase('afterPublish')
    expect(regs).toHaveLength(2)
    expect(regs.map(r => r.source)).toEqual(['@example/cdn-purge', '@example/cdn-purge'])
    expect(regs.map(r => r.name)).toEqual(['cdn-purge-us', 'cdn-purge-eu'])
  })

  it('seals the registry — late registration throws', async () => {
    const handler: BeforeSaveHook = async (_scope, payload) => payload
    const contribution: HookContribution = {
      source: '@example/plugin',
      hooks: [{ phase: 'beforeSave', handler, options: { name: 'p1' } }],
    }
    const registry = await buildHooksRegistry({ contributions: [contribution] })
    expect(() => registry.register('beforeSave', handler, { name: 'late' }, '@example/late')).toThrow()
  })

  it('returns a sealed empty registry when contributions is omitted', async () => {
    const registry = await buildHooksRegistry()
    expect(registry.size()).toBe(0)
    const handler: BeforeSaveHook = async (_scope, payload) => payload
    expect(() => registry.register('beforeSave', handler, { name: 'late' })).toThrow()
  })

  it('returns a sealed empty registry when contributions is an empty array', async () => {
    const registry = await buildHooksRegistry({ contributions: [] })
    expect(registry.size()).toBe(0)
  })
})
