/**
 * Tests for the persisted-edits store + key helpers per
 * `design-offline.md` Cut 8b.
 *
 * Pure-data store tests; the integration with useEditorActions
 * navigate / save lives in persistedEditsIntegration.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  persistedEditKey,
  persistedEditKeyForSelection,
  usePersistedEditsStore,
} from '../src/client/stores/persistedEdits.js'
import type { EditorSelection } from '../src/client/composables/editorSelection.js'

describe('persistedEditKey', () => {
  it('builds the key for a default-locale page', () => {
    expect(persistedEditKey('page', 'home', undefined, '_root')).toBe('page:home::_root')
  })

  it('includes the locale segment', () => {
    expect(persistedEditKey('page', 'home', 'fr', '_root')).toBe('page:home:fr:_root')
  })

  it('builds component-level keys', () => {
    expect(persistedEditKey('page', 'home', undefined, 'hero')).toBe('page:home::hero')
  })

  it('builds fragment keys', () => {
    expect(persistedEditKey('fragment', 'header', undefined, 'logo')).toBe('fragment:header::logo')
  })

  it('keys for the same component path on DIFFERENT pages do NOT collide', () => {
    // The Cut 8b motivating case: pages/home and pages/about both
    // have a _root selection; the in-memory stash collides on the
    // path-only key but persistedEdits must not.
    const home = persistedEditKey('page', 'home', undefined, '_root')
    const about = persistedEditKey('page', 'about', undefined, '_root')
    expect(home).not.toBe(about)
  })

  it('keys for different locales of the same page do NOT collide', () => {
    const en = persistedEditKey('page', 'home', undefined, '_root')
    const fr = persistedEditKey('page', 'home', 'fr', '_root')
    expect(en).not.toBe(fr)
  })
})

describe('persistedEditKeyForSelection', () => {
  it('returns null for fragmentLink (nothing to persist)', () => {
    const sel: EditorSelection = { kind: 'fragmentLink', treePath: '@header', fragmentName: 'header' }
    expect(persistedEditKeyForSelection(sel, 'page', 'home', undefined)).toBeNull()
  })

  it('returns null when kind is missing (no selection yet)', () => {
    const sel: EditorSelection = { kind: 'root' }
    expect(persistedEditKeyForSelection(sel, null, null, undefined)).toBeNull()
  })

  it('builds _root key for root selection', () => {
    const sel: EditorSelection = { kind: 'root' }
    expect(persistedEditKeyForSelection(sel, 'page', 'home', undefined)).toBe('page:home::_root')
  })

  it('builds component-path key for component selection', () => {
    const sel: EditorSelection = { kind: 'component', path: 'hero', template: 'hero' }
    expect(persistedEditKeyForSelection(sel, 'page', 'home', 'fr')).toBe('page:home:fr:hero')
  })

  it('builds fragment _root key for fragmentEdit selection', () => {
    const sel: EditorSelection = { kind: 'fragmentEdit', fragmentName: 'header' }
    // fragmentEdit always builds a fragment key regardless of the
    // surrounding selection (the host page).
    expect(persistedEditKeyForSelection(sel, 'page', 'home', undefined)).toBe('fragment:header::_root')
  })
})

describe('usePersistedEditsStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts empty', () => {
    const store = usePersistedEditsStore()
    expect(store.count).toBe(0)
    expect(store.hasAny).toBe(false)
    expect(store.get('any-key')).toBeNull()
  })

  it('set / get round-trips a value', () => {
    const store = usePersistedEditsStore()
    store.set('page:home::_root', { title: 'Mine' })
    const entry = store.get('page:home::_root')
    expect(entry).not.toBeNull()
    expect(entry!.editedContent).toEqual({ title: 'Mine' })
    expect(entry!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('set overwrites an existing entry', () => {
    const store = usePersistedEditsStore()
    store.set('page:home::_root', { title: 'A' })
    store.set('page:home::_root', { title: 'B' })
    expect(store.count).toBe(1)
    expect(store.get('page:home::_root')!.editedContent).toEqual({ title: 'B' })
  })

  it('clear removes one entry without touching siblings', () => {
    const store = usePersistedEditsStore()
    store.set('page:home::_root', { title: 'Home' })
    store.set('page:about::_root', { title: 'About' })
    store.clear('page:home::_root')
    expect(store.has('page:home::_root')).toBe(false)
    expect(store.get('page:about::_root')!.editedContent).toEqual({ title: 'About' })
  })

  it('clearAll empties the store', () => {
    const store = usePersistedEditsStore()
    store.set('a', { x: 1 })
    store.set('b', { y: 2 })
    store.clearAll()
    expect(store.count).toBe(0)
  })

  it('_hydrateAll replaces the entire entries map', () => {
    const store = usePersistedEditsStore()
    store.set('stale', { foo: 'old' })
    store._hydrateAll([
      [
        'page:home::_root',
        { key: 'page:home::_root', editedContent: { title: 'New' }, updatedAt: '2026-05-06T22:00:00Z' },
      ],
    ])
    expect(store.has('stale')).toBe(false)
    expect(store.get('page:home::_root')!.editedContent).toEqual({ title: 'New' })
  })
})
