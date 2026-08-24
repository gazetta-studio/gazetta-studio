/**
 * Mutation-coverage backfill for `GET /api/fragments` per issue #738.
 * mutation-watcher reported 68 actionable mutants surviving in
 * `admin-api/routes/fragments.ts` at kill-ratio 40%. The surviving
 * mutants cluster around two behaviors the existing test suite doesn't
 * assert on:
 *
 * 1. Cache-key composition (lines 36, 41, 44) — no test verifies the
 *    specific cache key `fragments:summary:target:${targetKey}` gets
 *    populated, or that the cache-hit branch short-circuits recomputation.
 * 2. Error catch branch (lines 59-63) — no test triggers the `loadSite:`
 *    error path that returns an empty array with 200, and no test
 *    verifies non-loadSite errors propagate as 500.
 *
 * Each test below pins one contract with an assertion that would fail
 * under a specific mutant, so the next mutation-testing run kills them.
 *
 * Per `testing-plan.md` rule 26 (test-isolation paranoia): each test gets
 * a fresh `memoryStorage()` + fresh `createAdminApp` so cache state,
 * source manifest, and any error-injecting stubs don't leak between tests.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { AdminCache, InvalidationEvent, CacheStats } from '../src/cache/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const SITE_NAME = 'fragments-mutation-test'

const seedFragment = {
  'fragments/alpha/fragment.json': JSON.stringify({ template: 'footer-layout', content: {} }),
  'fragments/beta/fragment.json': JSON.stringify({ template: 'footer-layout', content: {} }),
}

function makeApp(opts: { source?: ReturnType<typeof createSourceContext> } = {}) {
  const storage = memoryStorage()
  storage.seed(seedFragment)
  const source =
    opts.source ??
    createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: SITE_NAME,
        targets: { local: { storage, type: 'esi', environment: 'local', editable: true } },
      },
    })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    disableCacheStatsLogger: true,
  }) as unknown as Hono
  return { app, source, storage }
}

describe('GET /api/fragments — cache-key composition (#738 mutants: lines 36/41/44)', () => {
  it('populates cache under the exact key "fragments:summary:target:__source__"', async () => {
    // Kills line 41 LogicalOperator (`targetName && '__source__'` would
    // resolve to undefined when targetName is unset → key becomes
    // `...:target:undefined`) AND line 41 StringLiteral (fallback = ""
    // would produce `...:target:`). Also kills line 44 ConditionalExpression
    // if mutated to `if (true)` — the route would return `c.json(null)`
    // on the first call because `cached` starts as null.
    //
    // Static resolver (no targetName set), so the route's `??` fallback
    // must resolve to the literal '__source__'.
    const { app, source } = makeApp()

    // Precondition: cache is empty before first GET.
    expect(await source.cache.get('fragments:summary:target:__source__')).toBeNull()

    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map(f => f.name).sort()).toEqual(['alpha', 'beta'])

    // Postcondition: the specific literal cache key exists AND holds
    // the response payload. If the key composition changed (e.g., no
    // fallback → `undefined`, empty fallback → `''`), this lookup misses.
    const cached = await source.cache.get<Array<{ name: string }>>('fragments:summary:target:__source__')
    expect(cached).not.toBeNull()
    expect(cached).toEqual(body)
  })

  it('serves cached payload verbatim on the second request (kills line 44 ConditionalExpression → false)', async () => {
    // Kills line 44 `if (cached) return c.json(cached)` mutated to
    // `if (false)`. Under the mutant the branch never fires; the route
    // ALWAYS recomputes from storage. To detect this without a spy on
    // loadSite: pre-populate the cache with a distinctive payload BEFORE
    // the first GET; if the cache-hit branch is honored, the response
    // is the distinctive payload; if the mutant skips the branch, the
    // response is the real fragment list computed from storage.
    const { app, source } = makeApp()

    // Distinctive payload that could not appear from a fresh loadSite —
    // the storage seeds `alpha` and `beta`; `distinctive-only-in-cache`
    // is not on disk.
    const distinctive = [{ name: 'distinctive-only-in-cache', template: 'footer-layout' }]
    await source.cache.set('fragments:summary:target:__source__', distinctive)

    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>

    // Cache-hit branch honored → body IS the distinctive payload.
    // Mutant `if (false)` → body would be the real fragment list from
    // storage (`alpha` + `beta`), which contains neither
    // `distinctive-only-in-cache`.
    expect(body).toHaveLength(1)
    expect(body[0]?.name).toBe('distinctive-only-in-cache')
  })
})

describe('GET /api/fragments — loadSite: error swallowing (#738 mutants: lines 59-63/61)', () => {
  it('returns 200 with empty array when loadSiteFromSource throws with "loadSite:" prefix', async () => {
    // Kills the BlockStatement mutation (`{}` empty catch) → the throw
    // would propagate → Hono returns 500 instead of 200.
    // Kills line 61 ConditionalExpression → false (never matches; always
    // rethrows) → returns 500 instead of 200.
    // Kills line 61 StringLiteral → "" would match everything so this
    // path stays [] with 200 (this test alone doesn't tell the "" mutant
    // apart from real code; the sibling test below covers "" via a
    // non-loadSite error path).
    //
    // Setup: source WITHOUT `manifest` → `loadSiteFromSource` calls
    // `loadSite({ manifest: undefined, config: undefined })` which throws
    // `loadSite: either `config` or `manifest` must be provided`.
    const storage = memoryStorage()
    storage.seed(seedFragment)
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      siteName: SITE_NAME,
      // no `manifest`
    })
    const { app } = makeApp({ source })

    const res = await app.request('/api/fragments')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('propagates non-"loadSite:" errors (kills line 61 ConditionalExpression → true AND StringLiteral → "")', async () => {
    // Kills line 61 ConditionalExpression → true (any error becomes [])
    // and line 61 StringLiteral → "" (`msg.includes("")` returns true
    // for every message → every error path returns []). Under either
    // mutant, this cache error would silently become 200 [] instead
    // of propagating.
    //
    // Setup: inject a cache whose `get` throws with a message that
    // does NOT include the "loadSite:" marker. The route hits the
    // catch, checks `msg.includes('loadSite:')`, finds no match, and
    // rethrows → Hono's default error handler returns 500.
    const storage = memoryStorage()
    storage.seed(seedFragment)
    const throwingCache: AdminCache = {
      async get<T>(_key: string): Promise<T | null> {
        throw new Error('cache-provider unavailable: connection reset')
      },
      async set<T>(_key: string, _value: T): Promise<void> {
        // never reached; get throws first
      },
      async invalidate(_key: string): Promise<void> {},
      async invalidatePrefix(_prefix: string): Promise<number> {
        return 0
      },
      subscribe(_handler: (event: InvalidationEvent) => void): () => void {
        return () => {}
      },
      async stats(): Promise<CacheStats> {
        return { hits: 0, misses: 0, size: 0 }
      },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: SITE_NAME,
        targets: { local: { storage, type: 'esi', environment: 'local', editable: true } },
      },
      cache: throwingCache,
    })
    const { app } = makeApp({ source })

    const res = await app.request('/api/fragments')
    // Non-loadSite error must NOT become 200 []. Real code rethrows →
    // Hono returns 500. Both mutants (true / "") would turn this into
    // 200 with `[]` and fail this assertion.
    expect(res.status).toBe(500)
  })
})
