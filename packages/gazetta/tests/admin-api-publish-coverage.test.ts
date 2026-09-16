/**
 * Mutation-coverage tests for `src/admin-api/routes/publish.ts`.
 *
 * Cycle history: this file has recurred 5 times — #307 → #564 → #638 →
 * #703 → #712 → this cycle (#798). The #712 fix landed against a
 * different file (`src/publish.ts`, not this route file); prior work
 * on THIS file was #564's a9d2ce0 covering `getTargets` lazy-init +
 * initial `ensureFragmentDepsIndex` backfill.
 *
 * This cycle adds three tests pinning the branches Stryker still
 * flags on `ensureFragmentDepsIndex`:
 *
 *   1. Line 185 (`if (p) return p` — in-flight memoization). Prior
 *      tests exercise the first call (populates the memo) but never
 *      the second call that reuses it. Killed here by deleting the
 *      sidecar directory after the first call and asserting that the
 *      second call does NOT re-materialize it (mutation bypasses the
 *      memo, runs rebuild, and the sidecar reappears).
 *   2. Line 192 (`if (exists) return` — exists-early-return). Prior
 *      tests always run against a fresh source where the probe
 *      returns false. Killed here by pre-seeding a synthetic sidecar
 *      under `.gazetta/fragment-deps/`; the probe finds the directory,
 *      early-returns honor it, the synthetic survives. Mutation runs
 *      rebuild which wipes the whole subtree (per publish-rendered.ts
 *      line 478's `rm` before rebuild) and re-derives from actual
 *      manifests. Same test also kills the `'.gazetta'` → `""`
 *      StringLiteral mutation on line 187, because the mis-probed
 *      `fragment-deps` path (without the `.gazetta` prefix) doesn't
 *      exist under the seeded state, so exists returns false and
 *      rebuild runs.
 *   3. Line 187 `'fragment-deps'` → `""` StringLiteral. The prior
 *      tests seed neither `.gazetta` nor `.gazetta/fragment-deps`, so
 *      both the intact probe and the mutated `.gazetta`-only probe
 *      return false and rebuild runs either way. Killed here by
 *      seeding a `.gazetta/history/` sibling: the mutated `.gazetta`
 *      probe now false-positives (any prefix under `.gazetta/` satisfies
 *      exists), early-returns fire, and the fragment-deps sidecar is
 *      never written.
 *
 * Documented equivalents (surviving but unkillable through the route
 * surface without invasive spying):
 *
 *   - Line 123's `items.length === 0` early-return inside
 *     `evaluatePublishGate` — `runPublishAudit`'s own length check
 *     (publish-audit.ts:63) short-circuits on the same empty input.
 *   - Line 153's `ConditionalExpression → false` — with non-empty
 *     configs the condition is already false; with empty configs the
 *     mutated code falls through to `createTargetRegistry(undefined)`
 *     which the surrounding `.catch()` rescues to an empty Map. Both
 *     outcomes are `[]`.
 *   - Line 157's `ConditionalExpression → true` — makes concurrent
 *     `getTargets()` callers each construct their own registry
 *     promise. Idempotent; both eventually populate the same
 *     `targets` map. Detecting the extra call requires spying on
 *     `createTargetRegistry`, which is dynamically imported.
 *   - Line 183's `'__source__'` → `""` StringLiteral — both are
 *     valid `Map<string, Promise<void>>` keys. Observable divergence
 *     would require two source contexts whose targetNames collide
 *     under one variant and diverge under the other (undefined vs
 *     empty string); route surface has no natural path to construct
 *     that collision.
 *   - Line 187's `'fragment-deps'` → `""` StringLiteral in test
 *     configurations where nothing exists under `.gazetta/` (M2 is
 *     equivalent to unmutated when `.gazetta` prefix is empty).
 *     Test 3 below adds the specific state where this mutation
 *     matters (sibling under `.gazetta/`).
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

  it('caches the in-flight rebuild — second call reuses the memoized promise (covers publish.ts:185 `if (p) return p`)', async () => {
    // First call primes the memo AND writes the fragment-deps sidecar.
    // Then we delete the whole `.gazetta/fragment-deps` subtree so the
    // rebuild's write is undone. Under unmutated code, the second call's
    // `p = fragmentDepsBackfill.get(key)` returns the (already-resolved)
    // promise from the first call, line 185's `if (p) return p` fires,
    // no fresh IIFE runs, no rebuild, and the sidecar stays deleted —
    // `findDependentsFromSidecars` reads the empty subtree and returns
    // `{ pages: [], fragments: [] }`.
    //
    // Under line 185 `ConditionalExpression → false`, the memoized
    // promise is discarded; the IIFE re-runs; line 191's exists probe
    // sees no `.gazetta/fragment-deps` (we deleted it), line 192 does
    // NOT early-return, rebuild runs, and `header/pages.home` is
    // re-written. The response would then contain `pages: ['home']` —
    // this assertion fails, killing the mutation.
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

    const res1 = await app.request('/api/dependents?item=fragments/header')
    expect(res1.status).toBe(200)
    expect(await sourceStorage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(true)

    // Simulate divergent state: wipe the whole fragment-deps subtree.
    // The memo still holds the resolved promise from the first call.
    await sourceStorage.rm('.gazetta/fragment-deps')
    expect(await sourceStorage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(false)

    const res2 = await app.request('/api/dependents?item=fragments/header')
    expect(res2.status).toBe(200)
    const body = (await res2.json()) as { pages: string[]; fragments: string[] }

    // Memo hit → no rebuild → empty subtree stays empty.
    expect(body.pages).toEqual([])
    expect(await sourceStorage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(false)
  })

  it('skips rebuild when `.gazetta/fragment-deps` already exists (covers publish.ts:192 `if (exists) return` + line 187 `.gazetta` StringLiteral)', async () => {
    // Pre-seed a synthetic sidecar under the correct index path with a
    // page name that isn't in the site. Under unmutated code, line 191
    // probes `.gazetta/fragment-deps` → true, line 192 returns early,
    // rebuild is skipped, and the synthetic sidecar persists.
    // `findDependentsFromSidecars` reads the directory and returns
    // `pages: ['synthetic-orphan']`.
    //
    // Under line 192 `ConditionalExpression → false`, the early-return
    // is skipped; rebuild runs; `rebuildDepIndex` wipes the entire
    // `.gazetta/fragment-deps` subtree first (per publish-rendered.ts
    // line 478) then re-derives from real manifests. The synthetic
    // sidecar is destroyed; `header/pages.home` is written; the
    // response now returns `pages: ['home']`.
    //
    // Same test also kills line 187 `'.gazetta'` → `""`: the mutated
    // probe path `fragment-deps` (without the `.gazetta` prefix) does
    // NOT match the seeded `.gazetta/fragment-deps/…` files, so exists
    // returns false, rebuild runs, synthetic is wiped.
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
      '.gazetta/fragment-deps/header/pages.synthetic-orphan': '',
    })

    const { app } = buildApp({ sourceStorage, withTargetConfigs: true })

    const res = await app.request('/api/dependents?item=fragments/header')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pages: string[]; fragments: string[] }

    expect(body.pages).toEqual(['synthetic-orphan'])
    expect(await sourceStorage.exists('.gazetta/fragment-deps/header/pages.synthetic-orphan')).toBe(true)
    expect(await sourceStorage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(false)
  })

  it('probes `.gazetta/fragment-deps` specifically, not just `.gazetta` (covers publish.ts:187 `fragment-deps` StringLiteral)', async () => {
    // A sibling directory under `.gazetta/` (here: history) makes
    // `.gazetta` a populated prefix while `.gazetta/fragment-deps`
    // remains empty. Under unmutated code, line 187 composes the full
    // `.gazetta/fragment-deps` path, line 191 probes it → false (no
    // matching prefix), line 192 falls through, rebuild runs, and
    // `header/pages.home` is written.
    //
    // Under line 187 `'fragment-deps'` → `""`, the mutated probe path
    // is just `.gazetta`. The sibling under `.gazetta/history/` makes
    // that prefix satisfy exists (true); line 192 early-returns;
    // rebuild is never invoked; the fragment-deps sidecar is never
    // written; `findDependentsFromSidecars` reads an empty subtree and
    // returns `pages: []`.
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
      '.gazetta/history/dummy-revision.json': '{}',
    })

    const { app } = buildApp({ sourceStorage, withTargetConfigs: true })

    const res = await app.request('/api/dependents?item=fragments/header')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pages: string[]; fragments: string[] }

    expect(body.pages).toEqual(['home'])
    expect(await sourceStorage.exists('.gazetta/fragment-deps/header/pages.home')).toBe(true)
  })
})
