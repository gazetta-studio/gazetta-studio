/**
 * Tests for the unused-fragment validator.
 *
 * Pins:
 *   - Registry contract (source/name/stages/defaultSeverity=info)
 *   - Stage gates: save-delta + pre-publish return []
 *   - Background scope on a page item returns [] (validator is
 *     fragments-only)
 *   - Background scope on an unreferenced fragment emits one info issue
 *   - Background scope on a fragment referenced by a page (top-level OR
 *     nested inline component) returns []
 *   - Fragment-to-fragment references count as "used"
 *   - CLI scope enumerates every orphan with one issue per fragment
 *
 * Per rule 26: each test gets a fresh site fixture.
 */
import { describe, expect, it } from 'vitest'
import type { FragmentManifest, PageManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { unusedFragment } from '../src/validation/validators/unused-fragment.js'
import { memoryStorage } from './_helpers/memory-storage.js'

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

function frag(name: string): FragmentManifest & { dir: string } {
  return { template: 't', content: {}, dir: `fragments/${name}` } as FragmentManifest & { dir: string }
}
function page(content: Partial<PageManifest> = {}): PageManifest & { dir: string } {
  return { template: 't', content: {}, ...content, dir: 'pages/home' } as PageManifest & { dir: string }
}

function backgroundInput(opts: { site: Site; itemKind: 'page' | 'fragment'; itemName: string }): ValidatorInput {
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
      manifest: { template: 't', content: {} } as PageManifest,
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
      item: { kind: 'fragment', name: 'lonely', itemPath: 'fragments/lonely/fragment.json' },
      before: null,
      after: { template: 't', content: {} } as FragmentManifest,
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
      items: [{ kind: 'fragment', name: 'lonely', itemPath: 'fragments/lonely/fragment.json' }],
    },
  }
}

describe('unusedFragment — registry contract', () => {
  it('declares stable identity (source=gazetta, name=unused-fragment)', () => {
    expect(unusedFragment.source).toBe('gazetta')
    expect(unusedFragment.name).toBe('unused-fragment')
  })

  it('runs at background and cli stages only', () => {
    // Counterfactual: adding save-delta would require per-edit reasoning
    // about "was this the last ref?" which the validator doesn't compute.
    expect(unusedFragment.stages).toEqual(['background', 'cli'])
  })

  it('defaults to info severity (operators legitimately keep WIP fragments)', () => {
    // Counterfactual: bumping to warn would surface noisy "this fragment
    // isn't used yet" warnings during normal development. Info severity is
    // the locked design — see source comment for rationale.
    expect(unusedFragment.defaultSeverity('background')).toBe('info')
    expect(unusedFragment.defaultSeverity('cli')).toBe('info')
  })
})

describe('unusedFragment — stage gates', () => {
  it('save-delta scope returns no issues', async () => {
    const site = makeSite({ fragments: new Map([['lonely', frag('lonely')]]) })
    const issues = await unusedFragment.validate(saveDeltaInput(site))
    expect(issues).toEqual([])
  })

  it('pre-publish scope returns no issues', async () => {
    const site = makeSite({ fragments: new Map([['lonely', frag('lonely')]]) })
    const issues = await unusedFragment.validate(prePublishInput(site))
    expect(issues).toEqual([])
  })
})

describe('unusedFragment — background scope', () => {
  it('returns [] when the background item is a page (validator is fragment-only)', async () => {
    // Counterfactual: removing the `scope.item.kind !== 'fragment'` guard
    // would emit "fragment is unused" issues on page items where the
    // contract makes no sense. Test fails by emitting issues.
    const site = makeSite({ fragments: new Map([['lonely', frag('lonely')]]) })
    const issues = await unusedFragment.validate(backgroundInput({ site, itemKind: 'page', itemName: 'home' }))
    expect(issues).toEqual([])
  })

  it('emits one info issue for a fragment that no page references', async () => {
    // Counterfactual: if the validator started ignoring its own item
    // (only walking referenced set), this returns []. If severity flipped
    // to warn, the severity assertion fails.
    const site = makeSite({ fragments: new Map([['lonely', frag('lonely')]]) })
    const issues = await unusedFragment.validate(backgroundInput({ site, itemKind: 'fragment', itemName: 'lonely' }))
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('unused-fragment')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].itemPath).toBe('fragments/lonely/fragment.json')
    expect(issues[0].message).toContain('@lonely')
  })

  it('does not flag a fragment referenced as a top-level @ref in a page', async () => {
    // Counterfactual: if walkFragmentRefs stopped extracting top-level
    // string entries starting with `@`, this fragment would be wrongly
    // flagged orphan.
    const site = makeSite({
      pages: new Map([['home', page({ components: ['@header'] })]]),
      fragments: new Map([['header', frag('header')]]),
    })
    const issues = await unusedFragment.validate(backgroundInput({ site, itemKind: 'fragment', itemName: 'header' }))
    expect(issues).toEqual([])
  })

  it('does not flag a fragment referenced via a nested inline component', async () => {
    // Inline component carries `@header` inside its own components array.
    // Walker must recurse into inline components to find the ref.
    //
    // Counterfactual: if walkFragmentRefs stopped recursing into
    // inline.components, `header` would be wrongly flagged orphan. This
    // is a real failure mode (rule 18: walk recursive structures
    // recursively) — pinning it here.
    const site = makeSite({
      pages: new Map([
        [
          'home',
          page({
            components: [
              {
                template: 'page-default',
                name: 'main',
                content: {},
                components: ['@header'],
              },
            ],
          }),
        ],
      ]),
      fragments: new Map([['header', frag('header')]]),
    })
    const issues = await unusedFragment.validate(backgroundInput({ site, itemKind: 'fragment', itemName: 'header' }))
    expect(issues).toEqual([])
  })

  it('does not flag a fragment referenced by another fragment (fragment-to-fragment)', async () => {
    // The walker must consider fragment->fragment refs, not just page->fragment.
    //
    // Counterfactual: if collectReferencedFragments only iterated
    // site.pages, fragment-to-fragment refs would be missed and `logo`
    // would be wrongly orphan.
    const site = makeSite({
      fragments: new Map([
        ['header', { ...frag('header'), components: ['@logo'] } as FragmentManifest & { dir: string }],
        ['logo', frag('logo')],
      ]),
    })
    const issues = await unusedFragment.validate(backgroundInput({ site, itemKind: 'fragment', itemName: 'logo' }))
    expect(issues).toEqual([])
  })
})

describe('unusedFragment — CLI scope', () => {
  it('enumerates every orphan fragment with one issue each', async () => {
    // Three fragments: `header` referenced; `lonely-1` + `lonely-2`
    // orphaned. CLI should surface two issues, one per orphan.
    //
    // Counterfactual: if CLI scope dropped `continue` on referenced
    // fragments, all three would be flagged.
    const site = makeSite({
      pages: new Map([['home', page({ components: ['@header'] })]]),
      fragments: new Map([
        ['header', frag('header')],
        ['lonely-1', frag('lonely-1')],
        ['lonely-2', frag('lonely-2')],
      ]),
    })
    const issues = await unusedFragment.validate(cliInput(site))
    expect(issues).toHaveLength(2)
    const paths = issues.map(i => i.itemPath).sort()
    expect(paths).toEqual(['fragments/lonely-1/fragment.json', 'fragments/lonely-2/fragment.json'])
    for (const issue of issues) {
      expect(issue.severity).toBe('info')
      expect(issue.validator).toBe('unused-fragment')
    }
  })

  it('returns no issues when every fragment is referenced', async () => {
    // Counterfactual: if CLI emitted issues regardless of reference
    // status, this returns issues and fails.
    const site = makeSite({
      pages: new Map([['home', page({ components: ['@header'] })]]),
      fragments: new Map([['header', frag('header')]]),
    })
    const issues = await unusedFragment.validate(cliInput(site))
    expect(issues).toEqual([])
  })
})
