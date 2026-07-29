/**
 * Mutation-coverage tests for `admin-api/index.ts` — closes gaps
 * surviving after the earlier `admin-api-index-mutation-coverage.test.ts`
 * cycles (issues #311, #567, #676). This file focuses on three clusters
 * the earlier suite doesn't exercise:
 *
 * Cluster 3 — `createAdminApp` bootstrap-source validation (line 254):
 *   - StringLiteral NoCoverage: throw new Error('createAdminApp: either
 *     `source` or `storage` must be provided') → `""`
 *   The error path was uncovered — no test constructs createAdminApp
 *   with neither `source` nor `storage`. Under the mutant, the throw
 *   still fires but with an empty message; assertion on message text
 *   kills the mutant.
 *
 * Cluster 4 — resolver selection based on `targetConfigs` (line 280):
 *   - ConditionalExpression `opts.targetConfigs && Object.keys(opts.targetConfigs).length > 0`
 *     mutated to `true`, `>= 0`, `<= 0`
 *   The three mutants all survived because tests exercised only the
 *   non-empty targetConfigs path (registry resolver) — the empty /
 *   absent path (static resolver) wasn't covered as a behavioral
 *   choice. Static resolver returns the bootstrap source regardless
 *   of `?target=` query; registry resolver honors the query and
 *   throws for unknown targets. These behaviors distinguish the
 *   original from all three mutants.
 *
 * Cluster 5 — cached scan reuse (line 237):
 *   - ConditionalExpression `tDir === templatesDir ? cachedScan.get() : scanTemplates(tDir, root)`
 *     mutated to `false` (always fresh) and `!==` (swapped predicate)
 *   Both mutants make scan skip the cache and call scanTemplates
 *   fresh every time. Two successive `/api/compare` requests should
 *   invoke scanTemplates exactly ONCE under the original; mutants
 *   would call it twice. The `true` mutant is structurally
 *   equivalent under the current HTTP surface (all callers use the
 *   matching branch) so it isn't killable without exposing the scan
 *   closure directly — documented as a known equivalent-mutant hole.
 *
 * Cluster 6 — lazyInit fall-through when config is missing (line 296):
 *   - ConditionalExpression `if (!config) return` mutated to `false`
 *   Under original, when the registry lists a target whose config
 *   is missing from `opts.targetConfigs` (e.g., mutated after admin
 *   boot), lazyInit silently returns; the request then fails cleanly
 *   at `registry.get(name)` with an UnknownTargetError. Under the
 *   mutant, the guard is skipped and `const storage = config.storage`
 *   throws a TypeError. Behavioural difference: registry.get vs
 *   TypeError.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` and a fresh `createAdminApp`. No module-level
 * state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { scanTemplates as mockableScanTemplates } from '../src/templates-scan.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import type { TargetConfig } from '../src/types.js'

vi.mock('../src/templates-scan.js', async () => {
  const actual = await vi.importActual<typeof import('../src/templates-scan.js')>('../src/templates-scan.js')
  return {
    ...actual,
    scanTemplates: vi.fn(async () => []),
  }
})

beforeEach(() => {
  vi.mocked(mockableScanTemplates).mockClear()
  vi.mocked(mockableScanTemplates).mockResolvedValue([])
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Cluster 3 — bootstrap validation (line 254 StringLiteral)', () => {
  it('throws with a descriptive message when neither `source` nor `storage` is supplied', () => {
    // Under the mutant `"": the throw still fires but the message is
    // empty. Assertion on message CONTENT kills the mutant — an
    // `expect.toThrow()` alone without a message matcher would pass
    // for both.
    expect(() =>
      createAdminApp({
        siteDir: '/tmp/does-not-matter',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).toThrow(/either `source` or `storage` must be provided/)
  })

  it('does not throw when only `storage` is supplied (regression: message check fires only on the true branch)', () => {
    // Belt-and-suspenders: the throw guards a specific missing-input
    // condition. If someone accidentally widened the guard (e.g. to
    // require BOTH), this test surfaces it.
    const storage = memoryStorage()
    expect(() =>
      createAdminApp({
        storage,
        siteDir: '/tmp/does-not-matter',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).not.toThrow()
  })
})

describe('Cluster 4 — resolver selection (line 280 ConditionalExpression)', () => {
  // Under the original condition
  //   `opts.targetConfigs && Object.keys(opts.targetConfigs).length > 0`
  // the resolver is registry-backed when there's at least one
  // configured target, static otherwise.
  //
  // Static resolver returns the bootstrap source regardless of
  // `?target=` — a request for any target succeeds (route sees the
  // bootstrap source).
  //
  // Registry resolver honors `?target=<name>`: unknown names surface
  // as an UnknownTargetError from `registry.get`, which the route's
  // outermost handler surfaces as a 500 (no route-level catch for
  // this class of error today).

  function setup(opts: {
    targetConfigs?: Record<string, TargetConfig>
    preInitTargets?: Map<string, import('../src/types.js').StorageProvider>
  }): { app: Hono } {
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    })
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: opts.targetConfigs ?? {} },
    })
    const app = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targets: opts.preInitTargets,
      targetConfigs: opts.targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })
    return { app }
  }

  it('uses staticSourceResolver when targetConfigs is absent — any `?target=` returns the bootstrap source', async () => {
    // Static resolver is the base case. Under mutants `true` or
    // `>= 0` (always take the registry branch), the resolver would
    // instead try to build a registry from an empty/absent config —
    // `defaultEditable()` throws NoEditableTargetError and the
    // response is 500 (or a thrown error), not 200.
    const { app } = setup({ targetConfigs: undefined })

    const res = await app.request('/api/pages?target=any-name-whatsoever')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map(p => p.name)).toContain('home')
  })

  it('uses staticSourceResolver when targetConfigs is an empty object — same behavior as absent', async () => {
    // Kills `true` (always registry) — empty registry would throw at
    // resolve time. Also kills `>= 0` for the same reason.
    const { app } = setup({ targetConfigs: {} })

    const res = await app.request('/api/pages?target=any-name-whatsoever')
    expect(res.status).toBe(200)
  })

  it('uses registrySourceResolver when targetConfigs has entries — unknown `?target=` surfaces the registry error', async () => {
    // Kills `<= 0` (always static) — with non-empty configs the
    // mutant would take the static branch, returning the bootstrap
    // source for any target name and yielding a 200. Under the
    // original registry path, an unknown target name surfaces as an
    // UnknownTargetError which Hono returns as a non-200 error
    // response.
    const storage = memoryStorage()
    const targetConfigs = {
      known: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const { app } = setup({
      targetConfigs,
      preInitTargets: new Map([['known', storage]]),
    })

    const res = await app.request('/api/pages?target=totally-unknown-target')
    // Registry path: UnknownTargetError. Under the mutant taking
    // static: 200 with the bootstrap source. Any non-200 outcome
    // kills the mutant.
    expect(res.status).not.toBe(200)
  })

  it('uses registrySourceResolver when targetConfigs has entries — known `?target=` resolves normally', async () => {
    // Positive companion to the previous: registry path succeeds for
    // configured targets. Guards the resolver-selection choice
    // without depending on error-path behavior alone.
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    })
    const targetConfigs = {
      known: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const { app } = setup({
      targetConfigs,
      preInitTargets: new Map([['known', storage]]),
    })

    const res = await app.request('/api/pages?target=known')
    expect(res.status).toBe(200)
  })
})

describe('Cluster 5 — cached scan reuse (line 237 ConditionalExpression)', () => {
  it('repeated `/api/compare` requests share one cached scanTemplates call', async () => {
    // scan closure: `tDir === templatesDir ? cachedScan.get() : scanTemplates(tDir, root)`.
    // Two successive compare calls that both pass tDir === templatesDir
    // should invoke the underlying scanTemplates exactly ONCE — the
    // cached scan's memoization returns the same Promise on the second
    // call.
    //
    // Under mutants `false` (always take else) or `!==` (swapped
    // predicate → matching path takes else): each call runs
    // scanTemplates fresh → call count grows with request count.
    //
    // The `true` mutant is equivalent to the original under the
    // current HTTP surface (every scan invocation has tDir ===
    // templatesDir), so it can't be killed here — documented at file
    // header.
    const storage = memoryStorage()
    const targetConfigs = {
      local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: targetConfigs },
    })
    const app = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targets: new Map([['local', storage]]),
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // Two successive compare requests. Each triggers `scan(templatesDir, projectRoot)`
    // where tDir === templatesDir → cachedScan.get() → first call
    // invokes scanTemplates, subsequent calls return the memoized
    // Promise.
    await app.request('/api/compare?target=local')
    await app.request('/api/compare?target=local')

    // The mocked scanTemplates may be invoked in other flows on boot
    // (none today, but be defensive). Count only calls matching the
    // signature we care about — (templatesDir, projectRoot) — from
    // the cached scan.
    const matchingCalls = vi
      .mocked(mockableScanTemplates)
      .mock.calls.filter(([tDir, root]) => tDir === '/test-project/templates' && root === '/test-project')
    // Original: exactly 1. Mutants `false` / `!==`: 2.
    expect(matchingCalls).toHaveLength(1)
  })
})

describe('Cluster 6 — lazyInit fall-through when config is missing (line 296 ConditionalExpression)', () => {
  it('silently skips lazyInit when opts.targetConfigs[name] is undefined; registry surfaces UnknownTargetError', async () => {
    // Scenario: createTargetRegistryView snapshots Object.keys(configs)
    // at construction. If the config object is mutated to drop a key
    // AFTER admin construction, registry.list() still includes the
    // dropped key (snapshot) but providers.get(name) returns
    // undefined → registry.get(name) throws UnknownTargetError →
    // lazyInit is called → lazyInit reads opts.targetConfigs![name]
    // which is now undefined → `if (!config) return` short-circuits.
    // Then registry.get is called again by the outer
    // createSourceContextFromRegistry → throws UnknownTargetError,
    // surfaced to the client.
    //
    // Under the mutant `if (false) return`: the guard is skipped,
    // `const storage = config.storage` throws a TypeError (cannot
    // read properties of undefined). Node's default handler produces
    // a different error shape.
    //
    // Behavioral discriminator: the CLASS of error surfaced. Under
    // the original, the resolver eventually throws
    // UnknownTargetError (from createSourceContextFromRegistry's
    // second registry.get call); under the mutant, an uncaught
    // TypeError leaks out of lazyInit itself. We expose the class
    // via app.onError capture — Hono's default 500 body strips it.
    const storage = memoryStorage()
    const targetConfigs: Record<string, TargetConfig> = {
      ghost: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: targetConfigs },
    })
    const app = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      // opts.targets DELIBERATELY omits 'ghost' so registry.get
      // throws → resolver enters the lazyInit branch.
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // Install an error trap that surfaces the thrown error's class
    // in the response body. Discriminates
    //   original → UnknownTargetError
    //   mutant   → TypeError
    // without depending on Hono's default 500-body content.
    app.onError((err, c) => c.json({ errorName: err.name, errorMessage: err.message }, 500))

    // Mutate targetConfigs to drop 'ghost' AFTER createAdminApp
    // captured the reference. registry.list() still snapshots
    // ['ghost'] (createTargetRegistryView caches Object.keys at
    // construction), so isConfigured=true still fires → lazyInit
    // runs → opts.targetConfigs['ghost'] is now undefined →
    // `if (!config) return`.
    delete targetConfigs.ghost

    const res = await app.request('/api/pages?target=ghost')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { errorName: string; errorMessage: string }

    // Original: the lazyInit guard fires silently; the next
    // registry.get inside createSourceContextFromRegistry throws
    // UnknownTargetError. Mutant `if (false)`: lazyInit itself
    // throws TypeError before reaching that path.
    expect(body.errorName).toBe('UnknownTargetError')
    expect(body.errorMessage).toMatch(/ghost/)
  })
})
