/**
 * Mutation-coverage tests for `src/admin-api/routes/publish.ts` — closes
 * the gap reported on issue #564. Targets two NoCoverage clusters in
 * `publishRoutes()` that today's tests don't exercise:
 *
 *   1. `getTargets` lazy-init lifecycle (lines 151-170) — exercises both
 *      the empty-`targetConfigs` short-circuit AND the first-call
 *      `!initPromise` branch. Today's tests all pass `preInitTargets`,
 *      so `targets` is non-null at line 152 and neither branch is hit.
 *   2. `ensureFragmentDepsIndex` (lines 183-205) — the in-flight-memoization
 *      helper that backfills `.gazetta/fragment-deps/` on first
 *      `/api/dependents` lookup. Exercised end-to-end against a fresh
 *      source with fragment refs but no pre-populated index; both the
 *      response shape AND the side-effect sidecar write pin the
 *      contract.
 *
 * The third cluster reported on #564 — line 123's `items.length === 0`
 * early-return inside `evaluatePublishGate` — is NOT covered here. That
 * branch is a load-bearing performance optimization (skips
 * `loadSiteFromSource` for asset-only publishes) but mutating it to
 * `if (false)` produces no observable behavior change because
 * `runPublishAudit`'s own length check (publish-audit.ts:63) short-
 * circuits on the same empty input. Stryker reports it as Survived; from
 * the route surface it's an equivalent mutation. A test that pinned
 * the optimization would have to spy on `loadSiteFromSource` — invasive
 * for a test contract whose only payoff is mutation-score cosmetics.
 *
 * Per [team-preferences.md rule 31](.claude/rules/team-preferences.md):
 * API-first tier for the admin-api surface; mutation testing is the
 * discovery tool, route handlers are the test subject.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

interface BuildOpts {
  /** Pre-seeded source storage. When omitted, a fresh empty one is used. */
  sourceStorage?: MemoryStorage
  /**
   * When true, populate `targetConfigs` with `local` + `staging` configs.
   * Omit to exercise the empty-config short-circuit (publish.ts:153).
   */
  withTargetConfigs?: boolean
}

function buildApp(opts: BuildOpts = {}): { app: Hono; sourceStorage: MemoryStorage } {
  const sourceStorage = opts.sourceStorage ?? memoryStorage()
  const stagingStorage = memoryStorage()

  const targetConfigs = opts.withTargetConfigs
    ? {
        local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
        staging: { storage: stagingStorage, type: 'esi' as const, environment: 'staging' as const },
      }
    : undefined

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', ...(targetConfigs ? { targets: targetConfigs } : {}) },
  })

  // Critically, `targets` (preInitTargets) is NOT passed — that's what
  // forces `getTargets` down the lazy-init path (line 157) instead of
  // short-circuiting at line 152. Today's `admin-api-publish-categorization`
  // suite passes preInitTargets, leaving the lazy-init branch NoCoverage.
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    ...(targetConfigs ? { targetConfigs } : {}),
    disableCacheStatsLogger: true,
  })

  return { app, sourceStorage }
}

describe('publish route — getTargets lazy initialization (covers publish.ts:151-170)', () => {
  it('returns an empty target list when no targetConfigs are configured', async () => {
    // Exercises the `!targetConfigs` branch on line 153. Today's
    // tests all pass `preInitTargets` so `targets` is non-null at
    // line 152 and the branch is NoCoverage. Without preInitTargets
    // AND without targetConfigs, line 153 short-circuits with an
    // empty Map.
    //
    // Pre-flight injection check: mutating line 153 to `false`
    // still produces `[]` from the route because the lazy-init IIFE
    // crashes on `createTargetRegistry(undefined)` and the surrounding
    // `.catch()` rescues to an empty Map. The line-153 ConditionalExpression
    // mutation is behaviorally equivalent in this configuration; the
    // test still pins the visible contract ("no configs → empty list")
    // so a future refactor that removes the catch fallback can't
    // silently break the empty-config UX.
    const { app } = buildApp({})

    const res = await app.request('/api/targets')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<unknown>
    expect(body).toEqual([])
  })

  it('lazily initializes target providers from configs when no preInitTargets are supplied', async () => {
    // Exercises lines 157-167 — the IIFE that imports + invokes
    // `createTargetRegistry` on first call. Verified mutation kills
    // before commit:
    //
    //   Line 153 `=== 0` → `!== 0`: with non-empty configs, the
    //     mutated condition is true → line 153 short-circuits with
    //     empty Map → `/api/targets` returns `[]` → THIS test fails
    //     (expected ['local', 'staging']).
    //
    //   Lines 158-167 BlockStatement `{}`: IIFE body becomes empty;
    //     `targets` never gets set; the unresolved promise resolves
    //     to undefined; `t.keys()` throws → `/api/targets` returns
    //     500 → test fails.
    const { app } = buildApp({ withTargetConfigs: true })

    const res = await app.request('/api/targets')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map(t => t.name).sort()).toEqual(['local', 'staging'])
  })
})

describe('publish route — ensureFragmentDepsIndex backfill (covers publish.ts:183-205)', () => {
  it('GET /api/dependents on a fresh source rebuilds the fragment-deps index and resolves dependents', async () => {
    // Exercises the full `ensureFragmentDepsIndex` body — a fresh
    // source with NO `.gazetta/fragment-deps/` directory forces the
    // existence probe at line 192 to return false, then the rebuild
    // runs via `rebuildDepIndex`. Verified mutation kill: replacing
    // the function body with `{}` causes the rebuild to no-op, the
    // sidecar never gets written, and `findDependentsFromSidecars`
    // returns `{ pages: [], fragments: [] }` — both assertions below
    // fail under the mutation.
    const sourceStorage = memoryStorage()
    sourceStorage.seed({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        route: '/',
        content: {},
        components: ['@header'],
      }),
      'fragments/header/fragment.json': JSON.stringify({
        template: 'header-layout',
        content: {},
      }),
    })

    const { app } = buildApp({ sourceStorage, withTargetConfigs: true })

    const res = await app.request('/api/dependents?item=fragments/header')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { pages: string[]; fragments: string[] }
    expect(body.pages).toEqual(['home'])
    expect(body.fragments).toEqual([])

    // Side-effect verification: the rebuild wrote the per-edge
    // sidecar to storage. Pins the contract independently from
    // `findDependentsFromSidecars`'s own correctness (which is
    // tested elsewhere); the route-level assertion above could in
    // theory pass via a hypothetical short-cut, but the on-disk
    // sidecar can only exist if `rebuildDepIndex` actually ran.
    const sidecarExists = await sourceStorage.exists('.gazetta/fragment-deps/header/pages.home')
    expect(sidecarExists).toBe(true)
  })

  it('GET /api/dependents resolves transitive dependents via fragment-deps backfill', async () => {
    // Covers the BFS path through `findDependentsFromSidecars` after
    // `ensureFragmentDepsIndex` completes: `@inner` referenced by
    // `@outer` referenced by `pages/home` should surface home +
    // outer when querying `@inner`. Same mutation surface as the
    // direct-reference test above (function-body `{}` mutation
    // breaks both); this exercises the multi-hop branch.
    const sourceStorage = memoryStorage()
    sourceStorage.seed({
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        route: '/',
        content: {},
        components: ['@outer'],
      }),
      'fragments/outer/fragment.json': JSON.stringify({
        template: 'wrapper',
        content: {},
        components: ['@inner'],
      }),
      'fragments/inner/fragment.json': JSON.stringify({
        template: 'leaf',
        content: {},
      }),
    })

    const { app } = buildApp({ sourceStorage, withTargetConfigs: true })

    const res = await app.request('/api/dependents?item=fragments/inner')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { pages: string[]; fragments: string[] }
    expect(body.pages).toEqual(['home'])
    expect(body.fragments).toEqual(['outer'])
  })

  it('GET /api/dependents 400s when the item query is missing or invalid', async () => {
    // Pins the route-handler input validation at publish.ts:265-267
    // — explicitly NOT one of #564's reported clusters, but it's the
    // entry-point guard before `ensureFragmentDepsIndex` runs. Locks
    // the failure-mode contract so the success-path tests above have
    // a documented counterpart.
    const { app } = buildApp({ withTargetConfigs: true })

    const missing = await app.request('/api/dependents')
    expect(missing.status).toBe(400)

    const invalid = await app.request('/api/dependents?item=pages/home')
    expect(invalid.status).toBe(400)
  })
})
