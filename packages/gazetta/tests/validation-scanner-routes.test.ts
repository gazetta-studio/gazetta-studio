/**
 * Background scanner and validators that read the site's routes (#1303).
 *
 * A page's broken-links result depends on other pages' routes, so a route
 * change (page deleted, renamed, created) must re-validate the pages that
 * could link to it, without re-running validators that read only the item's
 * own manifest.
 */
import { describe, expect, it } from 'vitest'
import type { FragmentManifest, PageManifest } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import { createContentRoot } from '../src/content-root.js'
import { createMemoryCache } from '../src/cache/memory.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { createValidationScanner } from '../src/validation/scanner.js'
import { brokenLinks } from '../src/validation/validators/broken-links.js'
import type { Validator } from '../src/validation/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function buildSite(pages: Record<string, PageManifest>, fragments: Record<string, FragmentManifest> = {}): Site {
  return {
    pages: new Map(Object.entries(pages).map(([n, p]) => [n, { ...p, dir: `pages/${n}` }])),
    fragments: new Map(Object.entries(fragments).map(([n, f]) => [n, { ...f, dir: `fragments/${n}` }])),
    pageLocales: new Map(),
    fragmentLocales: new Map(),
    manifest: { name: 'test-site', targets: { local: {} } } as Site['manifest'],
    templatesDir: undefined,
  } as Site
}

/** Stands in for broken-links: page `home` links to `/b`. */
function linkChecker(): { validator: Validator; calls: () => number } {
  let calls = 0
  const validator: Validator = {
    source: 'gazetta',
    name: 'link-checker',
    stages: ['background'],
    readsRoutes: true,
    defaultSeverity: () => 'warn',
    async validate({ scope, site }) {
      calls++
      if (scope.kind !== 'background' || scope.item.name !== 'home') return []
      const found = [...site.pages.values()].some(p => p.route === '/b')
      return found
        ? []
        : [{ validator: 'link-checker', severity: 'warn', message: '/b: broken', itemPath: scope.item.itemPath }]
    },
  }
  return { validator, calls: () => calls }
}

function counter(): { validator: Validator; calls: () => number } {
  let calls = 0
  const validator: Validator = {
    source: 'gazetta',
    name: 'own-manifest',
    stages: ['background'],
    defaultSeverity: () => 'info',
    async validate() {
      calls++
      return []
    },
  }
  return { validator, calls: () => calls }
}

function setup(site: Site, validators: Validator[]) {
  return createValidationScanner({
    storage: memoryStorage(),
    contentRoot: createContentRoot(memoryStorage()),
    registry: createValidatorRegistry(validators),
    cache: createMemoryCache(),
    siteOptions: { templatesDir: '/dev/null', manifest: site.manifest },
    loadSiteImpl: async () => site,
  })
}

describe('validation scanner: validators that read routes (#1303)', () => {
  it('broken-links declares that it reads routes', () => {
    expect(brokenLinks.readsRoutes).toBe(true)
  })

  it('re-flags a link when the page it points at is deleted', async () => {
    const site = buildSite({
      home: { route: '/', template: 't', content: {} },
      b: { route: '/b', template: 't', content: {} },
    })
    const scanner = setup(site, [linkChecker().validator])
    await scanner.scanAll()
    expect(scanner.issuesFor('pages/home/page.json')).toHaveLength(0)

    site.pages.delete('b')
    await scanner.rescan({ kind: 'manifest', item: { kind: 'page', name: 'b', itemPath: 'pages/b/page.json' } })

    expect(scanner.issuesFor('pages/home/page.json').map(i => i.message)).toEqual(['/b: broken'])
  })

  it('re-flags a link after a full scan when only another page changed its route', async () => {
    const site = buildSite({
      home: { route: '/', template: 't', content: {} },
      b: { route: '/b', template: 't', content: {} },
    })
    const scanner = setup(site, [linkChecker().validator])
    await scanner.scanAll()

    site.pages.set('b', { ...site.pages.get('b')!, route: '/c' })
    await scanner.scanAll()

    expect(scanner.issuesFor('pages/home/page.json')).toHaveLength(1)
  })

  it('clears the issue once the linked route exists again', async () => {
    const site = buildSite({ home: { route: '/', template: 't', content: {} } })
    const scanner = setup(site, [linkChecker().validator])
    await scanner.scanAll()
    expect(scanner.issuesFor('pages/home/page.json')).toHaveLength(1)

    site.pages.set('b', { route: '/b', template: 't', content: {}, dir: 'pages/b' } as never)
    await scanner.rescan({ kind: 'manifest', item: { kind: 'page', name: 'b', itemPath: 'pages/b/page.json' } })

    expect(scanner.issuesFor('pages/home/page.json')).toHaveLength(0)
  })

  it('a route change re-runs only route-reading validators, on pages only', async () => {
    const site = buildSite(
      {
        home: { route: '/', template: 't', content: {} },
        about: { route: '/about', template: 't', content: {} },
        b: { route: '/b', template: 't', content: {} },
      },
      { header: { template: 'h', content: {} } },
    )
    const links = linkChecker()
    const own = counter()
    const scanner = setup(site, [links.validator, own.validator])
    await scanner.scanAll()
    expect(own.calls()).toBe(4)
    expect(links.calls()).toBe(4)

    site.pages.delete('b')
    await scanner.rescan({ kind: 'manifest', item: { kind: 'page', name: 'b', itemPath: 'pages/b/page.json' } })

    // home and about re-run the route check; nothing re-runs the other validator.
    expect(own.calls()).toBe(4)
    expect(links.calls()).toBe(6)
  })

  it('a save that changes no route re-validates only the saved item', async () => {
    const site = buildSite({
      home: { route: '/', template: 't', content: {} },
      b: { route: '/b', template: 't', content: {} },
    })
    const links = linkChecker()
    const scanner = setup(site, [links.validator])
    await scanner.scanAll()
    expect(links.calls()).toBe(2)

    site.pages.set('b', { ...site.pages.get('b')!, content: { title: 'x' } })
    await scanner.rescan({ kind: 'manifest', item: { kind: 'page', name: 'b', itemPath: 'pages/b/page.json' } })

    expect(links.calls()).toBe(3)
  })

  it('drops a deleted page from the store on a route-change rescan', async () => {
    const site = buildSite({
      home: { route: '/', template: 't', content: {} },
      b: { route: '/b', template: 't', content: {} },
    })
    const own: Validator = {
      ...counter().validator,
      async validate({ scope }) {
        return scope.kind === 'background'
          ? [{ validator: 'own-manifest', severity: 'info', message: 'x', itemPath: scope.item.itemPath }]
          : []
      },
    }
    const scanner = setup(site, [own])
    await scanner.scanAll()
    expect(scanner.issuesFor('pages/b/page.json')).toHaveLength(1)

    site.pages.delete('b')
    await scanner.rescan({ kind: 'manifest', item: { kind: 'page', name: 'b', itemPath: 'pages/b/page.json' } })

    expect(scanner.issuesFor('pages/b/page.json')).toHaveLength(0)
  })
})
