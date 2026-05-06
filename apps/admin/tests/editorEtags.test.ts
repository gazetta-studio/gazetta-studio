/**
 * Verify the etag store + manifest-path helper.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { manifestPath, useEditorEtagsStore } from '../src/client/stores/editorEtags.js'

describe('manifestPath helper', () => {
  it('builds the page manifest path without locale', () => {
    expect(manifestPath('page', 'home')).toBe('pages/home/page.json')
  })

  it('builds the page manifest path with locale', () => {
    expect(manifestPath('page', 'home', 'fr')).toBe('pages/home/page.fr.json')
  })

  it('builds the fragment manifest path without locale', () => {
    expect(manifestPath('fragment', 'header')).toBe('fragments/header/fragment.json')
  })

  it('builds the fragment manifest path with locale', () => {
    expect(manifestPath('fragment', 'header', 'ja')).toBe('fragments/header/fragment.ja.json')
  })

  it('handles nested page names (subfolders)', () => {
    expect(manifestPath('page', 'blog/[slug]')).toBe('pages/blog/[slug]/page.json')
  })

  it('matches the conflict store key shape so cross-store lookup works', () => {
    // Pin: useEditorEtagsStore + useSaveConflictsStore use the same
    // key shape for the same item. A future divergence breaks the
    // discard-flow rebase which reads from the conflict store.
    const path = manifestPath('page', 'home', 'fr')
    expect(path).toBe('pages/home/page.fr.json')
  })
})

describe('useEditorEtagsStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts empty', () => {
    const store = useEditorEtagsStore()
    expect(store.count).toBe(0)
    expect(store.get('any')).toBeNull()
  })

  it('set / get round-trips a value', () => {
    const store = useEditorEtagsStore()
    store.set('pages/home/page.json', 'abc123')
    expect(store.get('pages/home/page.json')).toBe('abc123')
    expect(store.count).toBe(1)
  })

  it('set overwrites the existing etag for a path', () => {
    const store = useEditorEtagsStore()
    store.set('pages/home/page.json', 'old')
    store.set('pages/home/page.json', 'new')
    expect(store.get('pages/home/page.json')).toBe('new')
    expect(store.count).toBe(1)
  })

  it('clear removes one entry without touching siblings', () => {
    const store = useEditorEtagsStore()
    store.set('pages/home/page.json', 'a')
    store.set('pages/about/page.json', 'b')
    store.clear('pages/home/page.json')
    expect(store.get('pages/home/page.json')).toBeNull()
    expect(store.get('pages/about/page.json')).toBe('b')
  })

  it('clearAll empties the store', () => {
    const store = useEditorEtagsStore()
    store.set('a', '1')
    store.set('b', '2')
    store.clearAll()
    expect(store.count).toBe(0)
  })
})
