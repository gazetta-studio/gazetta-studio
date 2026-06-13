/**
 * Mutation-coverage tests for `admin-api/index.ts` — closes
 * surviving / no-coverage mutants identified by the StrykerJS run
 * (issue #311). Coverage gaps targeted:
 *
 * Cluster 1 — `resolveInstanceId()` fallback chain (lines 193–202):
 *  - BlockStatement on line 195: `if (K_REVISION) return ...` → `{}`
 *  - ConditionalExpression on line 197: `if (name)` → `if (true)` / `if (false)`
 *  - BlockStatement on line 197: `if (name) return name` → `{}`
 *  - NoCoverage on the catch + randomBytes fallback (line 201)
 *
 * `resolveInstanceId` is not exported; its return value flows into
 * `HistoryAuditProvider({ instance })` which builds the JSONL filename
 * `.gazetta/audit/events-{instance}.jsonl`. Tests verify the filename
 * after a save produces an audit event.
 *
 * Cluster 2 — `createAdminApp()` initialization (lines 219–234):
 *  - StringLiteral on line 219: `'/api/*'` → `''`
 *  - StringLiteral on line 222: `'admin'` → `''`
 *  - LogicalOperator on line 222: `opts.adminDir ?? join(...)` → `opts.adminDir`
 *  - Regex on line 234: `/[\\/]sites[\\/][^\\/]+$/` → `/(?:)/`
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` and a fresh `createAdminApp`. No module-level
 * state. `vi.stubEnv` is reset between tests; `os.hostname` is
 * mocked at module level and restored to a benign default in
 * `beforeEach`.
 *
 * VERIFICATION NOTES (manual mutation walk against this file):
 *
 *   - `if (K_REVISION) { }` BlockStatement on line 195 → `{}`:
 *       K_REVISION set → branch becomes a no-op → falls through to
 *       hostname(). Audit file uses hostname value instead of
 *       K_REVISION value. Killed by "K_REVISION drives audit
 *       instance id".
 *   - `if (true)` ConditionalExpression on line 197:
 *       hostname returns '' → with mutant the empty string is
 *       returned. Audit file becomes `.gazetta/audit/events-.jsonl`
 *       (no random hex tail). Killed by "empty hostname falls
 *       through to randomBytes".
 *   - `if (false)` ConditionalExpression on line 197:
 *       hostname returns a non-empty string → with mutant falls
 *       through to randomBytes anyway. Audit file uses random hex
 *       instead of the hostname. Killed by "non-empty hostname
 *       drives audit instance id".
 *   - `if (name) { }` BlockStatement on line 197 → `{}`:
 *       same effect as `if (false)` — return inside the block
 *       never executes; randomBytes path always taken.
 *   - Line 201 catch + randomBytes fallback NoCoverage:
 *       hostname() never throws in tests today. Mocking it to
 *       throw drives the catch branch and covers the fallback.
 *       Killed by "hostname throwing falls through to randomBytes".
 *   - `''` StringLiteral on line 219 (route prefix):
 *       With `GAZETTA_TOKEN` set, requests to `/api/*` should 401
 *       without auth. With `''` the auth middleware doesn't match
 *       `/api/*` paths → request passes through. Killed by
 *       "GAZETTA_TOKEN gates `/api/*` requests".
 *   - `''` StringLiteral on line 222 (adminDir default):
 *       adminDir becomes `join(siteDir, '')` === siteDir. The
 *       `/api/fields` route looks under `siteDir/fields` instead
 *       of `siteDir/admin/fields/` → returns []. Killed by
 *       "default adminDir resolves to siteDir/admin".
 *   - LogicalOperator on line 222 (`opts.adminDir ?? join(...)` → `opts.adminDir`):
 *       When `opts.adminDir` is undefined AND `projectSiteDir`
 *       differs from `opts.siteDir`, with mutant `adminDir` is
 *       `undefined` → fieldRoutes' inner fallback uses
 *       `projectSiteDir/admin`, NOT `opts.siteDir/admin`. The
 *       fields seeded under `opts.siteDir/admin/fields/` are
 *       invisible. Killed by the same test (projectSiteDir ≠
 *       siteDir; fields seeded under siteDir/admin).
 *   - `/(?:)/` Regex on line 234:
 *       `'/foo/sites/main'.replace(/(?:)/, '')` = `/foo/sites/main`
 *       (empty match replaced with empty). The cached scan's
 *       projectRoot passes through unchanged instead of being
 *       stripped to `/foo`. Killed by "site-root regex strips
 *       `/sites/<name>` from siteDir for scanTemplates".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { hostname as mockableHostname } from 'node:os'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { memoryCache } from '../src/cache/factories.js'
import { scanTemplates as mockableScanTemplates } from '../src/templates-scan.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    hostname: vi.fn(actual.hostname),
  }
})

vi.mock('../src/templates-scan.js', async () => {
  const actual = await vi.importActual<typeof import('../src/templates-scan.js')>('../src/templates-scan.js')
  return {
    ...actual,
    scanTemplates: vi.fn(async () => []),
  }
})

beforeEach(() => {
  // Default the hostname mock to a benign known value so tests that
  // don't override see deterministic behaviour. Tests that exercise
  // the empty / throwing / specific-string paths override per-test.
  vi.mocked(mockableHostname).mockReturnValue('default-test-host')
  vi.mocked(mockableScanTemplates).mockClear()
  vi.mocked(mockableScanTemplates).mockResolvedValue([])
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function setupAuditApp(): { app: Hono; storage: MemoryStorage } {
  const storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
  })
  // Pass a pre-built cache with an explicit `instance` override so the
  // cache layer's own `resolveInstanceId(opts.instance)` short-circuits
  // and doesn't call hostname(). That keeps the test's hostname mock
  // scoped to the admin-api `resolveInstanceId` (line 193-202 — the one
  // we're trying to mutation-test).
  //
  // NOTE: targetConfigs is intentionally omitted so createAdminApp uses
  // `staticSourceResolver(source)` — that path reuses the bootstrap
  // source (and its pre-built cache) per request instead of building a
  // fresh source-context (with a fresh memoryCache() call that would
  // re-trigger hostname()).
  const cache = memoryCache({ instance: 'test-cache-isolated-instance' })
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: {
        local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
      },
    },
    cache,
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    disableCacheStatsLogger: true,
    disableAuditRetentionPruner: true,
  })
  return { app, storage }
}

async function triggerSaveAudit(app: Hono): Promise<Response> {
  // PUT against the seeded page records an audit event with action:
  // 'save' regardless of outcome (success / validation-failed / etc.),
  // because the audit recording lives inside savePage's orchestration
  // (per `manifest-save.ts`). For our purpose we only care that the
  // .gazetta/audit/events-{instance}.jsonl file exists with the
  // expected instance suffix — outcome value is incidental.
  return app.request('/api/pages/home', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { title: 'Hello' } }),
  })
}

async function readAuditFilenames(storage: MemoryStorage): Promise<string[]> {
  const entries = await storage.readDir('.gazetta/audit').catch(() => [])
  return entries
    .filter(e => !e.isDirectory && e.name.startsWith('events-') && e.name.endsWith('.jsonl'))
    .map(e => e.name)
}

describe('Cluster 1 — resolveInstanceId() drives the audit JSONL filename', () => {
  it('K_REVISION drives the audit instance id (line 195 short-circuit)', async () => {
    vi.stubEnv('K_REVISION', 'rev-test-12345')
    // hostname is irrelevant when K_REVISION is set; pick a value
    // that would be observable if the short-circuit didn't fire.
    vi.mocked(mockableHostname).mockReturnValue('hostname-should-not-appear')

    const { app, storage } = setupAuditApp()
    await triggerSaveAudit(app)

    const files = await readAuditFilenames(storage)
    expect(files).toContain('events-rev-test-12345.jsonl')
    expect(files).not.toContain('events-hostname-should-not-appear.jsonl')
  })

  it('non-empty hostname drives the audit instance id when K_REVISION is unset (line 197 if-true branch)', async () => {
    // K_REVISION explicitly cleared so the early return doesn't fire.
    vi.stubEnv('K_REVISION', '')
    vi.mocked(mockableHostname).mockReturnValue('pod-alpha-1')

    const { app, storage } = setupAuditApp()
    await triggerSaveAudit(app)

    const files = await readAuditFilenames(storage)
    expect(files).toContain('events-pod-alpha-1.jsonl')
  })

  it('empty hostname falls through to randomBytes (line 197 guard rejects empty)', async () => {
    vi.stubEnv('K_REVISION', '')
    vi.mocked(mockableHostname).mockReturnValue('')

    const { app, storage } = setupAuditApp()
    await triggerSaveAudit(app)

    const files = await readAuditFilenames(storage)
    expect(files).toHaveLength(1)
    // randomBytes(4).toString('hex') → exactly 8 hex chars.
    expect(files[0]).toMatch(/^events-[0-9a-f]{8}\.jsonl$/)
    // Must NOT be the empty-string suffix that the mutated guard would produce.
    expect(files[0]).not.toBe('events-.jsonl')
  })

  it('hostname throwing falls through to randomBytes (line 198 catch branch)', async () => {
    vi.stubEnv('K_REVISION', '')
    vi.mocked(mockableHostname).mockImplementation(() => {
      throw new Error('hostname unavailable on this runtime')
    })

    const { app, storage } = setupAuditApp()
    await triggerSaveAudit(app)

    const files = await readAuditFilenames(storage)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^events-[0-9a-f]{8}\.jsonl$/)
  })
})

describe('Cluster 2a — auth middleware route prefix `/api/*` (line 219 StringLiteral)', () => {
  it('GAZETTA_TOKEN gates `/api/*` requests; non-/api paths bypass auth', async () => {
    // authMiddleware reads `process.env.GAZETTA_TOKEN` at construction
    // time, so the env var must be stubbed BEFORE createAdminApp runs.
    vi.stubEnv('GAZETTA_TOKEN', 'secret-bearer-value')

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

    // Without Authorization: 401 from authMiddleware. Killed by the
    // mutant — if the prefix is '', authMiddleware never runs on
    // `/api/*` and `/api/health` returns 200 instead of 401.
    const unauthorized = await app.request('/api/health')
    expect(unauthorized.status).toBe(401)
    const errorBody = (await unauthorized.json()) as { error: string }
    expect(errorBody.error).toBe('Unauthorized')

    // With Authorization header: 200. Confirms the auth gate accepts
    // the bearer token; not strictly needed to kill the mutant but
    // documents the happy path.
    const authorized = await app.request('/api/health', {
      headers: { Authorization: 'Bearer secret-bearer-value' },
    })
    expect(authorized.status).toBe(200)
  })
})

describe('Cluster 2b — adminDir default `join(siteDir, "admin")` (line 222 StringLiteral + LogicalOperator)', () => {
  // The two mutants are killed by the same test shape:
  //
  // - StringLiteral `'admin' → ''`: with the mutant adminDir becomes
  //   `join(siteDir, '')` = siteDir. /api/fields looks at
  //   `siteDir/fields`. Our setup places fields at
  //   `siteDir/admin/fields/` → fields list comes back empty.
  //
  // - LogicalOperator `opts.adminDir ?? join(...) → opts.adminDir`:
  //   when opts.adminDir is undefined, with the mutant adminDir is
  //   undefined → fieldRoutes' inner fallback resolves to
  //   `source.projectSiteDir/admin`. Our setup deliberately has
  //   `projectSiteDir !== opts.siteDir` so the inner fallback points
  //   at a different (empty) directory.

  let root: string

  beforeEach(async () => {
    root = tempDir('admin-index-mutcov-' + Date.now())
    // Seed siteDir/admin/fields/brand-color.tsx. fieldRoutes' GET
    // /api/fields lists files under `${adminDir}/fields/` and
    // returns those with .ts/.tsx extensions.
    await mkdir(join(root, 'site/admin/fields'), { recursive: true })
    await writeFile(join(root, 'site/admin/fields/brand-color.tsx'), '// stub')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('default adminDir resolves to `siteDir/admin` so /api/fields finds seeded fields', async () => {
    const siteDir = join(root, 'site')
    // projectSiteDir intentionally differs from siteDir so the
    // LogicalOperator mutant is observable: with the mutant, the
    // inner fallback in fieldRoutes uses projectSiteDir/admin which
    // has no `fields/` subdirectory and returns [].
    const projectSiteDirDistinct = join(root, 'project-site')
    await mkdir(projectSiteDirDistinct, { recursive: true })

    const storage = createFilesystemProvider(root)
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: projectSiteDirDistinct,
      manifest: { name: 'test-site', targets: {} },
    })
    const app = createAdminApp({
      source,
      siteDir, // adminDir defaults to siteDir/admin
      // adminDir intentionally NOT passed.
      templatesDir: resolve(root, 'no-templates'), // unused for this test
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    const res = await app.request('/api/fields')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map(f => f.name)).toContain('brand-color')
  })
})

describe('Cluster 2c — site-root regex `/[\\/]sites[\\/][^\\/]+$/` (line 234 Regex)', () => {
  it('strips trailing `/sites/<name>` from siteDir for the cached scanTemplates call', async () => {
    // Trigger the cached scan by hitting the compare route. The route
    // calls compareTargets which calls our route's injected `scan`
    // function with `(templatesDir, projectRoot)`. Because tDir matches
    // templatesDir, our closure returns cachedScan.get(), which invokes
    // the mocked scanTemplates with the regex-stripped siteDir as the
    // projectRoot.
    const storage = memoryStorage()
    const targetConfigs = {
      local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/home/user/project/sites/main',
      manifest: { name: 'test-site', targets: targetConfigs },
    })
    const app = createAdminApp({
      source,
      siteDir: '/home/user/project/sites/main',
      templatesDir: '/home/user/project/templates',
      targets: new Map([['local', storage]]),
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // GET /api/compare?target=local triggers compareTargets which
    // calls the cached scan via `scan(templatesDir, projectRoot)`.
    // We don't care about the response body — only about which args
    // the spy captured.
    await app.request('/api/compare?target=local')

    // The mocked scanTemplates may be called multiple times depending
    // on the route flow; we assert that at least one call matches the
    // expected (templatesDir, regex-stripped siteDir) shape. The
    // cached scan inside createAdminApp is the one we want.
    const calls = vi.mocked(mockableScanTemplates).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const cachedScanCall = calls.find(
      ([tDir, root]) => tDir === '/home/user/project/templates' && root === '/home/user/project',
    )
    expect(cachedScanCall).toBeDefined()
    // Belt-and-suspenders: the mutant `/(?:)/` would produce
    // `/home/user/project/sites/main` (unchanged) as the projectRoot.
    // No call should pass that string with the templatesDir.
    const mutantWouldCall = calls.find(
      ([tDir, root]) => tDir === '/home/user/project/templates' && root === '/home/user/project/sites/main',
    )
    expect(mutantWouldCall).toBeUndefined()
  })
})

/**
 * Cluster 2d — `templatesDir` default `join(siteDir, 'templates')` (line 222
 * StringLiteral `'templates' → ""`).
 *
 * When `opts.templatesDir` is absent, the admin app derives
 * `${siteDir}/templates`. With the mutant `''`, the derivation collapses to
 * `join(siteDir, '')` = `siteDir`. The cached `scanTemplates` call captures
 * this difference: original calls `scanTemplates('/test/project/templates', ...)`;
 * mutant calls `scanTemplates('/test/project', ...)`.
 *
 * Triggered via `/api/compare` so the cached scan runs end-to-end.
 */
describe('Cluster 2d — templatesDir default `siteDir/templates` (line 222 StringLiteral)', () => {
  it('derives templatesDir as `siteDir/templates` when opts.templatesDir is unset', async () => {
    const storage = memoryStorage()
    const targetConfigs = {
      local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test/project',
      manifest: { name: 'test-site', targets: targetConfigs },
    })
    const app = createAdminApp({
      source,
      siteDir: '/test/project',
      // templatesDir intentionally NOT passed — exercises the default branch
      targets: new Map([['local', storage]]),
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    // Compare route triggers the cached scan with (templatesDir, projectRoot).
    await app.request('/api/compare?target=local')

    const calls = vi.mocked(mockableScanTemplates).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(1)

    // Original derivation: '/test/project' + 'templates' → '/test/project/templates'.
    const originalCall = calls.find(([tDir]) => tDir === '/test/project/templates')
    expect(originalCall).toBeDefined()

    // Mutant would call with the empty-suffix derivation: join('/test/project', '')
    // === '/test/project'. Reject that signature.
    const mutantWouldCall = calls.find(([tDir]) => tDir === '/test/project')
    expect(mutantWouldCall).toBeUndefined()
  })
})

/**
 * Cluster 2e — site-root regex anchored to end-of-string (line 235 Regex
 * `/[\\/]sites[\\/][^\\/]+$/ → /[\\/]sites[\\/][^\\/]+/`, i.e. the `$`
 * anchor is dropped).
 *
 * Both original and mutant strip a trailing `/sites/<name>` (the existing
 * Cluster 2c test covers that path). The mutant only differs when the
 * `/sites/<name>` segment is in the MIDDLE of the path — without `$`, the
 * mutant strips it; with `$`, the original leaves the path untouched.
 *
 * siteDir choice: `/home/user/sites/main/inner` — `/sites/main` is followed
 * by `/inner`, so the trailing-anchor `$` doesn't match in the original.
 */
describe('Cluster 2e — site-root regex anchored at end (line 235 Regex)', () => {
  it('does NOT strip `/sites/<name>` when it appears in the middle of siteDir', async () => {
    const storage = memoryStorage()
    const targetConfigs = {
      local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    }
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/home/user/sites/main/inner',
      manifest: { name: 'test-site', targets: targetConfigs },
    })
    const app = createAdminApp({
      source,
      siteDir: '/home/user/sites/main/inner',
      templatesDir: '/home/user/sites/main/inner/templates',
      targets: new Map([['local', storage]]),
      targetConfigs,
      disableCacheStatsLogger: true,
      disableAuditRetentionPruner: true,
    })

    await app.request('/api/compare?target=local')

    const calls = vi.mocked(mockableScanTemplates).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(1)

    // Original (anchored): no match → root unchanged.
    const originalCall = calls.find(
      ([tDir, root]) => tDir === '/home/user/sites/main/inner/templates' && root === '/home/user/sites/main/inner',
    )
    expect(originalCall).toBeDefined()

    // Mutant (no `$`): strips middle `/sites/main` → root = '/home/user/inner'.
    const mutantWouldCall = calls.find(
      ([tDir, root]) => tDir === '/home/user/sites/main/inner/templates' && root === '/home/user/inner',
    )
    expect(mutantWouldCall).toBeUndefined()
  })
})

/**
 * Cluster 3 — history backfill block (lines 249-251) is structurally
 * dead in v1 and NOT tested here.
 *
 * The block:
 *
 *   if (!opts.source.history) {
 *     source = { ...opts.source, history: buildHistoryForSource(opts, opts.source) }
 *   }
 *
 * `buildHistoryForSource` requires `opts.targetConfigs[source.targetName]`
 * to exist with history enabled — otherwise it returns undefined and the
 * backfill is a no-op. But when `opts.targetConfigs` has any entries,
 * `createAdminApp` selects the **registry** source resolver, which
 * constructs its own per-request `SourceContext` via
 * `createSourceContextFromRegistry` and provides history through the
 * registry's `buildHistory` callback — never consulting the backfilled
 * `source.history` on `opts.source`. When `opts.targetConfigs` is empty
 * (static resolver path), `buildHistoryForSource` returns undefined and
 * the backfill is a no-op.
 *
 * The two configurations are mutually exclusive: there is no
 * createAdminApp option shape under which the backfilled `source.history`
 * affects the observable behavior of subsequent routes.
 *
 * The line 249 BooleanLiteral / ConditionalExpression / BlockStatement
 * mutants therefore survive because the branch they touch is unreachable
 * from the route surface, not because of weak tests. Fixing them requires
 * either deleting the dead block or refactoring so the static resolver
 * also routes through the same backfill path — a source-code change, not
 * a test addition.
 */
