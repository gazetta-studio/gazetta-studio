/**
 * Tests for the circular-fragment validator.
 *
 * Pins:
 *   - Registry contract (source/name/stages/defaultSeverity=error)
 *   - Stage gates: pre-publish + cli scopes return [] (only save-delta
 *     and background actually walk; the CLI-style traversal is the
 *     site-loader's job)
 *   - Item-kind gate: returns [] for pages (pages can't form cycles via
 *     @ refs)
 *   - Background scope finds no cycle in a linear chain
 *   - Background scope finds a self-cycle (@selfname)
 *   - Background scope finds a transitive A → B → A cycle
 *   - Save-delta scope substitutes the to-be-saved manifest into the
 *     site view (catches a cycle introduced by THIS save against the
 *     would-be state, not the on-disk state)
 *
 * Per rule 26: each test gets a fresh site fixture.
 */
import { describe, expect, it } from 'vitest'
import type { FragmentManifest, PageManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { circularFragment } from '../src/validation/validators/circular-fragment.js'
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

function frag(name: string, components: FragmentManifest['components'] = []): FragmentManifest & { dir: string } {
  return {
    template: 't',
    content: {},
    components,
    dir: `fragments/${name}`,
  } as FragmentManifest & { dir: string }
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

function saveDeltaInput(opts: {
  site: Site
  itemKind: 'page' | 'fragment'
  itemName: string
  after: PageManifest | FragmentManifest
}): ValidatorInput {
  return {
    stage: 'save-delta',
    site: opts.site,
    contentRoot: opts.site.contentRoot,
    storage: opts.site.storage as StorageProvider,
    scope: {
      kind: 'save-delta',
      item: {
        kind: opts.itemKind,
        name: opts.itemName,
        itemPath: `${opts.itemKind}s/${opts.itemName}/${opts.itemKind}.json`,
      },
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
      items: [{ kind: 'fragment', name: 'a', itemPath: 'fragments/a/fragment.json' }],
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

describe('circularFragment — registry contract', () => {
  it('declares stable identity (source=gazetta, name=circular-fragment)', () => {
    expect(circularFragment.source).toBe('gazetta')
    expect(circularFragment.name).toBe('circular-fragment')
  })

  it('declares stages including save-delta (cycles must be blocked at save)', () => {
    // Counterfactual: removing save-delta from `stages` means a cycle
    // introduced by an edit isn't blocked at the save banner; the user
    // discovers the cycle later from a background scan or render crash.
    expect(circularFragment.stages).toContain('save-delta')
    expect(circularFragment.stages).toContain('background')
    expect(circularFragment.stages).toContain('pre-publish')
    expect(circularFragment.stages).toContain('cli')
  })

  it('defaults to error severity at every stage', () => {
    // Counterfactual: demoting to warn would let cycles slip past save-
    // delta into background, where the renderer's resolve loop crashes.
    // Error severity is the correct policy — pinning it here.
    expect(circularFragment.defaultSeverity('save-delta')).toBe('error')
    expect(circularFragment.defaultSeverity('background')).toBe('error')
    expect(circularFragment.defaultSeverity('pre-publish')).toBe('error')
    expect(circularFragment.defaultSeverity('cli')).toBe('error')
  })
})

describe('circularFragment — stage and kind gates', () => {
  it('pre-publish scope returns no issues (publish-audit caller iterates separately)', async () => {
    // Counterfactual: removing the `scope.kind !== 'save-delta' && scope.kind !== 'background' return []`
    // early-return would attempt to walk pre-publish scope without
    // `scope.item` / `scope.manifest` and either crash or return spurious
    // data.
    const site = makeSite({
      fragments: new Map([['a', frag('a', ['@a'])]]),
    })
    const issues = await circularFragment.validate(prePublishInput(site))
    expect(issues).toEqual([])
  })

  it('cli scope returns no issues (site-loader handles full-site cycle scans separately)', async () => {
    const site = makeSite({
      fragments: new Map([['a', frag('a', ['@a'])]]),
    })
    const issues = await circularFragment.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('background scope on a page returns no issues (pages cannot be cyclically referenced)', async () => {
    // Counterfactual: removing the `scope.item.kind !== 'fragment' return []`
    // would attempt to walk page components for fragment cycles, which is
    // a category error — pages never form @ref cycles with themselves.
    const site = makeSite()
    const issues = await circularFragment.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { template: 't', content: {}, components: [] } as PageManifest,
      }),
    )
    expect(issues).toEqual([])
  })
})

describe('circularFragment — background scope cycle detection', () => {
  it('produces no issue for a non-cyclic fragment chain (A → B, B is leaf)', async () => {
    // Counterfactual: if the walker over-eagerly flagged ANY @ ref as a
    // cycle, this would emit. The non-cycle case is the false-positive
    // guard.
    const site = makeSite({
      fragments: new Map([
        ['a', frag('a', ['@b'])],
        ['b', frag('b', [])],
      ]),
    })
    const issues = await circularFragment.validate(
      backgroundInput({
        site,
        itemKind: 'fragment',
        itemName: 'a',
        manifest: site.fragments.get('a')!,
      }),
    )
    expect(issues).toEqual([])
  })

  it('detects a fragment that references itself (@self self-cycle)', async () => {
    // Counterfactual: if findCycle stopped recognizing `path.indexOf(name) >= 0`,
    // the self-reference wouldn't be detected and this returns []. Also
    // pins issue shape (validator name, severity, itemPath).
    const site = makeSite({
      fragments: new Map([['a', frag('a', ['@a'])]]),
    })
    const issues = await circularFragment.validate(
      backgroundInput({
        site,
        itemKind: 'fragment',
        itemName: 'a',
        manifest: site.fragments.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('circular-fragment')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].itemPath).toBe('fragments/a/fragment.json')
    expect(issues[0].message).toContain('a')
    // The cycle message uses the arrow separator from the impl's
    // contract — pinning the human-readable format.
    expect(issues[0].message).toContain('→')
  })

  it('detects a transitive A → B → A cycle and names both fragments in the chain', async () => {
    // Counterfactual: if findCycle stopped following nested refs (only
    // checked depth-1), the A → B → A cycle is missed and this returns [].
    const site = makeSite({
      fragments: new Map([
        ['a', frag('a', ['@b'])],
        ['b', frag('b', ['@a'])],
      ]),
    })
    const issues = await circularFragment.validate(
      backgroundInput({
        site,
        itemKind: 'fragment',
        itemName: 'a',
        manifest: site.fragments.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('a')
    expect(issues[0].message).toContain('b')
  })

  it('detects cycles via nested inline component fragment refs', async () => {
    // Cycle is reached through a nested inline component's `components`
    // array, not the fragment's top-level components.
    //
    // Counterfactual: if fragmentRefs (the recursive ref-extractor) stopped
    // descending into inline.components, this cycle is missed.
    const site = makeSite({
      fragments: new Map([['a', frag('a', [{ template: 'wrapper', name: 'inner', content: {}, components: ['@a'] }])]]),
    })
    const issues = await circularFragment.validate(
      backgroundInput({
        site,
        itemKind: 'fragment',
        itemName: 'a',
        manifest: site.fragments.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('a')
  })
})

describe('circularFragment — save-delta substitutes the to-be-saved manifest', () => {
  it('detects a cycle introduced by THIS save against the would-be state', async () => {
    // The on-disk fragment `a` has NO refs. The author's edit adds `@b`,
    // and `b` references `a` already. The cycle exists only against the
    // would-be-saved state, not the on-disk state.
    //
    // Counterfactual: if the validator read scope.manifest from on-disk
    // state instead of substituting the saved manifest, the cycle would
    // be missed and the save would land — the bug this validator's
    // save-delta stage exists to prevent.
    const site = makeSite({
      fragments: new Map([
        ['a', frag('a', [])], // on-disk: no refs, no cycle
        ['b', frag('b', ['@a'])],
      ]),
    })
    const incoming: FragmentManifest = {
      template: 't',
      content: {},
      components: ['@b'], // introducing the ref that closes the cycle
    } as FragmentManifest
    const issues = await circularFragment.validate(
      saveDeltaInput({
        site,
        itemKind: 'fragment',
        itemName: 'a',
        after: incoming,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('circular-fragment')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('a')
    expect(issues[0].message).toContain('b')
  })

  it('does not flag a save-delta that introduces only a non-cyclic ref', async () => {
    // Counterfactual: a false-positive in the substitution path would
    // surface here.
    const site = makeSite({
      fragments: new Map([
        ['a', frag('a', [])],
        ['c', frag('c', [])],
      ]),
    })
    const issues = await circularFragment.validate(
      saveDeltaInput({
        site,
        itemKind: 'fragment',
        itemName: 'a',
        after: { template: 't', content: {}, components: ['@c'] } as FragmentManifest,
      }),
    )
    expect(issues).toEqual([])
  })
})
