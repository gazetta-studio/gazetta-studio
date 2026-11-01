/**
 * The per-run index (design-agent-access.md Q48) and retention that
 * counts a run as one entry (Q51).
 */
import { describe, expect, it } from 'vitest'
import { createHistoryProvider, groupIntoEntries } from '../src/history-provider.js'
import { createRunIndex, runItemName } from '../src/history-runs.js'
import { removeSensitiveState } from '../src/state-remove.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const ROOT = '.gazetta/history'

describe('runItemName', () => {
  it.each([
    ['pages/home/page.json', 'pages.home'],
    ['pages/home/page.fr.json', 'pages.home:fr'],
    ['pages/blog/[slug]/page.json', 'pages.blog.[slug]'],
    ['pages/about/team/page.json', 'pages.about.team'],
    ['fragments/header/fragment.json', 'fragments.header'],
    ['fragments/header/fragment.ar.json', 'fragments.header:ar'],
    ['assets/hero.asset.json', 'assets.hero'],
    ['assets/hero.asset.fr.json', 'assets.hero:fr'],
    ['assets/hero.asset.fr.dark.json', 'assets.hero:fr.dark'],
  ])('%s → %s', (path, name) => {
    expect(runItemName(path)).toBe(name)
  })

  it.each([
    'assets/hero-a3b2c1d4.jpg',
    'assets/hero-a3b2c1d4-400w.jpg',
    'site.config.ts',
    'pages/home/hero/index.html',
  ])('%s is not an item', path => {
    expect(runItemName(path)).toBeNull()
  })
})

describe('the run index', () => {
  it('lists each item once and every revision', async () => {
    const index = createRunIndex(memoryStorage(), ROOT)
    await index.record('r1', 'rev-1-1-aaaaaaaa', ['pages/home/page.json', 'assets/hero-a3b2c1d4.jpg'])
    await index.record('r1', 'rev-2-1-bbbbbbbb', ['pages/about/page.json'])
    await index.record('r1', 'rev-3-1-cccccccc', ['pages/home/page.json', 'pages/home/page.fr.json'])
    expect(await index.listItems('r1')).toEqual(['pages.about', 'pages.home', 'pages.home:fr'])
    expect((await index.listRevisions('r1')).sort()).toEqual([
      'rev-1-1-aaaaaaaa',
      'rev-2-1-bbbbbbbb',
      'rev-3-1-cccccccc',
    ])
    expect(await index.listRuns()).toEqual(['r1'])
  })

  it('two instances writing the same entries leave one file each, without errors', async () => {
    const storage = memoryStorage()
    const a = createRunIndex(storage, ROOT)
    const b = createRunIndex(storage, ROOT)
    await Promise.all([
      a.record('r1', 'rev-1-1-aaaaaaaa', ['pages/home/page.json']),
      b.record('r1', 'rev-1-1-aaaaaaaa', ['pages/home/page.json']),
    ])
    expect([...storage.dump().keys()].filter(k => k.startsWith(`${ROOT}/runs/`)).sort()).toEqual([
      `${ROOT}/runs/r1/items/pages.home`,
      `${ROOT}/runs/r1/revisions/rev-1-1-aaaaaaaa`,
    ])
  })

  it('deletes a run', async () => {
    const index = createRunIndex(memoryStorage(), ROOT)
    await index.record('r1', 'rev-1-1-aaaaaaaa', ['pages/home/page.json'])
    await index.record('r2', 'rev-2-1-bbbbbbbb', ['pages/home/page.json'])
    await index.deleteRun('r1')
    expect(await index.listRuns()).toEqual(['r2'])
    expect(await index.listItems('r1')).toEqual([])
  })

  it.each(['.', '..', '', 'a/b', 'x'.repeat(65)])('refuses the run id %j', async runId => {
    const index = createRunIndex(memoryStorage(), ROOT)
    await expect(index.record(runId, 'rev-1-1-aaaaaaaa', [])).rejects.toThrow('invalid run id')
  })

  it('goes with history when state is removed', async () => {
    const storage = memoryStorage()
    await createRunIndex(storage, ROOT).record('r1', 'rev-1-1-aaaaaaaa', ['pages/home/page.json'])
    await removeSensitiveState(storage, ['history'])
    expect([...storage.dump().keys()].some(k => k.startsWith(`${ROOT}/`))).toBe(false)
  })
})

describe('recordRevision and the run index', () => {
  const item = (path: string) => new Map([[path, `{"v":"${path}"}`]])

  it('indexes revisions that carry a run, and nothing else', async () => {
    const storage = memoryStorage()
    const history = createHistoryProvider({ storage })
    const r1 = await history.recordRevision({
      operation: 'save',
      items: item('pages/home/page.json'),
      origin: { channel: 'token', runId: 'r1' },
    })
    await history.recordRevision({ operation: 'save', items: item('pages/about/page.json') })
    const index = createRunIndex(storage, ROOT)
    expect(await index.listRuns()).toEqual(['r1'])
    expect(await index.listRevisions('r1')).toEqual([r1.id])
    expect(await index.listItems('r1')).toEqual(['pages.home'])
  })
})

describe('retention counts a run as one entry', () => {
  const save = (history: ReturnType<typeof createHistoryProvider>, runId?: string) =>
    history.recordRevision({
      operation: 'save',
      items: new Map([['pages/home/page.json', `{"n":${Math.random()}}`]]),
      ...(runId ? { origin: { channel: 'token' as const, runId } } : {}),
    })

  it('keeps a run whole, then evicts it whole with its index folder', async () => {
    const storage = memoryStorage()
    const history = createHistoryProvider({ storage, retention: 3 })
    for (let i = 0; i < 5; i++) await save(history, 'r1')
    await save(history)
    await save(history)
    // Three entries: the run, and two plain saves.
    expect(await history.listRevisions()).toHaveLength(7)
    expect(await createRunIndex(storage, ROOT).listRuns()).toEqual(['r1'])

    await save(history)
    const left = await history.listRevisions()
    expect(left).toHaveLength(3)
    expect(left.every(r => r.runId === undefined)).toBe(true)
    expect([...storage.dump().keys()].some(k => k.startsWith(`${ROOT}/runs/`))).toBe(false)
  })

  it('plain revisions keep the default limit of 50', async () => {
    const history = createHistoryProvider({ storage: memoryStorage() })
    for (let i = 0; i < 52; i++) await save(history)
    expect(await history.listRevisions()).toHaveLength(50)
  })

  it('orders entries by their newest revision', () => {
    const runs: Record<string, string> = { a: 'r1', c: 'r1' }
    expect(groupIntoEntries(['a', 'b', 'c', 'd'], id => runs[id])).toEqual([
      { revisions: ['b'] },
      { runId: 'r1', revisions: ['a', 'c'] },
      { revisions: ['d'] },
    ])
  })
})
