/**
 * Verify the `cacheAsyncStorage` adapter conforms to TanStack's
 * `AsyncStorage<string>` interface and forwards correctly to the
 * underlying `AdminCache`.
 *
 * Uses an in-memory fake `AdminCache` rather than `IndexedDBCache`
 * — the adapter is provider-agnostic, so a fake exercises the
 * interface without dragging in `fake-indexeddb`. Cuts 3-4 already
 * cover the IndexedDB and broadcast paths separately.
 */
import { describe, expect, it } from 'vitest'
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'
import { cacheAsyncStorage } from '../src/client/queries/storage-adapter.js'

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

describe('cacheAsyncStorage adapter', () => {
  it('round-trips a string through getItem / setItem', async () => {
    const cache = fakeAdminCache()
    const storage = cacheAsyncStorage(cache)
    await storage.setItem('persisted', '{"foo":"bar"}')
    expect(await storage.getItem('persisted')).toBe('{"foo":"bar"}')
  })

  it('returns null on miss', async () => {
    const cache = fakeAdminCache()
    const storage = cacheAsyncStorage(cache)
    expect(await storage.getItem('absent')).toBeNull()
  })

  it('removeItem clears the entry', async () => {
    const cache = fakeAdminCache()
    const storage = cacheAsyncStorage(cache)
    await storage.setItem('k', 'v')
    await storage.removeItem('k')
    expect(await storage.getItem('k')).toBeNull()
  })

  it('forwards keys verbatim — no extra prefix', async () => {
    // The persister applies its own `tanstack-query-` prefix; the
    // adapter must NOT add another prefix on top, or
    // prefix-invalidation in the underlying AdminCache would have to
    // know about the double layer.
    const cache = fakeAdminCache()
    const storage = cacheAsyncStorage(cache)
    await storage.setItem('exact-key', 'value')
    expect(cache._store.has('exact-key')).toBe(true)
  })
})
