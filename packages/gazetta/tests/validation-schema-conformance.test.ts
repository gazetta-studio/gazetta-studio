/**
 * Tests for the schema-conformance validator.
 *
 * Pins:
 *   - Registry contract (source/name/stages/defaultSeverity per stage)
 *   - Stage gates: save-delta + pre-publish scope kinds return [] (validator
 *     declares pre-publish in `stages` but only background and cli walk; the
 *     pre-publish gate is the publish-audit caller, not this validator's body)
 *   - templatesDir-absent guard returns [] without throwing
 *   - Zod error path: invalid manifest content against the banner template's
 *     required `heading` field produces one issue per zod error, surfaced on
 *     the right itemPath with severity `warn`
 *   - CLI scope walks pages AND fragments
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh site fixture;
 * no module-level state beyond the shared `starterTemplatesDir` constant
 * (read-only path pointer; not mutable shared state).
 */
import { describe, expect, it } from 'vitest'
import type { FragmentManifest, PageManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { schemaConformance } from '../src/validation/validators/schema-conformance.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

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
    templatesDir: starterTemplatesDir,
    ...overrides,
  } as Site
}

function backgroundInput(opts: {
  site: Site
  itemKind: 'page' | 'fragment'
  itemName: string
  manifest: PageManifest | FragmentManifest
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
      manifest: opts.manifest,
    },
  }
}

function saveDeltaInput(opts: { site: Site; after: PageManifest }): ValidatorInput {
  return {
    stage: 'save-delta',
    site: opts.site,
    contentRoot: opts.site.contentRoot,
    storage: opts.site.storage as StorageProvider,
    scope: {
      kind: 'save-delta',
      item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' },
      before: null,
      after: opts.after,
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

function cliInput(site: Site): ValidatorInput {
  return {
    stage: 'cli',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage as StorageProvider,
    scope: { kind: 'cli' },
  }
}

describe('schemaConformance — registry contract', () => {
  // Counterfactual: if name/source/stages were renamed in the impl, the
  // validator registry would still register it but consumers filtering by
  // `name === 'schema-conformance'` would silently break. This test fails
  // under that mutation.
  it('declares stable identity (source=gazetta, name=schema-conformance)', () => {
    expect(schemaConformance.source).toBe('gazetta')
    expect(schemaConformance.name).toBe('schema-conformance')
  })

  it('runs at background, pre-publish, and cli stages (not save-delta)', () => {
    // Counterfactual: if save-delta were accidentally added, the publish-gate
    // semantics ("form's own Zod runs at save") would dup-fire and authors
    // would see schema warnings during normal save flows.
    expect(schemaConformance.stages).toEqual(['background', 'pre-publish', 'cli'])
  })

  it('promotes severity to error at pre-publish; warn elsewhere', () => {
    // Counterfactual: if the policy flipped (warn at pre-publish), strict
    // operators relying on the publish gate to block on schema drift would
    // see silent warns instead.
    expect(schemaConformance.defaultSeverity('pre-publish')).toBe('error')
    expect(schemaConformance.defaultSeverity('background')).toBe('warn')
    expect(schemaConformance.defaultSeverity('cli')).toBe('warn')
    expect(schemaConformance.defaultSeverity('save-delta')).toBe('warn')
  })
})

describe('schemaConformance — stage gates', () => {
  it('save-delta scope returns no issues (form-side Zod handles this stage)', async () => {
    // Counterfactual: removing the `if (scope.kind !== 'background' && scope.kind !== 'cli') return []`
    // early-return would attempt to walk a save-delta scope without `.manifest` —
    // either throw or emit spurious issues. Either failure surfaces here.
    const site = makeSite()
    const issues = await schemaConformance.validate(
      saveDeltaInput({ site, after: { template: 'banner', content: {} } }),
    )
    expect(issues).toEqual([])
  })

  it('pre-publish scope returns no issues (publish-audit caller iterates items separately)', async () => {
    // Counterfactual: same as save-delta — pre-publish scope's shape differs
    // (no .item, no .manifest); a removed gate would crash or emit garbage.
    const site = makeSite()
    const issues = await schemaConformance.validate(prePublishInput(site))
    expect(issues).toEqual([])
  })

  it('returns no issues when templatesDir is unset', async () => {
    // Counterfactual: removing the `if (!templatesDir) return []` guard would
    // call loadTemplate with `''`, throwing; the failure would surface as a
    // rejected promise here.
    const site = makeSite({ templatesDir: '' })
    const issues = await schemaConformance.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { template: 'banner', content: { heading: 'Hi' } },
      }),
    )
    expect(issues).toEqual([])
  })
})

describe('schemaConformance — zod error surfacing', () => {
  it('flags a missing required field with one issue per zod error', async () => {
    // The banner template's schema requires `heading: string`. Passing
    // `content: {}` triggers a zod "invalid_type"/required-key error.
    //
    // Counterfactual: if the impl swallowed zod errors (e.g., always
    // returned `parsed.success ? [] : []`), this would return zero issues
    // and the test would fail. If it emitted the wrong validator name, the
    // `i.validator === 'schema-conformance'` assertion would fail.
    const site = makeSite()
    const issues = await schemaConformance.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { template: 'banner', content: {} },
      }),
    )
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(issue.validator).toBe('schema-conformance')
      expect(issue.severity).toBe('warn')
      expect(issue.itemPath).toBe('pages/home/page.json')
    }
    // The zod error mentions the failing field ('heading').
    expect(issues.some(i => i.message.includes('heading'))).toBe(true)
  })

  it('valid content against the template schema produces no issues', async () => {
    // Counterfactual: if the impl inverted success/failure (treating valid
    // content as failed), this returns issues and the test fails.
    const site = makeSite()
    const issues = await schemaConformance.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { template: 'banner', content: { heading: 'Welcome' } },
      }),
    )
    expect(issues).toEqual([])
  })

  it('manifest without a template field is skipped silently', async () => {
    // Counterfactual: removing the `manifest.template && manifest.content !== undefined`
    // guard would call checkOne with empty template name, which would throw
    // inside loadTemplate.
    const site = makeSite()
    const issues = await schemaConformance.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { content: { heading: 'Welcome' } } as PageManifest,
      }),
    )
    expect(issues).toEqual([])
  })

  it('manifest referencing a non-existent template is skipped (referenced-template-exists owns that rule)', async () => {
    // Counterfactual: if safeLoadTemplate stopped catching the throw, this
    // promise would reject. Test would fail with the underlying load error.
    // Separately: if this validator started emitting a "template missing"
    // issue, it would step on referenced-template-exists's contract.
    const site = makeSite()
    const issues = await schemaConformance.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { template: 'does-not-exist-template-name', content: { heading: 'X' } },
      }),
    )
    expect(issues).toEqual([])
  })
})

describe('schemaConformance — CLI scope walks pages and fragments', () => {
  it('walks every page in site.pages', async () => {
    // Two pages, one valid + one invalid against banner schema. CLI should
    // surface the invalid one.
    //
    // Counterfactual: if CLI scope stopped iterating site.pages (e.g., only
    // walked fragments), the invalid page's issue would not appear.
    const site = makeSite({
      pages: new Map<string, PageManifest & { dir: string }>([
        [
          'home',
          { template: 'banner', content: { heading: 'Hi' }, dir: 'pages/home' } as PageManifest & { dir: string },
        ],
        ['broken', { template: 'banner', content: {}, dir: 'pages/broken' } as PageManifest & { dir: string }],
      ]),
    })
    const issues = await schemaConformance.validate(cliInput(site))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(i => i.itemPath.startsWith('pages/broken/'))).toBe(true)
    expect(issues.some(i => i.itemPath === 'pages/broken/page.json')).toBe(true)
  })

  it('walks every fragment in site.fragments', async () => {
    // Counterfactual: if CLI scope only walked pages, the fragment's
    // invalid content wouldn't be flagged.
    const site = makeSite({
      fragments: new Map<string, FragmentManifest & { dir: string }>([
        [
          'broken-frag',
          {
            template: 'banner',
            content: {},
            dir: 'fragments/broken-frag',
          } as FragmentManifest & { dir: string },
        ],
      ]),
    })
    const issues = await schemaConformance.validate(cliInput(site))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some(i => i.itemPath === 'fragments/broken-frag/fragment.json')).toBe(true)
  })
})
