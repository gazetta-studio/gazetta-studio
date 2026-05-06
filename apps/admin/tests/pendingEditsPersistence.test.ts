/**
 * Verify the pending-edits persistence coordinator wires the
 * editorStructural Pinia store to an `AdminCache` correctly:
 *
 *   - On attach: hydrates the store from any previously-persisted
 *     snapshot
 *   - On mutation: debounce-writes a fresh snapshot
 *   - On empty: invalidates the cache key (no zombie empty payload)
 *
 * Uses an in-memory fake `AdminCache` so the test exercises the
 * coordinator's contract without dragging in `fake-indexeddb`. The
 * cache contract is already validated against `IndexedDBCache` via
 * the contract suite in indexeddb-cache.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'
import type { ComponentEntry } from 'gazetta/types'
import { useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import {
  attachPendingEditsPersistence,
  type PendingEditsPersistenceHandle,
} from '../src/client/stores/_pendingEditsPersistence.js'

interface PersistedStructural {
  version: 1
  entries: Array<[string, { original: ComponentEntry[]; pending: ComponentEntry[] }]>
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

/** Settle pending microtasks + Vue's reactivity scheduler. */
async function settle(): Promise<void> {
  // Vue's watch callbacks run on the next microtask after a reactive
  // mutation; awaiting one tick is enough.
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('attachPendingEditsPersistence — editorStructural', () => {
  let handle: PendingEditsPersistenceHandle | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    handle?.dispose()
    handle = null
  })

  it('hydrates the store from a previously-persisted snapshot', async () => {
    const cache = fakeAdminCache()
    const persisted: PersistedStructural = {
      version: 1,
      entries: [
        [
          'page:home',
          {
            original: ['hero', 'features'],
            pending: ['features', 'hero'],
          },
        ],
      ],
    }
    cache._store.set('pending-edits:structural', persisted)

    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated

    const store = useEditorStructuralStore()
    expect(store.pendingFor({ kind: 'page', name: 'home' })).toEqual(['features', 'hero'])
    expect(store.pendingCount).toBe(1)
  })

  it('writes a snapshot to the cache after a mutation (debounced)', async () => {
    const cache = fakeAdminCache()
    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated

    const store = useEditorStructuralStore()
    store.moveComponent({ kind: 'page', name: 'home' }, ['a', 'b', 'c'], 0, 2)

    // Debounce 0 + Vue's tick + the setTimeout(0) inside the watcher.
    // Two ticks for safety.
    await settle()
    await settle()

    const persisted = cache._store.get('pending-edits:structural') as PersistedStructural | undefined
    expect(persisted).toBeDefined()
    expect(persisted?.version).toBe(1)
    expect(persisted?.entries).toHaveLength(1)
    expect(persisted?.entries[0][0]).toBe('page:home')
    expect(persisted?.entries[0][1].pending).toEqual(['b', 'c', 'a'])
  })

  it('invalidates the cache key when the store empties out', async () => {
    const cache = fakeAdminCache()
    // Pre-seed cache so we can verify it gets cleared.
    cache._store.set('pending-edits:structural', {
      version: 1,
      entries: [['page:home', { original: ['a'], pending: ['b'] }]],
    })

    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated

    const store = useEditorStructuralStore()
    expect(store.pendingCount).toBe(1)

    store.discard({ kind: 'page', name: 'home' })

    await settle()
    await settle()

    expect(cache._store.has('pending-edits:structural')).toBe(false)
  })

  it('debounces multiple mutations into one write', async () => {
    const cache = fakeAdminCache()
    const setSpy = vi.spyOn(cache, 'set')
    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 50 })
    await handle.hydrated
    setSpy.mockClear()

    const store = useEditorStructuralStore()
    const key = { kind: 'page' as const, name: 'home' }
    store.addComponent(key, [], 'hero')
    store.addComponent(key, ['hero'], 'features')
    store.addComponent(key, ['hero', 'features'], 'footer')

    // No write yet — debounce hasn't fired.
    await settle()
    expect(setSpy).not.toHaveBeenCalled()

    // After the debounce window, exactly one write captures the
    // final state.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(setSpy).toHaveBeenCalledTimes(1)
    const written = setSpy.mock.calls[0][1] as PersistedStructural
    expect(written.entries[0][1].pending).toEqual(['hero', 'features', 'footer'])
  })

  it('hydration on empty cache is a no-op', async () => {
    const cache = fakeAdminCache()
    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated

    const store = useEditorStructuralStore()
    expect(store.pendingCount).toBe(0)
  })

  it('hydration ignores wrong-version snapshots', async () => {
    const cache = fakeAdminCache()
    cache._store.set('pending-edits:structural', {
      version: 99,
      entries: [['page:home', { original: [], pending: [] }]],
    })

    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated

    const store = useEditorStructuralStore()
    expect(store.pendingCount).toBe(0)
  })

  it('preserves the discard baseline across hydration', async () => {
    // Pin: hydration restores `original` (the discard baseline) AS-IS,
    // not as a copy of `pending`. Without _hydrateFromSnapshot using the
    // intent-named mutators would re-record original from the call site,
    // breaking discard.
    const cache = fakeAdminCache()
    const persisted: PersistedStructural = {
      version: 1,
      entries: [
        [
          'page:home',
          {
            original: ['original-1', 'original-2'],
            pending: ['changed-order', 'original-1'],
          },
        ],
      ],
    }
    cache._store.set('pending-edits:structural', persisted)

    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated

    const store = useEditorStructuralStore()
    const key = { kind: 'page' as const, name: 'home' }

    // Now discard — should revert to the original baseline.
    store.discard(key)
    expect(store.pendingFor(key)).toBeNull()
  })

  it('dispose() stops the watcher', async () => {
    const cache = fakeAdminCache()
    const setSpy = vi.spyOn(cache, 'set')
    handle = attachPendingEditsPersistence(cache, { structuralDebounceMs: 0 })
    await handle.hydrated
    setSpy.mockClear()

    handle.dispose()
    handle = null

    const store = useEditorStructuralStore()
    store.addComponent({ kind: 'page', name: 'home' }, [], 'hero')

    await settle()
    await settle()

    expect(setSpy).not.toHaveBeenCalled()
  })
})
