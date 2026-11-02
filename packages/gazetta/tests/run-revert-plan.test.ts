import { describe, expect, it } from 'vitest'
import { itemOfPath, planRevert, revisionsToRead, type PlanRevision } from '../src/run-revert-plan.js'

const HOME = 'pages/home/page.json'
const HOME_FR = 'pages/home/page.fr.json'
const PROMO = 'pages/promo/page.json'

/** Revisions oldest first; the run's are r2 and r3. */
function history(): PlanRevision[] {
  return [
    { id: 'r1', items: [HOME], snapshot: { [HOME]: 'h0', [HOME_FR]: 'f0' } },
    { id: 'r2', items: [HOME, PROMO], snapshot: { [HOME]: 'h1', [HOME_FR]: 'f0', [PROMO]: 'p1' } },
    { id: 'r3', items: [HOME, HOME_FR], snapshot: { [HOME]: 'h2', [HOME_FR]: 'f1', [PROMO]: 'p1' } },
    { id: 'r4', items: [HOME], snapshot: { [HOME]: 'h3', [HOME_FR]: 'f1', [PROMO]: 'p1' } },
  ]
}

const run = new Set(['r2', 'r3'])
const items = ['pages.home', 'pages.home:fr', 'pages.promo']

describe('planRevert', () => {
  it('takes the version before the run and the one it left, across several revisions', () => {
    const current = new Map([
      [HOME, 'h2'],
      [HOME_FR, 'f1'],
      [PROMO, 'p1'],
    ])
    const plan = planRevert({ revisions: history(), runRevisions: run, items, current })
    expect(plan.find(p => p.item === 'pages.home')).toMatchObject({
      path: HOME,
      kind: 'page',
      name: 'home',
      before: 'h0',
      after: 'h2',
      created: false,
      changed: false,
    })
  })

  it('treats a language version as its own item', () => {
    const plan = planRevert({ revisions: history(), runRevisions: run, items, current: new Map([[HOME_FR, 'f1']]) })
    expect(plan.find(p => p.item === 'pages.home:fr')).toMatchObject({
      locale: 'fr',
      before: 'f0',
      after: 'f1',
      changed: false,
    })
  })

  it('marks an item the run created', () => {
    const plan = planRevert({ revisions: history(), runRevisions: run, items, current: new Map([[PROMO, 'p1']]) })
    expect(plan.find(p => p.item === 'pages.promo')).toMatchObject({ before: null, created: true, changed: false })
  })

  it('marks an item changed since the run, and one deleted since', () => {
    const plan = planRevert({ revisions: history(), runRevisions: run, items, current: new Map([[HOME, 'h3']]) })
    expect(plan.find(p => p.item === 'pages.home')).toMatchObject({ current: 'h3', changed: true })
    expect(plan.find(p => p.item === 'pages.promo')).toMatchObject({ current: null, changed: true })
  })

  it('leaves the version before unknown when history no longer holds it', () => {
    const revisions = history().slice(1)
    const plan = planRevert({ revisions, runRevisions: run, items, current: new Map() })
    expect(plan.find(p => p.item === 'pages.home')?.before).toBeUndefined()
  })

  it("reads only the run's revisions and the ones just before them", () => {
    expect(revisionsToRead(['r1', 'r2', 'r3', 'r4'], run).sort()).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('itemOfPath', () => {
  it.each([
    [HOME, { kind: 'page', name: 'home' }],
    ['pages/blog/post/page.fr.json', { kind: 'page', name: 'blog/post', locale: 'fr' }],
    ['fragments/header/fragment.json', { kind: 'fragment', name: 'header' }],
    ['assets/hero.asset.json', { kind: 'asset', name: 'hero' }],
    ['site.config.ts', null],
  ])('%s', (path, expected) => {
    expect(itemOfPath(path)).toEqual(expected)
  })
})
