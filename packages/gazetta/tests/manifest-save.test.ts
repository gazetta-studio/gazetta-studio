/**
 * Save pipeline orchestrator — exhaustive `SaveResult` variant tests.
 *
 * Cut 2 ports the spine from `admin-api/routes/pages.ts:290-510` into
 * `saveManifestCore`. Each `SaveResult` variant gets a dedicated test
 * that drives the pipeline through that branch with minimal scaffolding
 * (memoryStorage + in-memory cache stub + no-op audit + no-op
 * validators).
 *
 * Per team-preferences rule 26 (test-isolation paranoia): each test
 * builds its own input from a factory; no module-level state.
 *
 * Per testing-plan.md priority 1.2 pattern: in-memory `StorageProvider`
 * stub for fast, deterministic round-trips.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveManifestCore,
  type SaveAuditRecorder,
  type SaveHookCancelled,
  type SaveManifestInput,
  type SaveManifestKind,
  type SaveOk,
  type SaveResult,
  type SaveStale,
  type SaveValidationFailed,
} from '../src/manifest-save.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createContentRoot } from '../src/content-root.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { Validator } from '../src/validation/types.js'
import { computeSaveEtag } from '../src/save-etag.js'

describe('SaveResult type contract', () => {
  it('SaveOk discriminates with ok: true', () => {
    const ok: SaveOk = { ok: true, etag: 'abc123' }
    expectTypeOf(ok.ok).toEqualTypeOf<true>()
    expectTypeOf(ok.etag).toEqualTypeOf<string>()
  })

  it('SaveStale carries current manifest + currentEtag', () => {
    const stale: SaveStale = {
      ok: false,
      code: 'STALE',
      current: { template: 'hero', content: {} },
      currentEtag: 'def456',
    }
    expectTypeOf(stale.code).toEqualTypeOf<'STALE'>()
    expectTypeOf(stale.current).toEqualTypeOf<Record<string, unknown>>()
  })

  it('SaveValidationFailed carries readonly Issue list', () => {
    const failed: SaveValidationFailed = {
      ok: false,
      code: 'VALIDATION_FAILED',
      issues: [],
    }
    expectTypeOf(failed.code).toEqualTypeOf<'VALIDATION_FAILED'>()
  })

  it('SaveHookCancelled carries hook name + reason', () => {
    const cancelled: SaveHookCancelled = {
      ok: false,
      code: 'HOOK_CANCELLED',
      hook: 'auto-slugify',
      reason: 'slug already exists',
    }
    expectTypeOf(cancelled.code).toEqualTypeOf<'HOOK_CANCELLED'>()
  })

  it('SaveResult union exhaustively narrows on `ok` and `code`', () => {
    // Compile-time check: switch statement is exhaustive
    const project = (r: SaveResult): number => {
      if (r.ok) return 200
      switch (r.code) {
        case 'STALE':
          return 409
        case 'VALIDATION_FAILED':
          return 409
        case 'HOOK_CANCELLED':
          return 409
        // No default — adding a variant produces a TS error here.
      }
    }
    expect(project({ ok: true, etag: 'x' })).toBe(200)
    expect(project({ ok: false, code: 'STALE', current: {}, currentEtag: 'x' })).toBe(409)
  })
})

describe('SaveManifestInput type contract', () => {
  it('kind discriminator covers page + fragment', () => {
    expectTypeOf<SaveManifestKind>().toEqualTypeOf<'page' | 'fragment'>()
  })
})

describe('saveManifestCore — pipeline branches', () => {
  let tempRoot: string

  beforeEach(async () => {
    // Per team-preferences rule 26: per-test temp dir; no shared state.
    tempRoot = await mkdtemp(join(tmpdir(), 'manifest-save-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns SaveOk on happy path with no hooks/scanner', async () => {
    const fixture = await buildPageFixture(tempRoot, {
      template: 'hero',
      content: { title: 'Hello' },
      components: [],
    })
    const audit = noopAuditRecorder()
    const result = await saveManifestCore({
      kind: 'page',
      name: 'home',
      manifest: { template: 'hero', content: { title: 'World' }, components: [] },
      before: fixture.before,
      manifestPath: fixture.manifestPath,
      site: fixture.site,
      cacheInvalidatePrefixes: ['pages:'],
      etagExtras: { route: '/home' },
      source: fixture.source,
      audit,
      principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
      validators: createValidatorRegistry([]),
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.etag).toMatch(/^[0-9a-f]{16}$/)
    expect(audit.events).toHaveLength(1)
    expect(audit.events[0]).toMatchObject({ action: 'save', outcome: 'success' })
  })

  it('returns SaveStale when If-Match mismatches current etag', async () => {
    const fixture = await buildPageFixture(tempRoot, {
      template: 'hero',
      content: { title: 'Hello' },
      components: [],
    })
    const audit = noopAuditRecorder()
    const result = await saveManifestCore({
      kind: 'page',
      name: 'home',
      manifest: { template: 'hero', content: { title: 'Bye' }, components: [] },
      before: fixture.before,
      manifestPath: fixture.manifestPath,
      site: fixture.site,
      cacheInvalidatePrefixes: ['pages:'],
      etagExtras: { route: '/home' },
      source: fixture.source,
      audit,
      principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
      validators: createValidatorRegistry([]),
      ifMatch: 'wrong-etag-value',
    })

    expect(result.ok).toBe(false)
    if (!result.ok && result.code === 'STALE') {
      expect(result.current.template).toBe('hero')
      expect(result.currentEtag).toMatch(/^[0-9a-f]{16}$/)
    }
    // No audit on STALE — it's a precheck failure, not a save attempt.
    expect(audit.events).toHaveLength(0)
  })

  it('passes If-Match when etag matches current', async () => {
    const fixture = await buildPageFixture(tempRoot, {
      template: 'hero',
      content: { title: 'Hello' },
      components: [],
    })
    const currentEtag = await computeSaveEtag({ ...fixture.before, route: '/home' })
    const audit = noopAuditRecorder()
    const result = await saveManifestCore({
      kind: 'page',
      name: 'home',
      manifest: { template: 'hero', content: { title: 'Bye' }, components: [] },
      before: fixture.before,
      manifestPath: fixture.manifestPath,
      site: fixture.site,
      cacheInvalidatePrefixes: ['pages:'],
      etagExtras: { route: '/home' },
      source: fixture.source,
      audit,
      principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
      validators: createValidatorRegistry([]),
      ifMatch: currentEtag,
    })

    expect(result.ok).toBe(true)
  })

  it('returns SaveValidationFailed when a validator emits a blocking error', async () => {
    const fixture = await buildPageFixture(tempRoot, {
      template: 'hero',
      content: { title: 'Hello' },
      components: [],
    })
    const blockingValidator: Validator = {
      name: 'always-blocks',
      stages: ['save-delta'],
      defaultSeverity: () => 'error',
      async validate({ scope }) {
        if (scope.kind !== 'save-delta') return []
        return [
          {
            validator: 'always-blocks',
            severity: 'error',
            message: 'no save for you',
            itemPath: scope.item.itemPath,
          },
        ]
      },
    }
    const audit = noopAuditRecorder()
    const result = await saveManifestCore({
      kind: 'page',
      name: 'home',
      manifest: { template: 'hero', content: { title: 'World' }, components: [] },
      before: fixture.before,
      manifestPath: fixture.manifestPath,
      site: fixture.site,
      cacheInvalidatePrefixes: ['pages:'],
      etagExtras: { route: '/home' },
      source: fixture.source,
      audit,
      principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
      validators: createValidatorRegistry([blockingValidator]),
    })

    expect(result.ok).toBe(false)
    if (!result.ok && result.code === 'VALIDATION_FAILED') {
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]?.validator).toBe('always-blocks')
    }
    expect(audit.events).toHaveLength(1)
    expect(audit.events[0]).toMatchObject({
      action: 'save',
      outcome: 'validation-failed',
    })
  })

  it('invalidates the configured cache prefixes on success', async () => {
    const fixture = await buildPageFixture(tempRoot, {
      template: 'hero',
      content: { title: 'Hello' },
      components: [],
    })
    const result = await saveManifestCore({
      kind: 'fragment',
      name: 'home',
      manifest: { template: 'hero', content: { title: 'World' }, components: [] },
      before: fixture.before,
      manifestPath: fixture.manifestPath,
      site: fixture.site,
      cacheInvalidatePrefixes: ['fragments:', 'pages:'],
      etagExtras: {},
      source: fixture.source,
      audit: noopAuditRecorder(),
      principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
      validators: createValidatorRegistry([]),
    })

    expect(result.ok).toBe(true)
    expect(fixture.invalidatedPrefixes).toEqual(['fragments:', 'pages:'])
  })

  it('fires scanner.rescan after a successful save (fire-and-forget)', async () => {
    const fixture = await buildPageFixture(tempRoot, {
      template: 'hero',
      content: { title: 'Hello' },
      components: [],
    })
    const rescan = vi.fn().mockResolvedValue(undefined)
    const result = await saveManifestCore({
      kind: 'page',
      name: 'home',
      manifest: { template: 'hero', content: { title: 'World' }, components: [] },
      before: fixture.before,
      manifestPath: fixture.manifestPath,
      site: fixture.site,
      cacheInvalidatePrefixes: ['pages:'],
      etagExtras: { route: '/home' },
      source: fixture.source,
      audit: noopAuditRecorder(),
      principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
      validators: createValidatorRegistry([]),
      scanner: { rescan },
    })

    expect(result.ok).toBe(true)
    expect(rescan).toHaveBeenCalledWith({
      kind: 'manifest',
      item: { kind: 'page', name: 'home', itemPath: fixture.manifestPath },
    })
  })
})

// ----- helpers -----

interface AuditCapture extends SaveAuditRecorder {
  events: Array<Parameters<SaveAuditRecorder['record']>[0]>
}

function noopAuditRecorder(): AuditCapture {
  const events: AuditCapture['events'] = []
  return {
    events,
    async record(event) {
      events.push(event)
    },
  }
}

interface PageFixture {
  before: Record<string, unknown>
  manifestPath: string
  site: Site
  source: SaveManifestInput['source']
  invalidatedPrefixes: string[]
}

async function buildPageFixture(
  tempRoot: string,
  before: { template: string; content: Record<string, unknown>; components: unknown[] },
): Promise<PageFixture> {
  // Lay out a minimal valid site on disk: site.config.ts equivalent
  // (we feed a synthetic SiteManifest), one Page Manifest at
  // pages/home/page.json, no fragments. Real filesystem provider so
  // the spine's writeFile / sidecar writes / history (absent) hit
  // real I/O paths.
  const pagesDir = join(tempRoot, 'pages', 'home')
  await mkdir(pagesDir, { recursive: true })
  const manifestPath = join(pagesDir, 'page.json')
  await writeFile(manifestPath, `${JSON.stringify(before, null, 2)}\n`, 'utf-8')

  const storage = createFilesystemProvider(tempRoot)
  const contentRoot = createContentRoot(storage, '')
  const invalidatedPrefixes: string[] = []
  const cache = {
    async invalidatePrefix(prefix: string) {
      invalidatedPrefixes.push(prefix)
      return 0
    },
  }
  const site = await loadSite({
    contentRoot,
    manifest: {
      name: 'test-site',
      locales: { default: 'en', supported: ['en'] },
      targets: {},
    },
  })
  return {
    before: { ...before, route: '/home' },
    manifestPath,
    site,
    source: {
      storage,
      contentRoot,
      cache,
      manifest: { name: 'test-site' },
    },
    invalidatedPrefixes,
  }
}
