/**
 * Tests for the Cut 8b persistence coordinator
 * (`attachPersistedEditsPersistence`).
 *
 * Mirrors the shape of pendingEditsPersistence.test.ts (Cut 8a)
 * since the patterns are deliberately parallel:
 *
 *   - On attach: hydrates the store from any previously-persisted
 *     snapshot
 *   - On mutation: debounce-writes a fresh snapshot
 *   - On empty: invalidates the cache key
 *   - Defensive against malformed entries
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'
import {
  attachPersistedEditsPersistence,
  type PendingEditsPersistenceHandle,
} from '../src/client/stores/_pendingEditsPersistence.js'
import { type PersistedEdit, usePersistedEditsStore } from '../src/client/stores/persistedEdits.js'

interface PersistedEditsSnapshot {
  version: 1
  entries: Array<[string, PersistedEdit]>
}

function fakeAdminCache(): AdminCache & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    _store: store,
    async get<T>(key: string): Promise<T | null> {
      const v = store.get(key)
      return v === undefined ? null : (v as T)
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value)
    },
    async invalidate(key: string): Promise<void> {
      store.delete(key)
    },
    async invalidatePrefix(prefix: string): Promise<number> {
      let cleared = 0
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key)
          cleared += 1
        }
      }
      return cleared
    },
    subscribe(_handler: (event: InvalidationEvent) => void): () => void {
      return () => {}
    },
    async stats(): Promise<CacheStats> {
      return { hits: 0, misses: 0, size: store.size, evictions: 0 }
    },
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('attachPersistedEditsPersistence', () => {
  let handle: PendingEditsPersistenceHandle | null = null

  beforeEach(() => setActivePinia(createPinia()))

  afterEach(() => {
    handle?.dispose()
    handle = null
  })

  it('hydrates the store from a previously-persisted snapshot', async () => {
    const cache = fakeAdminCache()
    const persisted: PersistedEditsSnapshot = {
      version: 1,
      entries: [
        [
          'page:home::_root',
          { key: 'page:home::_root', editedContent: { title: 'Mine' }, updatedAt: '2026-05-06T22:00:00Z' },
        ],
        [
          'page:about::hero',
          { key: 'page:about::hero', editedContent: { headline: 'Hi' }, updatedAt: '2026-05-06T22:01:00Z' },
        ],
      ],
    }
    cache._store.set('pending-edits:dirty', persisted)

    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated

    const store = usePersistedEditsStore()
    expect(store.count).toBe(2)
    expect(store.get('page:home::_root')!.editedContent).toEqual({ title: 'Mine' })
    expect(store.get('page:about::hero')!.editedContent).toEqual({ headline: 'Hi' })
  })

  it('writes a snapshot to the cache after a mutation (debounced)', async () => {
    const cache = fakeAdminCache()
    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated

    const store = usePersistedEditsStore()
    store.set('page:home::_root', { title: 'Hello' })

    await settle()
    await settle()

    const persisted = cache._store.get('pending-edits:dirty') as PersistedEditsSnapshot | undefined
    expect(persisted).toBeDefined()
    expect(persisted!.version).toBe(1)
    expect(persisted!.entries).toHaveLength(1)
    expect(persisted!.entries[0][0]).toBe('page:home::_root')
    expect(persisted!.entries[0][1].editedContent).toEqual({ title: 'Hello' })
  })

  it('invalidates the cache key when the store empties out', async () => {
    const cache = fakeAdminCache()
    cache._store.set('pending-edits:dirty', {
      version: 1,
      entries: [
        ['page:home::_root', { key: 'page:home::_root', editedContent: { x: 1 }, updatedAt: '2026-05-06T22:00:00Z' }],
      ],
    })

    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated
    expect(usePersistedEditsStore().count).toBe(1)

    usePersistedEditsStore().clear('page:home::_root')
    await settle()
    await settle()

    expect(cache._store.has('pending-edits:dirty')).toBe(false)
  })

  it('debounces multiple mutations into one write', async () => {
    const cache = fakeAdminCache()
    const setSpy = vi.spyOn(cache, 'set')
    handle = attachPersistedEditsPersistence(cache, { debounceMs: 50 })
    await handle.hydrated
    setSpy.mockClear()

    const store = usePersistedEditsStore()
    store.set('a', { x: 1 })
    store.set('a', { x: 2 })
    store.set('a', { x: 3 })

    await settle()
    expect(setSpy).not.toHaveBeenCalled()

    await new Promise(resolve => setTimeout(resolve, 80))
    expect(setSpy).toHaveBeenCalledTimes(1)
    const written = setSpy.mock.calls[0][1] as PersistedEditsSnapshot
    expect(written.entries[0][1].editedContent).toEqual({ x: 3 })
  })

  it('hydration on empty cache is a no-op', async () => {
    const cache = fakeAdminCache()
    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated
    expect(usePersistedEditsStore().count).toBe(0)
  })

  it('hydration ignores wrong-version snapshots', async () => {
    const cache = fakeAdminCache()
    cache._store.set('pending-edits:dirty', {
      version: 99,
      entries: [['page:home::_root', { key: 'page:home::_root', editedContent: { x: 1 }, updatedAt: '' }]],
    })

    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated
    expect(usePersistedEditsStore().count).toBe(0)
  })

  it('hydration skips malformed entries but keeps valid ones', async () => {
    // Defensive: out-of-band corruption or future schema migration
    // could write entries we can't parse. One bad row shouldn't kill
    // restoration of valid rows.
    const cache = fakeAdminCache()
    cache._store.set('pending-edits:dirty', {
      version: 1,
      entries: [
        // Bad: editedContent is a string, not an object
        ['malformed', { key: 'malformed', editedContent: 'not-an-object', updatedAt: '' }],
        // Good
        ['page:home::_root', { key: 'page:home::_root', editedContent: { title: 'Mine' }, updatedAt: '' }],
        // Bad: null entry
        ['null-entry', null],
        // Bad: non-string key (TypeScript would catch this; runtime
        // cache might not)
      ],
    })

    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated

    const store = usePersistedEditsStore()
    expect(store.has('page:home::_root')).toBe(true)
    expect(store.has('malformed')).toBe(false)
    expect(store.has('null-entry')).toBe(false)
  })

  it('dispose() stops the watcher', async () => {
    const cache = fakeAdminCache()
    const setSpy = vi.spyOn(cache, 'set')
    handle = attachPersistedEditsPersistence(cache, { debounceMs: 0 })
    await handle.hydrated
    setSpy.mockClear()

    handle.dispose()
    handle = null

    usePersistedEditsStore().set('page:home::_root', { title: 'Mine' })
    await settle()
    await settle()

    expect(setSpy).not.toHaveBeenCalled()
  })
})
