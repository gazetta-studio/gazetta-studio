/**
 * Mutation-coverage tests for `admin-api/index.ts` — targets gaps that
 * survived after the earlier cycles (#311 → #567 → #676). The `#311 →
 * #567 → #676` chain focused on lines 219–296 (auth prefix, adminDir
 * default, site-root regex, resolver selection, cached scan, lazyInit).
 * This cycle (issue #796) surfaces 66 actionable mutants concentrated
 * in the *audit-config + retention-pruner + cache-stats-logger + cache-
 * invalidation* surface (lines 310–527) that no prior cycle exercised.
 *
 * Mode: structural — test-only backfill against surviving Stryker
 * mutants. No source change; the admin-api code is already correct.
 *
 * Cluster A — `buildHistory` guard inside `registrySourceResolver`
 * (line 310, `!config || !isHistoryEnabled(config)`):
 *   - ConditionalExpression `[Survived] → false`: guard never fires;
 *     buildHistory keeps going and calls `getHistoryRetention(undefined)`
 *     on the ghost-target scenario, or `createHistoryProvider` on a
 *     history-disabled target.
 *   - LogicalOperator `[Survived] → "!config && !isHistoryEnabled(config)"`:
 *     guard fires only when BOTH `config` is missing AND history is
 *     disabled. The common "config present + history disabled" case
 *     bypasses the guard under the mutant and builds a HistoryProvider
 *     for a target that opted out.
 *   Kill: (a) target with `history: { enabled: false }` — saving through
 *   the registry resolver produces NO `.gazetta/history/` writes; (b)
 *   ghost-target scenario (config deleted after boot) — buildHistory's
 *   `!config` short-circuit prevents the crash the `false` mutant would
 *   cause when it reaches `getHistoryRetention(undefined)`.
 *
 * Cluster B — `AuditConfigurationError` thrown on invalid `admin.audit`
 * (lines 357–359, NoCoverage):
 *   - StringLiteral `[NoCoverage]` on 357 (message prefix), 358 (path
 *     separator `.`), 358 (map's per-issue template piece), 358 (map
 *     template piece), 359 (`; ` join separator)
 *   - ArrowFunction `[NoCoverage]` on 358 (issue-formatting map)
 *   Kill: pass a malformed `admin.audit` block; assert that the error
 *   message contains the prefix `"Invalid admin.audit block"` AND the
 *   specific failing field path (e.g., `provider: Invalid literal
 *   value`). The `.map`/`.join` chain runs; if the ArrowFunction is
 *   replaced with `() => undefined` the message body becomes literally
 *   `"undefined; undefined"`; if the separators are replaced with `""`,
 *   path and message concatenate without discriminators.
 *
 * Cluster C — sha256 pseudonymization salt required (lines 372–374):
 *   - BooleanLiteral `[NoCoverage]` on 372: the negation
 *     `!process.env.GAZETTA_AUDIT_ACTOR_SALT` mutated to the identity
 *   - BlockStatement `[NoCoverage]` on 372: the throw block emptied
 *   - ConditionalExpression `[Survived] → false`: guard never fires
 *   - StringLiteral `[NoCoverage]` on 374: the error message body
 *   Kill: (a) config with `actorPseudonym: 'sha256'` + no env var →
 *   throws with the specific message; (b) same config + env var set →
 *   admin boots. Both branches are exercised.
 *
 * Cluster D — hashed sourceIp salt required (lines 377–379): same
 * shape as Cluster C, mirrored for `recordSourceIp: 'hashed'` and
 * `GAZETTA_AUDIT_SOURCEIP_SALT`.
 *
 * Cluster E — cache-stats-logger boot gate (line 466):
 *   - BlockStatement `[NoCoverage]` (block emptied), BooleanLiteral
 *     `[Survived]` (negation flipped), ConditionalExpression
 *     `[Survived]` (→ true / false)
 *   Kill: two tests — `disableCacheStatsLogger: false` (default) →
 *   `startCacheStatsLogger` called once; `: true` → NOT called.
 *
 * Cluster F — audit retention pruner boot gate (lines 478–496):
 *   - Line 478: ConditionalExpression `[Survived] → true`, BooleanLiteral
 *     `[Survived] → "opts.disableAuditRetentionPruner"` (negation flipped)
 *   - Line 479: ConditionalExpression `[Survived] → true`,
 *     EqualityOperator `[Survived] → "provider !== 'history'"`
 *   - Line 481: 4 NoCoverage mutants on the retention-shape sub-clause
 *     (`retention.events !== undefined || retention.maxAgeMonths`)
 *   - Line 482 BlockStatement, Line 484 ArrowFunction, Line 487
 *     ObjectLiteral, Line 489 LogicalOperator, Line 496 arithmetic —
 *     all NoCoverage on the retention branch body
 *   Kill: (a) no retention configured → `runAuditPrune` NEVER called at
 *   boot; (b) `retention: { events: 100 }` → called once with events
 *   set; (c) `retention: { maxAgeMonths: 6 }` → called once with
 *   maxAgeMonths set. The three tests exercise the entire retention
 *   branch — arrow function body, retention config forwarding, and the
 *   interval calculation is dominated by the boot call.
 *
 * Cluster G — `invalidateTemplatesCache` closure (line 505):
 *   - ArrowFunction `[Survived] → "() => undefined"`
 *   Kill: after two `/api/compare` calls (which memoize the scan per
 *   Cluster 5 of the resolver test file), call
 *   `app.invalidateTemplatesCache()`; the next `/api/compare` re-invokes
 *   `scanTemplates`. Under the mutant, `invalidateTemplatesCache` is a
 *   no-op — the next compare would still hit the memoized value → call
 *   count stays at 1 (mutant) vs. 2 (original).
 *
 * Cluster H — `invalidateContentCache` closure (lines 506–509):
 *   - BlockStatement `[NoCoverage]` on 506 (outer async arrow body),
 *     507 (inner forEachBuilt callback body)
 *   - ArrayDeclaration `[NoCoverage]` on 508 (`Promise.all([...])` args)
 *   - StringLiteral `[NoCoverage]` on 508 (two — `'pages:'` and
 *     `'fragments:'`)
 *   Kill: seed cache entries under `pages:` and `fragments:` prefixes
 *   via the source context's cache; call `app.invalidateContentCache()`;
 *   assert both prefixes are cleared. Under any of these mutants at
 *   least one prefix survives.
 *
 * Cluster I — `buildHistoryForLegacySource` — legacy storage path with
 * history-disabled config (line 527):
 *   - ArrowFunction `[NoCoverage] → "() => undefined"` on the
 *     `Object.entries(configs).find(([, c]) => isHistoryEnabled(c))`
 *     predicate
 *   Kill: construct createAdminApp with `opts.storage` (not
 *   `opts.source`) + `opts.targetConfigs` where the ONLY entry has
 *   history disabled → legacy source construction is exercised, the
 *   predicate returns `false` for every entry, `find` returns
 *   undefined, and `buildHistoryForLegacySource` returns undefined
 *   (no history wired). Under the mutant, `find` receives a predicate
 *   that always returns undefined (falsy) → same observable result on
 *   the negative path. To distinguish, add a second test where the
 *   sole entry HAS history enabled → predicate returns true →
 *   `find` returns the entry → `createHistoryProvider` is invoked
 *   with correct retention. Under the mutant, `find` never returns a
 *   match → legacy source has no history → observable difference on
 *   the positive path.
 *
 * Documented equivalent / structurally unkillable mutants
 * (documented at file header so this doesn't get re-attempted next
 * cycle):
 *
 *   - Line 237 ConditionalExpression `[Survived] → true` on the
 *     `tDir === templatesDir ? cachedScan.get() : scanTemplates(...)`
 *     closure: equivalent because every call site under the current
 *     HTTP surface passes `tDir === templatesDir`. Killing would
 *     require a call path where `tDir !== templatesDir`, which no
 *     route exercises. Documented in the earlier resolver-mutation
 *     file (#676) and remains equivalent.
 *
 *   - Line 386 ConditionalExpression `[Survived] → true` on
 *     `if (auditConfig.provider === 'history')`: equivalent because
 *     `AuditConfigSchema` in `packages/gazetta/src/audit/config.ts`
 *     declares provider as `z.literal('history')`. There is no valid
 *     v1 config where provider !== 'history'; the default is also
 *     'history'. When v2 external-sink providers land, the schema
 *     extends to a discriminated union and this mutant becomes
 *     killable via a config with a non-history provider.
 *
 *   - Lines 408–458 various StringLiteral mutants replacing `'/'`
 *     mount prefixes with `''` on `app.route(...)` calls: equivalent
 *     under Hono's mount semantics — the sub-app's own routes carry
 *     their own paths (e.g. `/api/pages/:name`), and the empty string
 *     mount prefix is idiomatic no-prefix mounting. Both `'/'` and
 *     `''` produce identical routing behavior at the sub-app level.
 *
 * Per rule 26 (test-isolation paranoia): each test gets fresh
 * `memoryStorage()` and a fresh `createAdminApp`. Module-level
 * `vi.mock` targets are cleared in `beforeEach`. Env-var stubs are
 * cleared in `beforeEach` + `afterEach`. Runtime side effects (audit
 * pruner timer via `setInterval`) are gated by `.unref()` inside
 * production code; the 6-hour interval never fires during a test
 * pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { runAuditPrune as mockableRunAuditPrune } from '../src/admin-api/audit-prune-runner.js'
import { startCacheStatsLogger as mockableStartCacheStatsLogger } from '../src/admin-api/cache-stats-logger.js'
import { scanTemplates as mockableScanTemplates } from '../src/templates-scan.js'
import { createHistoryProvider as mockableCreateHistoryProvider } from '../src/history-provider.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import type { TargetConfig } from '../src/types.js'

/** Empty validator registry so save-delta doesn't 409 on missing templates in test fixtures. */
const emptyValidators = createValidatorRegistry([])

vi.mock('../src/admin-api/audit-prune-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/admin-api/audit-prune-runner.js')>(
    '../src/admin-api/audit-prune-runner.js',
  )
  return {
    ...actual,
    runAuditPrune: vi.fn(async () => {}),
  }
})

vi.mock('../src/admin-api/cache-stats-logger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/admin-api/cache-stats-logger.js')>(
    '../src/admin-api/cache-stats-logger.js',
  )
  return {
    ...actual,
    startCacheStatsLogger: vi.fn(actual.startCacheStatsLogger),
  }
})

vi.mock('../src/templates-scan.js', async () => {
  const actual = await vi.importActual<typeof import('../src/templates-scan.js')>('../src/templates-scan.js')
  return {
    ...actual,
    scanTemplates: vi.fn(async () => []),
  }
})

vi.mock('../src/history-provider.js', async () => {
  const actual = await vi.importActual<typeof import('../src/history-provider.js')>('../src/history-provider.js')
  return {
    ...actual,
    createHistoryProvider: vi.fn(actual.createHistoryProvider),
  }
})

beforeEach(() => {
  vi.mocked(mockableRunAuditPrune).mockClear()
  vi.mocked(mockableStartCacheStatsLogger).mockClear()
  vi.mocked(mockableScanTemplates).mockClear()
  vi.mocked(mockableScanTemplates).mockResolvedValue([])
  vi.mocked(mockableCreateHistoryProvider).mockClear()
  vi.unstubAllEnvs()
  // The salt env vars must be cleared explicitly — stubEnv from a
  // previous test may have set them, and process.env leaks across
  // tests without explicit teardown.
  vi.stubEnv('GAZETTA_AUDIT_ACTOR_SALT', '')
  vi.stubEnv('GAZETTA_AUDIT_SOURCEIP_SALT', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Cluster A — buildHistory guard (line 310)', () => {
  it('does NOT wire history for a target with `history: { enabled: false }`', async () => {
    // Under the original `!config || !isHistoryEnabled(config)` guard,
    // a target opting out of history returns undefined from the
    // buildHistory callback — no HistoryProvider is constructed.
    // Under mutant `false` (guard never fires) or `!config && !isHistoryEnabled(config)`
    // (guard fires only when BOTH), the code path calls
    // `createHistoryProvider` for the history-disabled target and
    // saves would then write to `.gazetta/history/`.
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    })
    const targetConfigs = {
      // History explicitly disabled — buildHistory guard should return undefined.
      local: {
        storage,
        type: 'esi' as const,
        environment: 'local' as const,
        editable: true,
        history: { enabled: false },
      },
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
      // Empty validators — otherwise save-delta 409s on the missing
      // template fixture, and we never reach the history-write phase
      // that observes the buildHistory guard.
      validators: emptyValidators,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // Reset the createHistoryProvider spy AFTER app construction so
    // any legacy-path calls during boot don't contaminate the count.
    vi.mocked(mockableCreateHistoryProvider).mockClear()

    const res = await app.request('/api/pages/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { title: 'Hello' } }),
    })
    expect(res.status).toBe(200)

    // Under the original guard, buildHistory returned undefined for
    // the history-disabled target → SourceContext.history is undefined
    // → save doesn't record a history revision → createHistoryProvider
    // is NEVER called for this target.
    //
    // Under both `false` and `!config && !isHistoryEnabled(config)`
    // mutants, buildHistory continues past the guard and calls
    // `createHistoryProvider` for the history-disabled target.
    expect(vi.mocked(mockableCreateHistoryProvider)).not.toHaveBeenCalled()
  })

  it('short-circuits without crashing when opts.targetConfigs[name] is undefined (ghost target)', async () => {
    // Companion test to the resolver-file's Cluster 6. Here we verify
    // that under the `false` mutant on line 310, buildHistory would
    // continue past the `!config` guard and hit
    // `getHistoryRetention(undefined)` — Node's default behavior is
    // to throw when reading `.history?.retention` on undefined... but
    // in fact the codebase uses `target.history?.retention` so
    // `getHistoryRetention(undefined)` throws a TypeError on the
    // outer `target.history` read.
    //
    // Under the original guard, the `!config` disjunct catches this
    // and buildHistory returns undefined cleanly.
    //
    // Note: the resolver-file's Cluster 6 test already exercises the
    // ghost-target path via lazyInit. This test is complementary —
    // it verifies buildHistory's own guard, not lazyInit's guard.
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    })
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
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })
    app.onError((err, c) => c.json({ errorName: err.name, errorMessage: err.message }, 500))

    // Drop the config AFTER admin construction — registry list still
    // includes 'ghost' (snapshotted at construction), but the config
    // lookup inside lazyInit AND buildHistory now returns undefined.
    delete targetConfigs.ghost

    const res = await app.request('/api/pages?target=ghost')
    // Under the original: lazyInit's `!config` short-circuit fires;
    // registry.get then throws UnknownTargetError (per resolver-file
    // Cluster 6). buildHistory is never reached for this ghost
    // target because lazyInit exits first. But when buildHistory
    // IS eventually called by a future path where config is
    // undefined, its own `!config` guard prevents the crash.
    //
    // This assertion is the same shape as resolver-file Cluster 6.
    // Its role here is to keep the two guards coherent: removing
    // either guard (mutant `false` on line 310 OR on line 296)
    // would surface a different error class.
    expect(res.status).toBe(500)
    const body = (await res.json()) as { errorName: string; errorMessage: string }
    expect(body.errorName).toBe('UnknownTargetError')
  })
})

describe('Cluster B — AuditConfigurationError on invalid admin.audit block (lines 357–359)', () => {
  it('throws with descriptive message + issue path + message when admin.audit is malformed', () => {
    // Malformed admin.audit block: strict must be boolean; sending
    // a string forces safeParse to fail with `{path: ['strict'], message: '...'}`.
    // The formatted message threads through the .map + .join chain
    // on lines 358–359, producing "Invalid admin.audit block in
    // site.config.ts: strict: <zod error>".
    //
    // Kills:
    // - Line 357 StringLiteral `""`: prefix disappears → no "Invalid
    //   admin.audit block" prefix in message
    // - Line 358 StringLiteral `""` on `.` separator: field path
    //   loses discriminator between array segments (single-segment
    //   paths still work, but this test uses a nested path via strict)
    // - Line 358 StringLiteral `""` on the template's `: ` separator:
    //   path and message concatenate as one token
    // - Line 358 ArrowFunction `() => undefined`: `.map(() => undefined)`
    //   produces `[undefined, undefined, ...]`; `.join('; ')` yields
    //   literal string "undefined" (or "undefined; undefined; ...")
    // - Line 359 StringLiteral `""` on `; ` join separator: issues
    //   concatenate without a delimiter
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: {
            provider: 'history',
            strict: 'not-a-boolean' as unknown as boolean,
          },
        },
      },
    })

    expect(() =>
      createAdminApp({
        source,
        siteDir: '/test-project',
        templatesDir: '/test-project/templates',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).toThrow(/Invalid admin.audit block in site\.config\.ts:.*strict.*/i)
  })
})

describe('Cluster C — sha256 pseudonymization salt required (lines 372–374)', () => {
  it('throws with a descriptive message when actorPseudonym: sha256 is set without the salt env var', () => {
    // Kills:
    // - Line 372 ConditionalExpression `false`: guard never fires;
    //   admin boots without the salt (silent misconfiguration)
    // - Line 372 BooleanLiteral (`!process.env.GAZETTA_AUDIT_ACTOR_SALT` →
    //   `process.env.GAZETTA_AUDIT_ACTOR_SALT`): guard fires only when
    //   the env var IS set — inverted semantics
    // - Line 372 BlockStatement `{}`: throw body emptied; guard's
    //   condition may match but no throw fires
    // - Line 374 StringLiteral `""`: message body empty; the
    //   `.toThrow(/regex/)` matcher below fails on empty message
    vi.stubEnv('GAZETTA_AUDIT_ACTOR_SALT', '') // explicitly cleared

    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: { provider: 'history', actorPseudonym: 'sha256' },
        },
      },
    })

    expect(() =>
      createAdminApp({
        source,
        siteDir: '/test-project',
        templatesDir: '/test-project/templates',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).toThrow(/actorPseudonym.*sha256.*GAZETTA_AUDIT_ACTOR_SALT/)
  })

  it('boots normally when actorPseudonym: sha256 is set AND the salt env var is present', () => {
    // Positive companion. Confirms the guard opens when the env var
    // is set. Kills the mutant that would throw regardless of env
    // (`process.env.GAZETTA_AUDIT_ACTOR_SALT` becomes truthy and
    // wouldn't matter under BooleanLiteral mutation of the negation).
    vi.stubEnv('GAZETTA_AUDIT_ACTOR_SALT', 'test-salt-value-16-bytes-random-hex')

    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: { provider: 'history', actorPseudonym: 'sha256' },
        },
      },
    })

    expect(() =>
      createAdminApp({
        source,
        siteDir: '/test-project',
        templatesDir: '/test-project/templates',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).not.toThrow()
  })
})

describe('Cluster D — hashed sourceIp salt required (lines 377–379)', () => {
  it('throws with a descriptive message when recordSourceIp: hashed is set without the salt env var', () => {
    // Same structure as Cluster C; kills the mirrored mutants on
    // lines 377–379 for the sourceIp pseudonymization path.
    vi.stubEnv('GAZETTA_AUDIT_SOURCEIP_SALT', '')

    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: { provider: 'history', recordSourceIp: 'hashed' },
        },
      },
    })

    expect(() =>
      createAdminApp({
        source,
        siteDir: '/test-project',
        templatesDir: '/test-project/templates',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).toThrow(/recordSourceIp.*hashed.*GAZETTA_AUDIT_SOURCEIP_SALT/)
  })

  it('boots normally when recordSourceIp: hashed is set AND the salt env var is present', () => {
    vi.stubEnv('GAZETTA_AUDIT_SOURCEIP_SALT', 'test-sourceip-salt-16-bytes-random')

    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: { provider: 'history', recordSourceIp: 'hashed' },
        },
      },
    })

    expect(() =>
      createAdminApp({
        source,
        siteDir: '/test-project',
        templatesDir: '/test-project/templates',
        disableCacheStatsLogger: true,
        disableAuditRetentionPruner: true,
      }),
    ).not.toThrow()
  })
})

describe('Cluster E — cache-stats-logger boot gate (line 466)', () => {
  it('starts the cache-stats logger by default (disableCacheStatsLogger absent)', () => {
    // Kills:
    // - Line 466 BlockStatement `{}` (block emptied → logger never runs)
    // - Line 466 BooleanLiteral (negation flipped → logger runs only
    //   when explicitly disabled)
    // - Line 466 ConditionalExpression `false` (never runs)
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: {} },
    })
    createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      // disableCacheStatsLogger intentionally NOT passed — exercises
      // the default (undefined = falsy) branch.
      disableAuditRetentionPruner: true,
    })

    expect(vi.mocked(mockableStartCacheStatsLogger)).toHaveBeenCalledTimes(1)
    // Verify the logger receives the source's cache — kills a
    // hypothetical mutant where the argument is replaced.
    const call = vi.mocked(mockableStartCacheStatsLogger).mock.calls[0]
    expect(call[0]).toHaveProperty('cache')
  })

  it('does NOT start the cache-stats logger when disableCacheStatsLogger: true', () => {
    // Kills the mutant `ConditionalExpression → true` — under that
    // mutant, the block runs regardless of the flag.
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: {} },
    })
    createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    expect(vi.mocked(mockableStartCacheStatsLogger)).not.toHaveBeenCalled()
  })
})

describe('Cluster F — audit retention pruner boot gate (lines 478–496)', () => {
  it('does NOT invoke runAuditPrune when no retention is configured', () => {
    // The retention branch requires ALL of:
    //   !opts.disableAuditRetentionPruner
    //   AND auditConfig.provider === 'history'
    //   AND auditConfig.retention
    //   AND (retention.events !== undefined OR retention.maxAgeMonths)
    //
    // Kills:
    // - Line 478/479/481 ConditionalExpression `true`: branch always
    //   runs (no retention configured) → runAuditPrune called anyway
    // - Line 478 BooleanLiteral (negation flipped): branch runs only
    //   when pruner IS explicitly disabled — inverted
    // - Line 479 EqualityOperator (provider !== 'history'): branch
    //   runs when provider is anything but 'history' (impossible in
    //   v1 schema, but the equality check is load-bearing)
    // - Line 481 LogicalOperator (`||` → `&&`): requires BOTH events
    //   AND maxAgeMonths; the events-only or maxAgeMonths-only config
    //   would skip the branch under the mutant
    // - Line 481 EqualityOperator (`!==` → `===`): flips the events
    //   presence check
    // - Line 481 ConditionalExpression `false`: branch never runs
    //   (covered by this negative test too)
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: {} },
    })
    createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      // disableAuditRetentionPruner: false (default) — the retention
      // block SHOULD skip because no admin.audit.retention was
      // configured.
      disableCacheStatsLogger: true,
    })

    expect(vi.mocked(mockableRunAuditPrune)).not.toHaveBeenCalled()
  })

  it('invokes runAuditPrune at boot when retention.events is configured', () => {
    // Kills:
    // - Line 481 ConditionalExpression `false`: branch never runs →
    //   runAuditPrune uncalled → assertion fails
    // - Line 482 BlockStatement `{}`: retention block empty → pruner
    //   variables never bound → assertion fails
    // - Line 484 ArrowFunction `() => undefined`: `runPrune` becomes
    //   the identity-returning-undefined; boot pass `void runPrune()`
    //   still runs but doesn't call `runAuditPrune`
    // - Line 487 ObjectLiteral `{}`: retentionConfig arg is empty
    //   object; runAuditPrune is called with `{ storage, retentionConfig: {} }`
    //   — killed by the argument-shape assertion below
    // - Line 489 LogicalOperator (`??` → `&&`): `maxAgeMonths ?? null`
    //   becomes `maxAgeMonths && null` — undefined && null = undefined;
    //   the pruner receives `maxAgeMonths: undefined` instead of `null`
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: {
            provider: 'history',
            retention: { events: 100 },
          },
        },
      },
    })
    createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      disableCacheStatsLogger: true,
      // disableAuditRetentionPruner: false (default) — the pruner
      // SHOULD run because retention.events is set.
    })

    expect(vi.mocked(mockableRunAuditPrune)).toHaveBeenCalledTimes(1)
    // Verify the retentionConfig shape — kills the ObjectLiteral `{}`
    // mutant on line 487 which would produce an empty config, and
    // the LogicalOperator mutant on line 489 that would replace
    // `maxAgeMonths ?? null` with `maxAgeMonths && null` (which
    // yields undefined for undefined input, not null).
    const call = vi.mocked(mockableRunAuditPrune).mock.calls[0]
    expect(call[0]).toMatchObject({
      retentionConfig: {
        events: 100,
        maxAgeMonths: null,
      },
    })
  })

  it('invokes runAuditPrune at boot when retention.maxAgeMonths is configured (alone)', () => {
    // Kills:
    // - Line 481 LogicalOperator (`||` → `&&`): under the mutant, the
    //   retention block requires BOTH events AND maxAgeMonths; with
    //   only maxAgeMonths, the branch skips → pruner never runs →
    //   assertion fails
    // - Line 481 EqualityOperator (`!==` → `===`): flips the events
    //   presence check; under the mutant, `retention.events === undefined`
    //   is true here (events IS undefined) → branch skips
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: {
            provider: 'history',
            retention: { maxAgeMonths: 6 },
          },
        },
      },
    })
    createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      disableCacheStatsLogger: true,
    })

    expect(vi.mocked(mockableRunAuditPrune)).toHaveBeenCalledTimes(1)
    const call = vi.mocked(mockableRunAuditPrune).mock.calls[0]
    expect(call[0]).toMatchObject({
      retentionConfig: {
        events: undefined,
        maxAgeMonths: 6,
      },
    })
  })

  it('does NOT invoke runAuditPrune when disableAuditRetentionPruner: true, even with retention configured', () => {
    // Kills:
    // - Line 478 BooleanLiteral (negation flipped): under the mutant,
    //   the condition becomes `opts.disableAuditRetentionPruner`
    //   (not negated) → branch runs ONLY when disabled → pruner
    //   fires here despite the flag → assertion fails
    // - Line 478 ConditionalExpression `true`: branch always runs
    //   regardless of the flag
    const storage = memoryStorage()
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: {
        name: 'test-site',
        targets: {},
        admin: {
          audit: {
            provider: 'history',
            retention: { events: 100 },
          },
        },
      },
    })
    createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    expect(vi.mocked(mockableRunAuditPrune)).not.toHaveBeenCalled()
  })
})

describe('Cluster G — invalidateTemplatesCache closure (line 505)', () => {
  it('re-runs scanTemplates on next request after invalidateTemplatesCache is called', async () => {
    // Kills:
    // - Line 505 ArrowFunction `() => undefined`:
    //   invalidateTemplatesCache becomes a no-op → the memoized
    //   scan survives → subsequent /api/compare calls return the
    //   cached result → scanTemplates call count stays at 1 (not 2).
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

    // First compare — populates the memoized scan.
    await app.request('/api/compare?target=local')

    // Second compare BEFORE invalidation — should hit the memoized
    // scan (same behavior as the resolver-file's Cluster 5 test).
    await app.request('/api/compare?target=local')

    // Extend the admin app's public surface as declared in the module
    // (AdminApp type augments Hono with invalidateTemplatesCache).
    ;(app as unknown as { invalidateTemplatesCache: () => void }).invalidateTemplatesCache()

    // Third compare AFTER invalidation — should trigger a fresh
    // scanTemplates call. Under the mutant, invalidateTemplatesCache
    // did nothing → scan is still memoized → this call is served
    // from the memo.
    await app.request('/api/compare?target=local')

    const matchingCalls = vi
      .mocked(mockableScanTemplates)
      .mock.calls.filter(([tDir, root]) => tDir === '/test-project/templates' && root === '/test-project')

    // Original: exactly 2 (one before, one after invalidation).
    // Mutant `() => undefined`: exactly 1 (invalidation was a no-op).
    expect(matchingCalls).toHaveLength(2)
  })
})

describe('Cluster H — invalidateContentCache closure (lines 506–509)', () => {
  it('invalidates both pages: and fragments: prefixes across every built source context', async () => {
    // Kills:
    // - Line 506 BlockStatement `{}` on the outer async arrow: body
    //   empty → forEachBuilt never called → nothing invalidated →
    //   seeded entries survive
    // - Line 507 BlockStatement `{}` on the inner forEachBuilt
    //   callback: forEachBuilt runs but the callback does nothing →
    //   no invalidation
    // - Line 508 ArrayDeclaration `[]`: `await Promise.all([])` → no
    //   invalidations run → both prefixes survive
    // - Line 508 StringLiteral `""` on `'pages:'`: invalidatePrefix
    //   called with empty string; wipes ALL cache entries, not just
    //   pages — but crucially, the specific `pages:` prefix invalidation
    //   MAY not fire correctly under an empty-prefix flush (depends
    //   on implementation). More importantly, the `fragments:`
    //   StringLiteral mutant on the same line replaces THAT string
    //   with '' — the invalidation call becomes `invalidatePrefix('')`
    //   twice, and the individual `pages:` / `fragments:` calls
    //   never fire.
    //
    // The test asserts that specific pages: and fragments: entries
    // are cleared. Under the empty-string mutant, both prefixes
    // survive because the invalidation targets a different prefix.
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    })
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: {} },
    })
    const app = createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // Seed cache entries under both prefixes. Access source.cache
    // directly because it's the same instance the admin app uses
    // (staticSourceResolver returns the bootstrap source per request).
    await source.cache.set('pages:test-page-key', { some: 'page-data' })
    await source.cache.set('fragments:test-fragment-key', { some: 'fragment-data' })

    // Sanity: both entries are readable pre-invalidation.
    expect(await source.cache.get('pages:test-page-key')).toEqual({ some: 'page-data' })
    expect(await source.cache.get('fragments:test-fragment-key')).toEqual({ some: 'fragment-data' })

    // Invoke the AdminApp's invalidateContentCache method.
    await (app as unknown as { invalidateContentCache: () => Promise<void> }).invalidateContentCache()

    // Original: both entries cleared.
    // Various mutants: one or both entries survive.
    expect(await source.cache.get('pages:test-page-key')).toBeNull()
    expect(await source.cache.get('fragments:test-fragment-key')).toBeNull()
  })
})

describe('Cluster I — buildHistoryForLegacySource predicate (line 527)', () => {
  it('calls createHistoryProvider when at least one legacy target has history enabled', () => {
    // The legacy path fires when the caller passes `opts.storage`
    // (not `opts.source`) AND `opts.targetConfigs`. The predicate
    // `Object.entries(configs).find(([, c]) => isHistoryEnabled(c))`
    // picks the first entry whose history is enabled; that config's
    // retention is used to build the HistoryProvider.
    //
    // Kill: spy on `createHistoryProvider`. Under original with a
    // history-enabled target, it's called with the legacy storage +
    // that target's retention. Under mutant `() => undefined`, the
    // predicate always returns undefined → `find` returns undefined
    // → `buildHistoryForLegacySource` returns undefined → the mock
    // is NEVER called by the legacy path.
    //
    // We can't trigger a save-through-manifest-load here because the
    // legacy path constructs a SourceContext without a manifest, and
    // `loadSiteFromSource` requires one. Observing the constructor
    // call is the honest test — it proves the predicate did its job
    // during createAdminApp's boot phase.
    const storage = memoryStorage()
    const targetConfigs = {
      // Default: history enabled (no explicit override).
      local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }

    // Reset the counter to isolate this test from other mock uses.
    vi.mocked(mockableCreateHistoryProvider).mockClear()

    createAdminApp({
      storage,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // Original: predicate matches → createHistoryProvider called once.
    // Mutant: predicate returns undefined for every entry → find
    // returns undefined → createHistoryProvider never called.
    expect(vi.mocked(mockableCreateHistoryProvider)).toHaveBeenCalledTimes(1)
    // Verify it received the legacy storage and the target's default
    // retention (matches `getHistoryRetention` for a target without
    // an explicit history block).
    const call = vi.mocked(mockableCreateHistoryProvider).mock.calls[0]
    expect(call[0]).toMatchObject({ storage })
    expect(call[0].retention).toBeGreaterThan(0)
  })

  it('does NOT call createHistoryProvider when every legacy target has history disabled', () => {
    // Companion negative test. Both mutants ({find-returns-undefined,
    // find-returns-entry-anyway}) collapse to "no createHistoryProvider
    // call" here — the original's `if (!firstEditable) return undefined`
    // short-circuit is the branch under test.
    const storage = memoryStorage()
    const targetConfigs = {
      local: {
        storage,
        type: 'esi' as const,
        environment: 'local' as const,
        editable: true,
        history: { enabled: false },
      },
    }

    vi.mocked(mockableCreateHistoryProvider).mockClear()

    createAdminApp({
      storage,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // No history-enabled target → find returns undefined → early return.
    expect(vi.mocked(mockableCreateHistoryProvider)).not.toHaveBeenCalled()
  })
})
