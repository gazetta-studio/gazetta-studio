/**
 * #1062: the background validators' own checks, called through `validate()`
 * with the exact `Issue[]` they return. Sites are built in memory per test;
 * templates are files because the template loader reads only from disk.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schemaConformance } from '../src/validation/validators/schema-conformance.js'
import { orphanedLocaleFile } from '../src/validation/validators/orphaned-locale-file.js'
import { unusedFragment } from '../src/validation/validators/unused-fragment.js'
import { createContentRoot } from '../src/content-root.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'
import type { Site } from '../src/site-loader.js'
import type { FragmentManifest, PageManifest, SiteManifest } from '../src/types.js'
import type { SavedItem, ValidatorInput } from '../src/validation/types.js'

type Page = PageManifest & { dir: string }
type Fragment = FragmentManifest & { dir: string }

function makeSite(opts: {
  manifest?: Partial<SiteManifest>
  pages?: Record<string, Page>
  fragments?: Record<string, Fragment>
  pageLocales?: Record<string, Record<string, Page>>
  fragmentLocales?: Record<string, Record<string, Fragment>>
  templatesDir?: string
}): Site {
  const storage = memoryStorage()
  const pages = new Map(Object.entries(opts.pages ?? {}))
  const fragments = new Map(Object.entries(opts.fragments ?? {}))
  const pageLocales = new Map(
    Object.entries(opts.pageLocales ?? {}).map(([name, locales]) => [
      name,
      { default: pages.get(name) as Page, locales: new Map(Object.entries(locales)) },
    ]),
  )
  const fragmentLocales = new Map(
    Object.entries(opts.fragmentLocales ?? {}).map(([name, locales]) => [
      name,
      { default: fragments.get(name) as Fragment, locales: new Map(Object.entries(locales)) },
    ]),
  )
  return {
    manifest: { name: 'test', ...opts.manifest } as SiteManifest,
    pages,
    fragments,
    pageLocales,
    fragmentLocales,
    contentRoot: createContentRoot(storage, ''),
    storage,
    siteDir: '',
    templatesDir: opts.templatesDir ?? '',
    cache: undefined as never,
  }
}

function backgroundInput(site: Site, item: SavedItem, manifest: PageManifest | FragmentManifest): ValidatorInput {
  return {
    stage: 'background',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage,
    scope: { kind: 'background', item, manifest },
  }
}

function cliInput(site: Site): ValidatorInput {
  return { stage: 'cli', site, contentRoot: site.contentRoot, storage: site.storage, scope: { kind: 'cli' } }
}

const homeItem: SavedItem = { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }

describe('schema-conformance', () => {
  const dir = tempDir(`validators-background-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const templatesDir = join(dir, 'templates')

  beforeAll(async () => {
    await mkdir(join(templatesDir, 'hero'), { recursive: true })
    await writeFile(
      join(templatesDir, 'hero/index.ts'),
      [
        "import { z } from 'zod'",
        'export const schema = z.object({ title: z.string(), count: z.number().optional() })',
        "export default () => ({ html: '', css: '', js: '' })",
        '',
      ].join('\n'),
    )
    await mkdir(join(templatesDir, 'loose'), { recursive: true })
    await writeFile(
      join(templatesDir, 'loose/index.ts'),
      "export const schema = { notZod: true }\nexport default () => ({ html: '', css: '', js: '' })\n",
    )
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('declares the stages and severities of design-validation.md', () => {
    expect(schemaConformance.stages).toEqual(['save-delta', 'background', 'pre-publish', 'cli'])
    expect(schemaConformance.defaultSeverity('save-delta')).toBe('error')
    expect(schemaConformance.defaultSeverity('pre-publish')).toBe('error')
    expect(schemaConformance.defaultSeverity('background')).toBe('warn')
  })

  it('reports nothing for content that matches its schema', async () => {
    const site = makeSite({ templatesDir })
    const manifest = {
      route: '/',
      template: 'hero',
      content: { title: 'Home' },
      components: [{ name: 'banner', template: 'hero', content: { title: 'Hi', count: 2 } }],
    } as PageManifest
    expect(await schemaConformance.validate(backgroundInput(site, homeItem, manifest))).toEqual([])
  })

  it('reports a missing required field on a nested component, with its path and the background severity', async () => {
    const site = makeSite({ templatesDir })
    const manifest = {
      route: '/',
      template: 'no-content-template',
      components: [
        {
          name: 'section',
          template: 'no-content-template',
          components: [{ name: 'banner', template: 'hero', content: {} }],
        },
      ],
    } as unknown as PageManifest
    const issues = await schemaConformance.validate(backgroundInput(site, homeItem, manifest))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      validator: 'schema-conformance',
      severity: 'warn',
      itemPath: 'pages/home/page.json',
      contentPath: 'section/banner',
      field: 'title',
    })
    expect(issues[0].message).toMatch(/^title: /)
  })

  it('reports a wrong type on the manifest root content, without a content path', async () => {
    const site = makeSite({ templatesDir })
    const manifest = { route: '/', template: 'hero', content: { title: 'Home', count: 'two' } } as PageManifest
    const issues = await schemaConformance.validate(backgroundInput(site, homeItem, manifest))
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'warn', itemPath: 'pages/home/page.json', field: 'count' }),
    ])
    expect(issues[0].contentPath).toBeUndefined()
  })

  it('leaves an unknown template to referenced-template-exists, and skips fragment refs', async () => {
    const site = makeSite({ templatesDir })
    const manifest = {
      route: '/',
      template: 'no-such-template',
      content: {},
      components: ['@header', { name: 'x', template: 'no-such-template', content: { bad: 1 } }],
    } as PageManifest
    expect(await schemaConformance.validate(backgroundInput(site, homeItem, manifest))).toEqual([])
  })

  it('reports a template whose schema is not a Zod schema once per item', async () => {
    const site = makeSite({ templatesDir })
    const manifest = {
      route: '/',
      template: 'page',
      components: [
        { name: 'a', template: 'loose', content: {} },
        { name: 'b', template: 'loose', content: {} },
      ],
    } as PageManifest
    const issues = await schemaConformance.validate(backgroundInput(site, homeItem, manifest))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', contentPath: 'a' })
    expect(issues[0].message).toContain('its schema is not a Zod schema')
  })

  it('reports nothing when the site has no templates folder', async () => {
    const site = makeSite({})
    const manifest = { route: '/', template: 'hero', content: {} } as PageManifest
    expect(await schemaConformance.validate(backgroundInput(site, homeItem, manifest))).toEqual([])
  })

  it('checks every page and fragment at the cli stage', async () => {
    const site = makeSite({
      templatesDir,
      pages: { home: { route: '/', template: 'hero', content: {}, dir: 'pages/home' } as Page },
      fragments: { header: { template: 'hero', content: { title: 1 }, dir: 'fragments/header' } as Fragment },
    })
    const issues = await schemaConformance.validate(cliInput(site))
    expect(issues.map(i => [i.itemPath, i.field])).toEqual([
      ['pages/home/page.json', 'title'],
      ['fragments/header/fragment.json', 'title'],
    ])
  })

  it('reports nothing at pre-publish', async () => {
    const site = makeSite({ templatesDir })
    const input: ValidatorInput = {
      stage: 'pre-publish',
      site,
      contentRoot: site.contentRoot,
      storage: site.storage,
      scope: { kind: 'pre-publish', items: [homeItem] },
    }
    expect(await schemaConformance.validate(input)).toEqual([])
  })

  it('at save-delta, errors on a touched component and on a touched one whose schema is not Zod', async () => {
    const site = makeSite({ templatesDir })
    const after = {
      route: '/',
      template: 'page',
      components: [
        { name: 'banner', template: 'hero', content: {} },
        { name: 'odd', template: 'loose', content: {} },
        { name: 'gone', template: 'no-such-template', content: {} },
      ],
    } as PageManifest
    const input: ValidatorInput = {
      stage: 'save-delta',
      site,
      contentRoot: site.contentRoot,
      storage: site.storage,
      scope: { kind: 'save-delta', item: homeItem, before: null, after },
    }
    const issues = await schemaConformance.validate(input)
    expect(issues.map(i => [i.contentPath, i.severity, i.field])).toEqual([
      ['banner', 'error', 'title'],
      ['odd', 'error', undefined],
    ])
  })
})

describe('orphaned-locale-file', () => {
  const locales = { manifest: { locales: { default: 'en', supported: ['en', 'fr'] } } as Partial<SiteManifest> }
  const home = { route: '/', template: 'page', dir: 'pages/home' } as Page
  const header = { template: 'header', dir: 'fragments/header' } as Fragment

  it('runs in the background scan and gazetta validate, as a warning', () => {
    expect(orphanedLocaleFile.stages).toEqual(['background', 'cli'])
    expect(orphanedLocaleFile.defaultSeverity('background')).toBe('warn')
  })

  it('reports nothing for a page variant in a supported locale', async () => {
    const site = makeSite({ ...locales, pages: { home }, pageLocales: { home: { fr: home } } })
    expect(await orphanedLocaleFile.validate(backgroundInput(site, homeItem, home))).toEqual([])
  })

  it('reports a page variant whose locale the site does not support, on the variant file', async () => {
    const site = makeSite({ ...locales, pages: { home }, pageLocales: { home: { fr: home, de: home } } })
    const issues = await orphanedLocaleFile.validate(backgroundInput(site, homeItem, home))
    expect(issues).toEqual([
      {
        validator: 'orphaned-locale-file',
        severity: 'warn',
        message: expect.stringContaining('"de"'),
        itemPath: 'pages/home/page.de.json',
      },
    ])
  })

  it('reports a fragment variant whose locale the site does not support', async () => {
    const site = makeSite({ ...locales, fragments: { header }, fragmentLocales: { header: { es: header } } })
    const item: SavedItem = { kind: 'fragment', name: 'header', itemPath: 'fragments/header/fragment.json' }
    const issues = await orphanedLocaleFile.validate(backgroundInput(site, item, header))
    expect(issues.map(i => i.itemPath)).toEqual(['fragments/header/fragment.es.json'])
  })

  it('reports nothing for an item without variants, or on a site without locales', async () => {
    expect(
      await orphanedLocaleFile.validate(backgroundInput(makeSite({ ...locales, pages: { home } }), homeItem, home)),
    ).toEqual([])
    const noLocales = makeSite({ pages: { home }, pageLocales: { home: { de: home } } })
    expect(await orphanedLocaleFile.validate(backgroundInput(noLocales, homeItem, home))).toEqual([])
  })

  it('lists every unsupported variant across the site at the cli stage', async () => {
    const site = makeSite({
      ...locales,
      pages: { home },
      fragments: { header },
      pageLocales: { home: { fr: home, de: home } },
      fragmentLocales: { header: { es: header } },
    })
    const issues = await orphanedLocaleFile.validate(cliInput(site))
    expect(issues.map(i => [i.itemPath, i.severity])).toEqual([
      ['pages/home/page.de.json', 'warn'],
      ['fragments/header/fragment.es.json', 'warn'],
    ])
  })
})

describe('unused-fragment', () => {
  const fragItem = (name: string): SavedItem => ({
    kind: 'fragment',
    name,
    itemPath: `fragments/${name}/fragment.json`,
  })

  it('runs in the background scan and gazetta validate, as info', () => {
    expect(unusedFragment.stages).toEqual(['background', 'cli'])
    expect(unusedFragment.defaultSeverity('background')).toBe('info')
  })

  const header = { template: 'header', dir: 'fragments/header', components: ['@logo'] } as Fragment
  const logo = { template: 'logo', dir: 'fragments/logo' } as Fragment
  const orphan = { template: 'promo', dir: 'fragments/orphan' } as Fragment
  const home = {
    route: '/',
    template: 'page',
    dir: 'pages/home',
    components: [{ name: 'layout', template: 'layout', components: ['@header'] }],
  } as Page

  const site = () => makeSite({ pages: { home }, fragments: { header, logo, orphan } })

  it('reports nothing for a fragment a page uses, even inside an inline component', async () => {
    expect(await unusedFragment.validate(backgroundInput(site(), fragItem('header'), header))).toEqual([])
  })

  it('counts a fragment used only by another fragment as used', async () => {
    expect(await unusedFragment.validate(backgroundInput(site(), fragItem('logo'), logo))).toEqual([])
  })

  it('reports a fragment nothing uses, as info on the fragment', async () => {
    expect(await unusedFragment.validate(backgroundInput(site(), fragItem('orphan'), orphan))).toEqual([
      {
        validator: 'unused-fragment',
        severity: 'info',
        message: 'Fragment "@orphan" is defined but no page or fragment references it.',
        itemPath: 'fragments/orphan/fragment.json',
      },
    ])
  })

  it('reports nothing when the scanned item is a page', async () => {
    expect(await unusedFragment.validate(backgroundInput(site(), homeItem, home))).toEqual([])
  })

  it('lists every unused fragment at the cli stage', async () => {
    const issues = await unusedFragment.validate(cliInput(site()))
    expect(issues.map(i => [i.itemPath, i.severity])).toEqual([['fragments/orphan/fragment.json', 'info']])
  })
})
