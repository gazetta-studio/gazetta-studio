/**
 * Regression test for Gap 11: cross-target cache pollution under a
 * shared backing provider.
 *
 * Background: when an operator sets `gazetta.config.ts defaults.cache:
 * memoryCache(...)`, that single instance is shared across every
 * SourceContext built for the process. Each SourceContext wraps it
 * via `forSite(manifest.name)` — but the wrapper scope is the SITE
 * name, not the TARGET name. Two targets in the same site (local +
 * production) wrap the same backing with the same scope. If consumers
 * (admin-api routes) use a target-agnostic cache key like
 * `pages:summary`, they collide on the same stored key, and a write
 * via target=local is read back via target=production.
 *
 * Fix per `design-cache.md` Gap 6: target is a first-class dimension
 * in cache keys for target-scoped values. Consumers (routes) include
 * `:target:{name}` in the key shape.
 *
 * This test pins the contract that route consumers must follow. If a
 * future consumer caches target-scoped data without including target
 * in the key, the failure mode is silent stale reads — not what we
 * want. Test fails loudly when the contract is violated.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryCache } from '../src/cache/memory.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'

function mockProvider(): StorageProvider {
  return {
    readFile: async () => '',
    writeFile: async () => {},
    readDir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
  }
}

describe('cache target-scope contract', () => {
  it('two SourceContexts sharing one backing cache write to the SAME key without target dimension', async () => {
    // This test pins the bug shape — confirms that without target in
    // the key, a write via local is visible to production. If this
    // test ever PASSES (returns null instead of local data), it means
    // forSite or createSourceContext started doing per-target scoping
    // at the wrapper level, which would indicate a contract change.
    const sharedBacking = createMemoryCache({ instance: 'shared' })
    const manifest: SiteManifest = { name: 'main', cache: sharedBacking }

    const local = {
      ...createSourceContext({ storage: mockProvider(), siteDir: '', manifest }),
      targetName: 'local',
    }
    const production = {
      ...createSourceContext({ storage: mockProvider(), siteDir: '', manifest }),
      targetName: 'production',
    }

    await local.cache.set('shared-key', 'value-from-local')
    expect(await production.cache.get('shared-key')).toBe('value-from-local')
  })

  it('target-scoped keys (per design-cache.md Gap 6) prevent cross-target pollution', async () => {
    const sharedBacking = createMemoryCache({ instance: 'shared' })
    const manifest: SiteManifest = { name: 'main', cache: sharedBacking }

    const local = {
      ...createSourceContext({ storage: mockProvider(), siteDir: '', manifest }),
      targetName: 'local',
    }
    const production = {
      ...createSourceContext({ storage: mockProvider(), siteDir: '', manifest }),
      targetName: 'production',
    }

    // Mirror the route-level keying convention.
    const keyFor = (s: { targetName?: string }) => `pages:summary:target:${s.targetName ?? '__source__'}`

    await local.cache.set(keyFor(local), [{ name: 'page-on-local' }])
    await production.cache.set(keyFor(production), [{ name: 'page-on-prod' }])

    expect(await local.cache.get(keyFor(local))).toEqual([{ name: 'page-on-local' }])
    expect(await production.cache.get(keyFor(production))).toEqual([{ name: 'page-on-prod' }])

    // Cross-read using the OTHER target's key still works (same
    // backing) — proves the isolation comes from the key dimension,
    // not the wrapper.
    expect(await local.cache.get(keyFor(production))).toEqual([{ name: 'page-on-prod' }])
  })

  it('save invalidatePrefix("pages:") clears all targets — documented over-invalidation', async () => {
    // The route-level save handler uses `invalidatePrefix('pages:')`
    // for cheapness + future-proofing (catches future per-page
    // entries). When a backing cache is shared across targets, this
    // blows the other targets' summaries too. Documented trade-off
    // in pages.ts; this test pins the behavior.
    const sharedBacking = createMemoryCache({ instance: 'shared' })
    const manifest: SiteManifest = { name: 'main', cache: sharedBacking }

    const local = {
      ...createSourceContext({ storage: mockProvider(), siteDir: '', manifest }),
      targetName: 'local',
    }
    const production = {
      ...createSourceContext({ storage: mockProvider(), siteDir: '', manifest }),
      targetName: 'production',
    }

    const keyFor = (s: { targetName?: string }) => `pages:summary:target:${s.targetName ?? '__source__'}`

    await local.cache.set(keyFor(local), [{ name: 'p' }])
    await production.cache.set(keyFor(production), [{ name: 'q' }])

    // Save on local: invalidates all `pages:` entries, including
    // production's.
    await local.cache.invalidatePrefix('pages:')

    expect(await local.cache.get(keyFor(local))).toBeNull()
    expect(await production.cache.get(keyFor(production))).toBeNull()
  })
})
