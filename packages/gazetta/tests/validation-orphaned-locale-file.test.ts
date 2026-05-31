/**
 * Tests for the orphaned-locale-file validator.
 *
 * Pins:
 *   - Registry contract (source/name/stages/defaultSeverity)
 *   - Stage gates: save-delta + pre-publish scopes return []
 *   - Locale-config-absent guard: site without `locales` config returns []
 *   - Background scope: emits one issue per unsupported locale variant of
 *     THIS item; supported locales pass through silently
 *   - CLI scope: enumerates orphans across both pages AND fragments
 *   - Issue carries the orphan's filesystem path (`{dir}/{ext}.{locale}.json`)
 *
 * Per rule 26: each test gets a fresh site fixture.
 */
import { describe, expect, it } from 'vitest'
import type { FragmentManifest, PageManifest, SiteManifest, StorageProvider } from '../src/types.js'
import type { LocalizedEntry, Site } from '../src/site-loader.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { orphanedLocaleFile } from '../src/validation/validators/orphaned-locale-file.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function makeSite(overrides: Partial<Site> & { manifest?: SiteManifest } = {}): Site {
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

function withLocales(supported: string[], def = 'en'): SiteManifest {
  return { name: 'test', locales: { default: def, supported } }
}

function pageVariant(name: string, locale: string): PageManifest & { dir: string } {
  return { template: 't', content: {}, dir: `pages/${name}` } as PageManifest & { dir: string }
}
function fragVariant(name: string, locale: string): FragmentManifest & { dir: string } {
  return { template: 't', content: {}, dir: `fragments/${name}` } as FragmentManifest & { dir: string }
}

function pageLocalesEntry(
  name: string,
  locales: Record<string, PageManifest & { dir: string }>,
): LocalizedEntry<PageManifest & { dir: string }> {
  return {
    default: { template: 't', content: {}, dir: `pages/${name}` } as PageManifest & { dir: string },
    locales: new Map(Object.entries(locales)),
  }
}
function fragLocalesEntry(
  name: string,
  locales: Record<string, FragmentManifest & { dir: string }>,
): LocalizedEntry<FragmentManifest & { dir: string }> {
  return {
    default: { template: 't', content: {}, dir: `fragments/${name}` } as FragmentManifest & { dir: string },
    locales: new Map(Object.entries(locales)),
  }
}

function backgroundInput(opts: {
  site: Site
  itemKind: 'page' | 'fragment'
  itemName: string
  manifest?: PageManifest | FragmentManifest
}): ValidatorInput {
  return {
    stage: 'background',
    site: opts.site,
    contentRoot: opts.site.contentRoot,
    storage: opts.site.storage as StorageProvider,
    scope: {
      kind: 'background',
      item: {
        kind: opts.itemKind,
        name: opts.itemName,
        itemPath: `${opts.itemKind}s/${opts.itemName}/${opts.itemKind}.json`,
      },
      manifest: opts.manifest ?? ({ template: 't', content: {} } as PageManifest),
    },
  }
}

function cliInput(site: Site): ValidatorInput {
  return {
    stage: 'cli',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage as StorageProvider,
    scope: { kind: 'cli' },
  }
}

function saveDeltaInput(site: Site): ValidatorInput {
  return {
    stage: 'save-delta',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage as StorageProvider,
    scope: {
      kind: 'save-delta',
      item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' },
      before: null,
      after: { template: 't', content: {} } as PageManifest,
    },
  }
}

function prePublishInput(site: Site): ValidatorInput {
  return {
    stage: 'pre-publish',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage as StorageProvider,
    scope: {
      kind: 'pre-publish',
      items: [{ kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }],
    },
  }
}

describe('orphanedLocaleFile — registry contract', () => {
  // Counterfactual: rename in impl → consumers filtering by name silently
  // miss this validator's issues.
  it('declares stable identity (source=gazetta, name=orphaned-locale-file)', () => {
    expect(orphanedLocaleFile.source).toBe('gazetta')
    expect(orphanedLocaleFile.name).toBe('orphaned-locale-file')
  })

  it('runs at background and cli stages only', () => {
    // Counterfactual: adding save-delta would force the validator to walk a
    // per-edit scope it has no semantics for; adding pre-publish would
    // dup-fire on every publish gate run.
    expect(orphanedLocaleFile.stages).toEqual(['background', 'cli'])
  })

  it('warns by default at every supported stage', () => {
    // Counterfactual: bumping to error would block publish on legitimate
    // dead locale files; demoting to info would hide the orphan from the
    // site-health drawer.
    expect(orphanedLocaleFile.defaultSeverity('background')).toBe('warn')
    expect(orphanedLocaleFile.defaultSeverity('cli')).toBe('warn')
  })
})

describe('orphanedLocaleFile — stage gates', () => {
  it('save-delta scope returns no issues', async () => {
    // Counterfactual: removing the gate would attempt to read
    // scope.item from save-delta which exists but lacks the locale-variant
    // map traversal — would either return spurious data or crash on
    // missing fields.
    const site = makeSite({ manifest: withLocales(['en']) })
    const issues = await orphanedLocaleFile.validate(saveDeltaInput(site))
    expect(issues).toEqual([])
  })

  it('pre-publish scope returns no issues', async () => {
    const site = makeSite({ manifest: withLocales(['en']) })
    const issues = await orphanedLocaleFile.validate(prePublishInput(site))
    expect(issues).toEqual([])
  })
})

describe('orphanedLocaleFile — locale config absent', () => {
  it('returns no issues when site has no `locales` config', async () => {
    // Counterfactual: removing the `if (!resolved) return []` early-return
    // would attempt to read `resolved.supported` (undefined) and throw.
    const site = makeSite({
      pageLocales: new Map([['home', pageLocalesEntry('home', { fr: pageVariant('home', 'fr') })]]),
    })
    const issues = await orphanedLocaleFile.validate(backgroundInput({ site, itemKind: 'page', itemName: 'home' }))
    expect(issues).toEqual([])
  })
})

describe('orphanedLocaleFile — background scope (per-item)', () => {
  it('flags an unsupported locale variant of THIS page', async () => {
    // Site supports en + fr; the page has a `de` variant that's not
    // configured. Background scope on the page should surface the orphan.
    //
    // Counterfactual: if the supported-set check were inverted (flagged
    // supported locales instead), the test would fail because `de` would
    // not appear in the issue set OR `fr` would.
    const site = makeSite({
      manifest: withLocales(['en', 'fr']),
      pageLocales: new Map([
        [
          'home',
          pageLocalesEntry('home', {
            fr: pageVariant('home', 'fr'),
            de: pageVariant('home', 'de'),
          }),
        ],
      ]),
    })
    const issues = await orphanedLocaleFile.validate(backgroundInput({ site, itemKind: 'page', itemName: 'home' }))
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('orphaned-locale-file')
    expect(issues[0].severity).toBe('warn')
    expect(issues[0].itemPath).toBe('pages/home/page.de.json')
    expect(issues[0].message).toContain('de')
  })

  it('does not flag a supported locale variant', async () => {
    // Counterfactual: regression in the `supported.has(locale)` check; the
    // `continue` becoming a `flag` would surface this.
    const site = makeSite({
      manifest: withLocales(['en', 'fr']),
      pageLocales: new Map([['home', pageLocalesEntry('home', { fr: pageVariant('home', 'fr') })]]),
    })
    const issues = await orphanedLocaleFile.validate(backgroundInput({ site, itemKind: 'page', itemName: 'home' }))
    expect(issues).toEqual([])
  })

  it('does not flag siblings of an unrelated item in background scope', async () => {
    // Two pages, both with orphan French variants. Background scope on
    // `home` should NOT emit issues for `about` — that's CLI's job.
    //
    // Counterfactual: if background scope leaked CLI behavior (iterated
    // all pageLocales entries), both pages' orphans would surface here.
    const site = makeSite({
      manifest: withLocales(['en']),
      pageLocales: new Map([
        ['home', pageLocalesEntry('home', { fr: pageVariant('home', 'fr') })],
        ['about', pageLocalesEntry('about', { fr: pageVariant('about', 'fr') })],
      ]),
    })
    const issues = await orphanedLocaleFile.validate(backgroundInput({ site, itemKind: 'page', itemName: 'home' }))
    expect(issues).toHaveLength(1)
    expect(issues[0].itemPath).toBe('pages/home/page.fr.json')
  })

  it('flags fragment locale variants symmetrically', async () => {
    // Counterfactual: if background scope dispatched only to pageLocales,
    // fragment orphans would be missed.
    const site = makeSite({
      manifest: withLocales(['en']),
      fragmentLocales: new Map([['header', fragLocalesEntry('header', { fr: fragVariant('header', 'fr') })]]),
    })
    const issues = await orphanedLocaleFile.validate(
      backgroundInput({ site, itemKind: 'fragment', itemName: 'header' }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].itemPath).toBe('fragments/header/fragment.fr.json')
  })

  it('returns no issues when the item has no locale variants', async () => {
    // Counterfactual: removing the `if (!variants) return []` guard would
    // attempt to iterate undefined and throw.
    const site = makeSite({
      manifest: withLocales(['en', 'fr']),
      pageLocales: new Map(),
    })
    const issues = await orphanedLocaleFile.validate(backgroundInput({ site, itemKind: 'page', itemName: 'home' }))
    expect(issues).toEqual([])
  })
})

describe('orphanedLocaleFile — CLI scope (site-wide)', () => {
  it('enumerates orphans across both pages AND fragments', async () => {
    // Site supports en only; one page and one fragment each carry an
    // unsupported `fr` variant. CLI scope should surface both.
    //
    // Counterfactual: if the CLI loop dropped fragments (only walked
    // pageLocales), the fragment orphan would be missed; the assertion on
    // both file paths would fail.
    const site = makeSite({
      manifest: withLocales(['en']),
      pageLocales: new Map([['home', pageLocalesEntry('home', { fr: pageVariant('home', 'fr') })]]),
      fragmentLocales: new Map([['header', fragLocalesEntry('header', { fr: fragVariant('header', 'fr') })]]),
    })
    const issues = await orphanedLocaleFile.validate(cliInput(site))
    expect(issues).toHaveLength(2)
    const paths = issues.map(i => i.itemPath).sort()
    expect(paths).toEqual(['fragments/header/fragment.fr.json', 'pages/home/page.fr.json'])
    for (const issue of issues) {
      expect(issue.validator).toBe('orphaned-locale-file')
      expect(issue.severity).toBe('warn')
    }
  })

  it('returns no issues when every variant is supported', async () => {
    // Counterfactual: blanket-emitting (regardless of supported check)
    // would surface here.
    const site = makeSite({
      manifest: withLocales(['en', 'fr', 'de']),
      pageLocales: new Map([
        [
          'home',
          pageLocalesEntry('home', {
            fr: pageVariant('home', 'fr'),
            de: pageVariant('home', 'de'),
          }),
        ],
      ]),
    })
    const issues = await orphanedLocaleFile.validate(cliInput(site))
    expect(issues).toEqual([])
  })
})
