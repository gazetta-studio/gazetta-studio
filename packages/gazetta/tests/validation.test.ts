/**
 * Unit tests for Validation Cut 1 — the Validator contract, registry,
 * save-delta orchestrator, and the 5 reference-existence validators.
 *
 * Each validator is exercised in isolation against a minimal in-memory Site
 * so the test surface stays narrow. Integration with the admin-API PUT
 * handler is covered by admin-api.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { PageManifest, FragmentManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import { createContentRoot } from '../src/content-root.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { runSaveDelta, hasBlockingIssues } from '../src/validation/save-delta.js'
import { defaultValidatorRegistry } from '../src/validation/default-registry.js'
import { referencedAssetExists } from '../src/validation/validators/referenced-asset-exists.js'
import { referencedFragmentExists } from '../src/validation/validators/referenced-fragment-exists.js'
import { referencedTemplateExists } from '../src/validation/validators/referenced-template-exists.js'
import { circularFragment } from '../src/validation/validators/circular-fragment.js'
import { dynamicRouteConflict } from '../src/validation/validators/dynamic-route-conflict.js'
import type { Validator, ValidatorInput } from '../src/validation/types.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- In-memory storage helper ------------------------------------------

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
    async readDir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const entries = new Map<string, { isDirectory: boolean }>()
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) entries.set(rest, { isDirectory: false })
        else entries.set(rest.slice(0, slash), { isDirectory: true })
      }
      return [...entries.entries()].map(([name, info]) => ({ name, ...info }))
    },
    async exists(path) {
      if (files.has(path)) return true
      const prefix = path.endsWith('/') ? path : `${path}/`
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) return true
      }
      return false
    },
    async mkdir() {
      // no-op for memory storage
    },
    async rm(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      for (const k of [...files.keys()]) {
        if (k === path || k.startsWith(prefix)) files.delete(k)
      }
    },
  } as StorageProvider
}

// ---- Site factories ----------------------------------------------------

function makeSite(overrides: Partial<Site> = {}): Site {
  const storage = memoryStorage()
  return {
    manifest: { name: 'test' },
    pages: new Map(),
    pageLocales: new Map(),
    fragments: new Map(),
    fragmentLocales: new Map(),
    contentRoot: createContentRoot(storage, ''),
    storage,
    siteDir: '',
    templatesDir: '',
    ...overrides,
  } as Site
}

function makeInput(opts: {
  site: Site
  storage: StorageProvider
  itemKind: 'page' | 'fragment'
  itemName: string
  before: PageManifest | FragmentManifest | null
  after: PageManifest | FragmentManifest
}): ValidatorInput {
  return {
    stage: 'save-delta',
    site: opts.site,
    contentRoot: opts.site.contentRoot,
    storage: opts.storage,
    scope: {
      kind: 'save-delta',
      item: { kind: opts.itemKind, name: opts.itemName, itemPath: `${opts.itemKind}s/${opts.itemName}/page.json` },
      before: opts.before,
      after: opts.after,
    },
  }
}

// ---- Registry ----------------------------------------------------------

describe('createValidatorRegistry', () => {
  it('returns an empty registry by default', () => {
    const reg = createValidatorRegistry()
    expect(reg.all()).toEqual([])
    expect(reg.forStage('save-delta')).toEqual([])
  })

  it('seeds initial validators', () => {
    const v: Validator = {
      name: 'noop',
      stages: ['save-delta'],
      defaultSeverity: () => 'error',
      validate: async () => [],
    }
    const reg = createValidatorRegistry([v])
    expect(reg.all()).toHaveLength(1)
    expect(reg.forStage('save-delta')).toEqual([v])
    expect(reg.forStage('background')).toEqual([])
  })

  it('register adds at runtime', () => {
    const reg = createValidatorRegistry()
    const v: Validator = {
      name: 'noop',
      stages: ['cli'],
      defaultSeverity: () => 'warn',
      validate: async () => [],
    }
    reg.register(v)
    expect(reg.forStage('cli')).toEqual([v])
  })

  it('forStage filters by validator stages declaration', () => {
    const a: Validator = { name: 'a', stages: ['save-delta'], defaultSeverity: () => 'error', validate: async () => [] }
    const b: Validator = { name: 'b', stages: ['background'], defaultSeverity: () => 'warn', validate: async () => [] }
    const reg = createValidatorRegistry([a, b])
    expect(reg.forStage('save-delta')).toEqual([a])
    expect(reg.forStage('background')).toEqual([b])
  })
})

// ---- defaultValidatorRegistry ------------------------------------------

describe('defaultValidatorRegistry', () => {
  it('ships the 5 Cut 1 validators', () => {
    const reg = defaultValidatorRegistry()
    const names = reg.all().map(v => v.name)
    expect(names).toContain('referenced-asset-exists')
    expect(names).toContain('referenced-fragment-exists')
    expect(names).toContain('referenced-template-exists')
    expect(names).toContain('circular-fragment')
    expect(names).toContain('dynamic-route-conflict')
  })

  it('every Cut 1 ref-existence validator runs at save-delta', () => {
    const reg = defaultValidatorRegistry()
    const saveDeltaNames = reg
      .forStage('save-delta')
      .map(v => v.name)
      .sort()
    expect(saveDeltaNames).toEqual([
      'circular-fragment',
      'dynamic-route-conflict',
      'referenced-asset-exists',
      'referenced-fragment-exists',
      'referenced-template-exists',
    ])
  })

  it('Cut 2 background-only validators are present and tagged background+cli', () => {
    const reg = defaultValidatorRegistry()
    const backgroundNames = reg
      .forStage('background')
      .map(v => v.name)
      .sort()
    expect(backgroundNames).toContain('schema-conformance')
    expect(backgroundNames).toContain('orphaned-locale-file')
    expect(backgroundNames).toContain('unused-fragment')
    // None of the background-only validators leak into save-delta
    const saveDeltaNames = reg.forStage('save-delta').map(v => v.name)
    expect(saveDeltaNames).not.toContain('schema-conformance')
    expect(saveDeltaNames).not.toContain('orphaned-locale-file')
    expect(saveDeltaNames).not.toContain('unused-fragment')
  })
})

// ---- runSaveDelta orchestrator -----------------------------------------

describe('runSaveDelta', () => {
  it('runs all save-delta validators and unions their issues', async () => {
    const a: Validator = {
      name: 'a',
      stages: ['save-delta'],
      defaultSeverity: () => 'error',
      validate: async () => [{ validator: 'a', severity: 'error', message: 'a-fail', itemPath: 'p' }],
    }
    const b: Validator = {
      name: 'b',
      stages: ['save-delta'],
      defaultSeverity: () => 'warn',
      validate: async () => [{ validator: 'b', severity: 'warn', message: 'b-warn', itemPath: 'p' }],
    }
    const reg = createValidatorRegistry([a, b])
    const site = makeSite()
    const issues = await runSaveDelta(
      {
        item: { kind: 'page', name: 'p', itemPath: 'p' },
        before: null,
        after: { template: 't', content: {} },
        site,
        contentRoot: site.contentRoot,
        storage: site.storage,
      },
      reg,
    )
    expect(issues).toHaveLength(2)
    expect(issues.map(i => i.validator).sort()).toEqual(['a', 'b'])
  })

  it('skips validators that do not declare save-delta stage', async () => {
    const bgOnly: Validator = {
      name: 'bg',
      stages: ['background'],
      defaultSeverity: () => 'warn',
      validate: async () => [{ validator: 'bg', severity: 'warn', message: 'should not fire', itemPath: 'p' }],
    }
    const reg = createValidatorRegistry([bgOnly])
    const site = makeSite()
    const issues = await runSaveDelta(
      {
        item: { kind: 'page', name: 'p', itemPath: 'p' },
        before: null,
        after: { template: 't', content: {} },
        site,
        contentRoot: site.contentRoot,
        storage: site.storage,
      },
      reg,
    )
    expect(issues).toEqual([])
  })

  it('catches validator throws and surfaces them as synthetic issues', async () => {
    const broken: Validator = {
      name: 'broken',
      stages: ['save-delta'],
      defaultSeverity: () => 'error',
      validate: async () => {
        throw new Error('boom')
      },
    }
    const reg = createValidatorRegistry([broken])
    const site = makeSite()
    const issues = await runSaveDelta(
      {
        item: { kind: 'page', name: 'p', itemPath: 'p' },
        before: null,
        after: { template: 't', content: {} },
        site,
        contentRoot: site.contentRoot,
        storage: site.storage,
      },
      reg,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('broken')
    expect(issues[0].message).toContain('boom')
  })
})

describe('hasBlockingIssues', () => {
  it('true when any error', () => {
    expect(hasBlockingIssues([{ validator: 'a', severity: 'error', message: '', itemPath: '' }])).toBe(true)
  })
  it('false when only warns or infos', () => {
    expect(
      hasBlockingIssues([
        { validator: 'a', severity: 'warn', message: '', itemPath: '' },
        { validator: 'b', severity: 'info', message: '', itemPath: '' },
      ]),
    ).toBe(false)
  })
  it('false on empty', () => {
    expect(hasBlockingIssues([])).toBe(false)
  })
})

// ---- referenced-asset-exists -------------------------------------------

describe('referenced-asset-exists', () => {
  it('flags when an _asset ref points at a missing manifest', async () => {
    const storage = memoryStorage({}) // no assets
    const site = makeSite({ storage })
    const issues = await referencedAssetExists.validate(
      makeInput({
        site,
        storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: { hero: { _asset: 'missing-asset' } } },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('referenced-asset-exists')
    expect(issues[0].message).toContain('missing-asset')
  })

  it('passes when the asset exists in storage', async () => {
    const storage = memoryStorage({ 'assets/hero.asset.json': '{}' })
    const site = makeSite({ storage })
    const issues = await referencedAssetExists.validate(
      makeInput({
        site,
        storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: { hero: { _asset: 'hero' } } },
      }),
    )
    expect(issues).toEqual([])
  })

  it('walks nested components', async () => {
    const storage = memoryStorage({}) // no assets
    const site = makeSite({ storage })
    const issues = await referencedAssetExists.validate(
      makeInput({
        site,
        storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: {
          template: 't',
          content: {},
          components: [
            {
              name: 'section',
              template: 'section',
              content: {},
              components: [{ name: 'card', template: 'card', content: { img: { _asset: 'deep-missing' } } }],
            },
          ],
        },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('deep-missing')
  })
})

// ---- referenced-fragment-exists ----------------------------------------

describe('referenced-fragment-exists', () => {
  it('flags missing fragment refs', async () => {
    const site = makeSite({ fragments: new Map() })
    const issues = await referencedFragmentExists.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, components: ['@nope'] },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('@nope')
  })

  it('passes when the fragment exists', async () => {
    const fragments = new Map([
      ['header', { template: 'h', dir: 'fragments/header' } as FragmentManifest & { dir: string }],
    ])
    const site = makeSite({ fragments })
    const issues = await referencedFragmentExists.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, components: ['@header'] },
      }),
    )
    expect(issues).toEqual([])
  })

  it('walks nested inline components for @ refs', async () => {
    const site = makeSite({ fragments: new Map() })
    const issues = await referencedFragmentExists.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: {
          template: 't',
          content: {},
          components: [{ name: 'section', template: 's', content: {}, components: ['@nested-missing'] }],
        },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('@nested-missing')
  })
})

// ---- referenced-template-exists ----------------------------------------

describe('referenced-template-exists', () => {
  it('flags missing template files on disk', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'gazetta-validation-'))
    try {
      const site = makeSite({ templatesDir: tdir })
      const issues = await referencedTemplateExists.validate(
        makeInput({
          site,
          storage: site.storage,
          itemKind: 'page',
          itemName: 'home',
          before: null,
          after: { template: 'no-such-template', content: {} },
        }),
      )
      expect(issues).toHaveLength(1)
      expect(issues[0].message).toContain('no-such-template')
    } finally {
      await rm(tdir, { recursive: true, force: true })
    }
  })

  it('passes when the template index.ts exists', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'gazetta-validation-'))
    try {
      await mkdir(join(tdir, 'page-default'), { recursive: true })
      await writeFile(join(tdir, 'page-default', 'index.ts'), 'export default () => ({ html: "", css: "", js: "" })')
      const site = makeSite({ templatesDir: tdir })
      const issues = await referencedTemplateExists.validate(
        makeInput({
          site,
          storage: site.storage,
          itemKind: 'page',
          itemName: 'home',
          before: null,
          after: { template: 'page-default', content: {} },
        }),
      )
      expect(issues).toEqual([])
    } finally {
      await rm(tdir, { recursive: true, force: true })
    }
  })

  it('checks every inline component template too', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'gazetta-validation-'))
    try {
      await mkdir(join(tdir, 'page-default'), { recursive: true })
      await writeFile(join(tdir, 'page-default', 'index.ts'), '')
      const site = makeSite({ templatesDir: tdir })
      const issues = await referencedTemplateExists.validate(
        makeInput({
          site,
          storage: site.storage,
          itemKind: 'page',
          itemName: 'home',
          before: null,
          after: {
            template: 'page-default',
            content: {},
            components: [{ name: 'hero', template: 'missing-inline-template', content: {} }],
          },
        }),
      )
      expect(issues).toHaveLength(1)
      expect(issues[0].message).toContain('missing-inline-template')
    } finally {
      await rm(tdir, { recursive: true, force: true })
    }
  })
})

// ---- circular-fragment -------------------------------------------------

describe('circular-fragment', () => {
  it('flags a self-referencing fragment', async () => {
    const fragments = new Map([
      [
        'cycler',
        { template: 't', components: ['@cycler'], dir: 'fragments/cycler' } as FragmentManifest & { dir: string },
      ],
    ])
    const site = makeSite({ fragments })
    const issues = await circularFragment.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'fragment',
        itemName: 'cycler',
        before: null,
        after: { template: 't', content: {}, components: ['@cycler'] },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('cycler')
  })

  it('flags a 2-hop cycle', async () => {
    const fragments = new Map<string, FragmentManifest & { dir: string }>([
      ['a', { template: 't', components: ['@b'], dir: 'fragments/a' } as FragmentManifest & { dir: string }],
      ['b', { template: 't', components: ['@a'], dir: 'fragments/b' } as FragmentManifest & { dir: string }],
    ])
    const site = makeSite({ fragments })
    const issues = await circularFragment.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'fragment',
        itemName: 'a',
        before: null,
        after: { template: 't', content: {}, components: ['@b'] },
      }),
    )
    expect(issues).toHaveLength(1)
  })

  it('passes for a non-cyclic chain', async () => {
    const fragments = new Map<string, FragmentManifest & { dir: string }>([
      ['a', { template: 't', components: ['@b'], dir: 'fragments/a' } as FragmentManifest & { dir: string }],
      ['b', { template: 't', components: [], dir: 'fragments/b' } as FragmentManifest & { dir: string }],
    ])
    const site = makeSite({ fragments })
    const issues = await circularFragment.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'fragment',
        itemName: 'a',
        before: null,
        after: { template: 't', content: {}, components: ['@b'] },
      }),
    )
    expect(issues).toEqual([])
  })

  it('only fires for fragments, not pages', async () => {
    const fragments = new Map([
      ['a', { template: 't', components: ['@a'], dir: 'fragments/a' } as FragmentManifest & { dir: string }],
    ])
    const site = makeSite({ fragments })
    const issues = await circularFragment.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, components: ['@a'] },
      }),
    )
    expect(issues).toEqual([])
  })
})

// ---- dynamic-route-conflict --------------------------------------------

describe('dynamic-route-conflict', () => {
  function pageMap(entries: Array<[string, string]>): Map<string, PageManifest & { dir: string; route: string }> {
    return new Map(
      entries.map(([name, route]) => [
        name,
        { template: 't', route, dir: `pages/${name}` } as PageManifest & { dir: string; route: string },
      ]),
    )
  }

  it('flags when a static route shadows a dynamic one', async () => {
    const pages = pageMap([['existing', '/blog/:slug']])
    const site = makeSite({ pages })
    const issues = await dynamicRouteConflict.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'new-page',
        before: null,
        after: { template: 't', content: {}, route: '/blog/hello' } as PageManifest,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('existing')
  })

  it('passes when routes are entirely different', async () => {
    const pages = pageMap([['existing', '/about']])
    const site = makeSite({ pages })
    const issues = await dynamicRouteConflict.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'new-page',
        before: null,
        after: { template: 't', content: {}, route: '/blog/hello' } as PageManifest,
      }),
    )
    expect(issues).toEqual([])
  })

  it('does not flag self', async () => {
    const pages = pageMap([['home', '/']])
    const site = makeSite({ pages })
    const issues = await dynamicRouteConflict.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, route: '/' } as PageManifest,
      }),
    )
    expect(issues).toEqual([])
  })

  it('only fires for pages', async () => {
    const pages = pageMap([['a', '/path']])
    const site = makeSite({ pages })
    const issues = await dynamicRouteConflict.validate(
      makeInput({
        site,
        storage: site.storage,
        itemKind: 'fragment',
        itemName: 'header',
        before: null,
        after: { template: 't', content: {} },
      }),
    )
    expect(issues).toEqual([])
  })
})
