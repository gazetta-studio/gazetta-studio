/**
 * Tests for Cut 8 — soft-delete validators (P1-P5) and the P8 save-
 * handler check.
 *
 * Per `design-soft-delete.md` Q11 stage matrix and the implementation
 * grilling Q3 lock; each validator's stage gates + severity are
 * pinned here so regressions surface immediately.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + fresh site fixtures via `makeSite()`. No
 * module-level state.
 */
import { describe, expect, it } from 'vitest'
import type { FragmentManifest, PageManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { aliasOfPointsToArchived } from '../src/validation/validators/aliasof-points-to-archived.js'
import { archiveNotSupportedOnTarget } from '../src/validation/validators/archive-not-supported-on-target.js'
import { circularAlias } from '../src/validation/validators/circular-alias.js'
import { danglingAlias } from '../src/validation/validators/dangling-alias.js'
import { referencedArchivedWithoutAlias } from '../src/validation/validators/referenced-archived-without-alias.js'
import { memoryStorage } from './_helpers/memory-storage.js'

// ─── Test helpers ─────────────────────────────────────────────────────

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

function saveDeltaInput(opts: {
  site: Site
  itemKind: 'page' | 'fragment'
  itemName: string
  before: PageManifest | FragmentManifest | null
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
      before: opts.before,
      after: opts.after,
    },
  }
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

// ─── P1: referenced-archived-without-alias ──────────────────────────

describe('referenced-archived-without-alias (P1)', () => {
  it('warns when a save introduces a ref to an archived-no-alias fragment', async () => {
    const site = makeSite({
      fragments: new Map([
        ['retired', { template: 'h', dir: 'fragments/retired', archived: true } as FragmentManifest & { dir: string }],
      ]),
    })
    const issues = await referencedArchivedWithoutAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, components: ['@retired'] },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warn')
    expect(issues[0].message).toContain('@retired')
  })

  it('does not flag a ref to an aliased archive (archive with aliasOf)', async () => {
    const site = makeSite({
      fragments: new Map([
        [
          'old-header',
          {
            template: 'h',
            dir: 'fragments/old-header',
            archived: true,
            aliasOf: 'header',
          } as FragmentManifest & { dir: string },
        ],
        ['header', { template: 'h', dir: 'fragments/header' } as FragmentManifest & { dir: string }],
      ]),
    })
    const issues = await referencedArchivedWithoutAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, components: ['@old-header'] },
      }),
    )
    expect(issues).toEqual([])
  })

  it('does not flag a ref to a live fragment', async () => {
    const site = makeSite({
      fragments: new Map([
        ['header', { template: 'h', dir: 'fragments/header' } as FragmentManifest & { dir: string }],
      ]),
    })
    const issues = await referencedArchivedWithoutAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {}, components: ['@header'] },
      }),
    )
    expect(issues).toEqual([])
  })

  it('save-delta narrows to newly-introduced refs (pre-existing refs to archived-no-alias not re-flagged)', async () => {
    const site = makeSite({
      fragments: new Map([
        ['retired', { template: 'h', dir: 'fragments/retired', archived: true } as FragmentManifest & { dir: string }],
      ]),
    })
    const issues = await referencedArchivedWithoutAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        // BEFORE already had the ref — not "newly introduced"
        before: { template: 't', content: {}, components: ['@retired'] },
        after: { template: 't', content: { changed: true }, components: ['@retired'] },
      }),
    )
    expect(issues).toEqual([])
  })

  it('background stage flags every problematic ref (full coverage)', async () => {
    const site = makeSite({
      fragments: new Map([
        ['retired', { template: 'h', dir: 'fragments/retired', archived: true } as FragmentManifest & { dir: string }],
      ]),
    })
    const issues = await referencedArchivedWithoutAlias.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        manifest: { template: 't', content: {}, components: ['@retired'] },
      }),
    )
    expect(issues).toHaveLength(1)
  })
})

// ─── P2: dangling-alias ───────────────────────────────────────────────

describe('dangling-alias (P2)', () => {
  it('errors when the aliasOf target is missing', async () => {
    const site = makeSite() // no pages/fragments configured
    const issues = await danglingAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'old-landing',
        before: null,
        after: { template: 't', content: {}, archived: true, aliasOf: 'missing' },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('missing')
  })

  it('passes when the alias target exists and is live', async () => {
    const site = makeSite({
      pages: new Map([['home', { template: 't', dir: 'pages/home', route: '/' } as PageManifest & { dir: string }]]),
    })
    const issues = await danglingAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'old-landing',
        before: null,
        after: { template: 't', content: {}, archived: true, aliasOf: 'home' },
      }),
    )
    expect(issues).toEqual([])
  })

  it('does not fire on live (non-archived) items', async () => {
    const site = makeSite()
    const issues = await danglingAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'home',
        before: null,
        after: { template: 't', content: {} },
      }),
    )
    expect(issues).toEqual([])
  })

  it('does not fire on archive without aliasOf (pure soft-delete)', async () => {
    const site = makeSite()
    const issues = await danglingAlias.validate(
      saveDeltaInput({
        site,
        itemKind: 'page',
        itemName: 'gone',
        before: null,
        after: { template: 't', content: {}, archived: true },
      }),
    )
    expect(issues).toEqual([])
  })
})

// ─── P3: circular-alias ───────────────────────────────────────────────

describe('circular-alias (P3)', () => {
  it('errors on a self-cycle (A → A)', async () => {
    const site = makeSite({
      pages: new Map([
        [
          'a',
          {
            template: 't',
            dir: 'pages/a',
            route: '/a',
            archived: true,
            aliasOf: 'a',
          } as PageManifest & { dir: string },
        ],
      ]),
    })
    const issues = await circularAlias.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: site.pages.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message.toLowerCase()).toContain('cycle')
  })

  it('errors on a 2-hop cycle (A → B → A)', async () => {
    const site = makeSite({
      pages: new Map([
        [
          'a',
          {
            template: 't',
            dir: 'pages/a',
            route: '/a',
            archived: true,
            aliasOf: 'b',
          } as PageManifest & { dir: string },
        ],
        [
          'b',
          {
            template: 't',
            dir: 'pages/b',
            route: '/b',
            archived: true,
            aliasOf: 'a',
          } as PageManifest & { dir: string },
        ],
      ]),
    })
    const issues = await circularAlias.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: site.pages.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message.toLowerCase()).toContain('cycle')
  })

  it('errors on an alias chain that exceeds 1 hop (A → B → C live)', async () => {
    const site = makeSite({
      pages: new Map([
        [
          'a',
          {
            template: 't',
            dir: 'pages/a',
            route: '/a',
            archived: true,
            aliasOf: 'b',
          } as PageManifest & { dir: string },
        ],
        [
          'b',
          {
            template: 't',
            dir: 'pages/b',
            route: '/b',
            archived: true,
            aliasOf: 'c',
          } as PageManifest & { dir: string },
        ],
        ['c', { template: 't', dir: 'pages/c', route: '/c' } as PageManifest & { dir: string }],
      ]),
    })
    const issues = await circularAlias.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: site.pages.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message.toLowerCase()).toContain('chain')
  })

  it('passes on a one-hop alias to a live target (Q3 G1 invariant satisfied)', async () => {
    const site = makeSite({
      pages: new Map([
        [
          'a',
          {
            template: 't',
            dir: 'pages/a',
            route: '/a',
            archived: true,
            aliasOf: 'b',
          } as PageManifest & { dir: string },
        ],
        ['b', { template: 't', dir: 'pages/b', route: '/b' } as PageManifest & { dir: string }],
      ]),
    })
    const issues = await circularAlias.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: site.pages.get('a')!,
      }),
    )
    expect(issues).toEqual([])
  })
})

// ─── P4: archive-not-supported-on-target ──────────────────────────────

describe('archive-not-supported-on-target (P4)', () => {
  it('warns when an archive exists and a target is plain-static', async () => {
    const site = makeSite({
      manifest: {
        name: 'test',
        targets: {
          'prod-static': { type: 'static' },
        },
      },
    } as Partial<Site>)
    const issues = await archiveNotSupportedOnTarget.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'archived-page',
        manifest: { template: 't', content: {}, archived: true },
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warn')
    expect(issues[0].message).toContain('prod-static')
  })

  it('does not fire on live items', async () => {
    const site = makeSite({
      manifest: {
        name: 'test',
        targets: { 'prod-static': { type: 'static' } },
      },
    } as Partial<Site>)
    const issues = await archiveNotSupportedOnTarget.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'live-page',
        manifest: { template: 't', content: {} },
      }),
    )
    expect(issues).toEqual([])
  })

  it('does not warn when the target has redirects format configured', async () => {
    const site = makeSite({
      manifest: {
        name: 'test',
        targets: { 'prod-static': { type: 'static', redirects: { format: 'cloudflare' } } },
      },
    } as Partial<Site>)
    const issues = await archiveNotSupportedOnTarget.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'archived-page',
        manifest: { template: 't', content: {}, archived: true },
      }),
    )
    expect(issues).toEqual([])
  })
})

// ─── P5: aliasOf-points-to-archived ───────────────────────────────────

describe('aliasOf-points-to-archived (P5)', () => {
  it('warns when aliasOf target is archived', async () => {
    const site = makeSite({
      pages: new Map([
        [
          'a',
          {
            template: 't',
            dir: 'pages/a',
            route: '/a',
            archived: true,
            aliasOf: 'b',
          } as PageManifest & { dir: string },
        ],
        [
          'b',
          {
            template: 't',
            dir: 'pages/b',
            route: '/b',
            archived: true,
          } as PageManifest & { dir: string },
        ],
      ]),
    })
    const issues = await aliasOfPointsToArchived.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: site.pages.get('a')!,
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warn')
    expect(issues[0].message).toContain('archived')
  })

  it('passes when aliasOf points at a live target', async () => {
    const site = makeSite({
      pages: new Map([
        [
          'a',
          {
            template: 't',
            dir: 'pages/a',
            route: '/a',
            archived: true,
            aliasOf: 'b',
          } as PageManifest & { dir: string },
        ],
        ['b', { template: 't', dir: 'pages/b', route: '/b' } as PageManifest & { dir: string }],
      ]),
    })
    const issues = await aliasOfPointsToArchived.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: site.pages.get('a')!,
      }),
    )
    expect(issues).toEqual([])
  })

  it('does not fire when target is missing (P2 dangling-alias handles that)', async () => {
    const site = makeSite()
    const issues = await aliasOfPointsToArchived.validate(
      backgroundInput({
        site,
        itemKind: 'page',
        itemName: 'a',
        manifest: { template: 't', content: {}, archived: true, aliasOf: 'missing' },
      }),
    )
    expect(issues).toEqual([])
  })
})
