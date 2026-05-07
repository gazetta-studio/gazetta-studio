/**
 * Unit tests for the background validation scanner (Validation Cut 2).
 *
 * Exercises:
 *   - Full-site scan populates the issue store
 *   - Cache hits short-circuit re-validation when content hash unchanged
 *   - Incremental rescan via `cause: 'manifest'` updates only the affected item
 *   - Fragment-edit rescan walks dependents (via stub of findDependentsFromSidecars)
 *   - Subscriber receives ScanEvent on completion
 *   - Stale items pruned when scan finishes (e.g. after a delete)
 */
import { describe, it, expect, vi } from 'vitest'
import type { FragmentManifest, PageManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import { createContentRoot } from '../src/content-root.js'
import { createMemoryCache } from '../src/cache/memory.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { createValidationScanner } from '../src/validation/scanner.js'
import type { Issue, Validator } from '../src/validation/types.js'

// ---- helpers --------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}): StorageProvider {
  const files = new Map(Object.entries(initial))
  return {
    async readFile(path) {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async writeFile(path, content) {
      files.set(path, content as string)
    },
    async readDir() {
      return []
    },
    async exists(path) {
      return files.has(path)
    },
    async mkdir() {},
    async rm(path) {
      files.delete(path)
    },
    async readBytes() {
      throw new Error('not used in test')
    },
    async writeBytes() {},
    async readStream() {
      throw new Error('not used in test')
    },
    async writeStream() {
      throw new Error('not used in test')
    },
  }
}

function buildSite(opts: { pages?: Record<string, PageManifest>; fragments?: Record<string, FragmentManifest> }): Site {
  const pages = new Map<string, PageManifest & { dir: string }>()
  for (const [name, p] of Object.entries(opts.pages ?? {})) {
    pages.set(name, { ...p, dir: `pages/${name}` })
  }
  const fragments = new Map<string, FragmentManifest & { dir: string }>()
  for (const [name, f] of Object.entries(opts.fragments ?? {})) {
    fragments.set(name, { ...f, dir: `fragments/${name}` })
  }
  return {
    pages,
    fragments,
    pageLocales: new Map(),
    fragmentLocales: new Map(),
    manifest: { name: 'test-site', targets: { local: {} } } as Site['manifest'],
    templatesDir: undefined,
  } as Site
}

function trackingValidator(name: string): { validator: Validator; getCalls(): number } {
  let calls = 0
  const validator: Validator = {
    source: 'gazetta',
    name,
    stages: ['background'],
    defaultSeverity: () => 'warn',
    async validate(input) {
      calls++
      if (input.scope.kind !== 'background') return []
      const issue: Issue = {
        validator: name,
        severity: 'warn',
        message: `from ${name}`,
        itemPath: input.scope.item.itemPath,
      }
      return [issue]
    },
  }
  return { validator, getCalls: () => calls }
}

// ---- tests ----------------------------------------------------------------

describe('validation scanner', () => {
  it('scans every page + fragment and stores issues per item', async () => {
    const site = buildSite({
      pages: { home: { template: 'page-default', content: {} } },
      fragments: { header: { template: 'header', content: {} } },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    await scanner.scanAll()

    expect(scanner.allIssues()).toHaveLength(2)
    expect(scanner.issuesFor('pages/home/page.json')).toHaveLength(1)
    expect(scanner.issuesFor('fragments/header/fragment.json')).toHaveLength(1)
  })

  it('cache hit short-circuits re-validation on unchanged content', async () => {
    const site = buildSite({
      pages: { home: { template: 'page-default', content: {} } },
    })
    const tracker = trackingValidator('test-validator')
    const cache = createMemoryCache()
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache,
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    await scanner.scanAll()
    expect(tracker.getCalls()).toBe(1)

    // Second scan with same content should hit cache; calls don't increment.
    await scanner.scanAll()
    expect(tracker.getCalls()).toBe(1)
  })

  it('incremental rescan with manifest cause re-validates only the affected item', async () => {
    const site = buildSite({
      pages: {
        home: { template: 'page-default', content: {} },
        about: { template: 'page-default', content: {} },
      },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    await scanner.scanAll()
    const baseline = tracker.getCalls() // 2 (home + about)
    expect(baseline).toBe(2)

    // Mutate the home manifest so the cache key changes; rescan only the home item.
    site.pages.set('home', { ...site.pages.get('home')!, content: { changed: true } })
    await scanner.rescan({
      kind: 'manifest',
      item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' },
    })
    expect(tracker.getCalls()).toBe(baseline + 1) // only home revalidated
    expect(scanner.issuesFor('pages/home/page.json')).toHaveLength(1)
  })

  it('emits ScanEvent to subscribers', async () => {
    const site = buildSite({
      pages: { home: { template: 'page-default', content: {} } },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    const events: { scanned: number; totalIssues: number }[] = []
    scanner.subscribe(e => events.push({ scanned: e.scanned, totalIssues: e.totalIssues }))

    await scanner.scanAll()
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ scanned: 1, totalIssues: 1 })
  })

  it('prunes stale items from the store on full rescan', async () => {
    const site = buildSite({
      pages: {
        home: { template: 'page-default', content: {} },
        about: { template: 'page-default', content: {} },
      },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    await scanner.scanAll()
    expect(scanner.allIssues()).toHaveLength(2)

    // Delete a page; rescan should prune its issues.
    site.pages.delete('about')
    await scanner.scanAll()
    expect(scanner.allIssues()).toHaveLength(1)
    expect(scanner.issuesFor('pages/about/page.json')).toHaveLength(0)
  })

  it('subscriber faults isolated', async () => {
    const site = buildSite({
      pages: { home: { template: 'page-default', content: {} } },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    const goodEvents: number[] = []
    scanner.subscribe(() => {
      throw new Error('boom')
    })
    scanner.subscribe(e => goodEvents.push(e.scanned))

    await scanner.scanAll()
    expect(goodEvents).toEqual([1]) // good subscriber still ran
  })

  it('cache keys differ when nested content changes (regression: hash must canonicalize recursively)', async () => {
    // Caught during Cut 2 implementation: JSON.stringify(obj, keys.sort()) filters
    // only top-level keys, silently dropping nested mutations from the hash.
    // Mutation to `content.title` MUST produce a different cache key, otherwise
    // the second scan returns stale cached issues.
    const site = buildSite({
      pages: { home: { template: 'page-default', content: { title: 'A' } } },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    await scanner.scanAll()
    expect(tracker.getCalls()).toBe(1)

    site.pages.set('home', { ...site.pages.get('home')!, content: { title: 'B' } })
    await scanner.rescan({
      kind: 'manifest',
      item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' },
    })
    expect(tracker.getCalls()).toBe(2) // Re-validated; not a cache hit.
  })

  it('dispose returned by subscribe stops further events', async () => {
    const site = buildSite({
      pages: { home: { template: 'page-default', content: {} } },
    })
    const tracker = trackingValidator('test-validator')
    const scanner = createValidationScanner({
      storage: memoryStorage(),
      contentRoot: createContentRoot(memoryStorage()),
      registry: createValidatorRegistry([tracker.validator]),
      cache: createMemoryCache(),
      siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
      loadSiteImpl: async () => site,
    })

    const events: number[] = []
    const dispose = scanner.subscribe(e => events.push(e.scanned))
    await scanner.scanAll()
    dispose()
    await scanner.scanAll()
    expect(events).toEqual([1]) // second scan didn't fire
  })
})
