/**
 * Verify the save-conflicts Pinia store contract per
 * `design-offline.md` Q3.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSaveConflictsStore } from '../src/client/stores/saveConflicts.js'

describe('useSaveConflictsStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts empty', () => {
    const store = useSaveConflictsStore()
    expect(store.count).toBe(0)
    expect(store.hasAny).toBe(false)
  })

  it('set() registers a conflict keyed by itemPath', () => {
    const store = useSaveConflictsStore()
    store.set({
      itemPath: 'pages/home/page.json',
      current: { template: 'page-default', content: { title: 'Theirs' } },
      currentEtag: 'fresh',
      pending: { template: 'page-default', content: { title: 'Mine' } },
    })

    expect(store.count).toBe(1)
    expect(store.has('pages/home/page.json')).toBe(true)
    const record = store.get('pages/home/page.json')
    expect(record).not.toBeNull()
    expect(record!.currentEtag).toBe('fresh')
    expect(record!.surfacedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('set() overwrites an existing conflict on the same path', () => {
    const store = useSaveConflictsStore()
    store.set({
      itemPath: 'pages/home/page.json',
      current: { template: 't', content: { title: 'A' } },
      currentEtag: 'old',
      pending: {},
    })
    store.set({
      itemPath: 'pages/home/page.json',
      current: { template: 't', content: { title: 'B' } },
      currentEtag: 'new',
      pending: {},
    })

    expect(store.count).toBe(1)
    expect(store.get('pages/home/page.json')!.currentEtag).toBe('new')
  })

  it('clear() removes the conflict for one path', () => {
    const store = useSaveConflictsStore()
    store.set({
      itemPath: 'pages/home/page.json',
      current: {},
      currentEtag: 'a',
      pending: {},
    })
    store.set({
      itemPath: 'pages/about/page.json',
      current: {},
      currentEtag: 'b',
      pending: {},
    })
    expect(store.count).toBe(2)

    store.clear('pages/home/page.json')
    expect(store.count).toBe(1)
    expect(store.has('pages/home/page.json')).toBe(false)
    expect(store.has('pages/about/page.json')).toBe(true)
  })

  it('clear() on a non-existent path is a no-op', () => {
    const store = useSaveConflictsStore()
    store.clear('nope')
    expect(store.count).toBe(0)
  })

  it('clearAll() drops every conflict', () => {
    const store = useSaveConflictsStore()
    store.set({ itemPath: 'a', current: {}, currentEtag: 'x', pending: {} })
    store.set({ itemPath: 'b', current: {}, currentEtag: 'y', pending: {} })
    expect(store.count).toBe(2)

    store.clearAll()
    expect(store.count).toBe(0)
    expect(store.hasAny).toBe(false)
  })

  it('get() returns null for unknown paths', () => {
    const store = useSaveConflictsStore()
    expect(store.get('nope')).toBeNull()
  })

  it('keys can hold path-style strings (page) and locale variants', () => {
    // Pin: the key is the manifest path. Locale variants live at
    // distinct paths (`page.fr.json`) so a French conflict and an
    // English conflict on the same name coexist as separate entries.
    const store = useSaveConflictsStore()
    store.set({ itemPath: 'pages/home/page.json', current: {}, currentEtag: 'en', pending: {} })
    store.set({ itemPath: 'pages/home/page.fr.json', current: {}, currentEtag: 'fr', pending: {} })

    expect(store.count).toBe(2)
    expect(store.get('pages/home/page.json')!.currentEtag).toBe('en')
    expect(store.get('pages/home/page.fr.json')!.currentEtag).toBe('fr')
  })
})
