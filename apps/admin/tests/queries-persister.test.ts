/**
 * Round-trip a `PersistedClient` through the Gazetta persister to
 * pin two contracts:
 *
 *   1. The adapter chain (persister → AsyncStorage → AdminCache)
 *      preserves the dehydrated query state byte-for-byte through
 *      a save+restore cycle.
 *
 *   2. The `buster` parameter discards the persisted client when it
 *      changes — the cache-reset hook for Gazetta major-version
 *      upgrades.
 *
 * Uses a fake `AdminCache` for the same reasons as the storage-
 * adapter test (provider-agnostic; no IndexedDB needed).
 */
import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'
import {
  type PersistedClient,
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/query-persist-client-core'
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'
import { createGazettaPersister } from '../src/client/queries/persister.js'

function fakeAdminCache(): AdminCache {
  const store = new Map<string, unknown>()
  return {
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

describe('createGazettaPersister', () => {
  it('round-trips a populated QueryClient through save → restore', async () => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })

    // Save phase: build a client, populate it, persist.
    const saving = new QueryClient()
    saving.setQueryData(['pages'], [{ name: 'home', route: '/' }])
    saving.setQueryData(['fragments'], [{ name: 'header' }])
    await persistQueryClientSave({ queryClient: saving, persister })

    // Restore phase: fresh client (empty), hydrate from persisted.
    const restoring = new QueryClient()
    expect(restoring.getQueryData(['pages'])).toBeUndefined()
    await persistQueryClientRestore({ queryClient: restoring, persister })
    expect(restoring.getQueryData(['pages'])).toEqual([{ name: 'home', route: '/' }])
    expect(restoring.getQueryData(['fragments'])).toEqual([{ name: 'header' }])
  })

  it('returns null restore on empty cache (no persisted client)', async () => {
    const cache = fakeAdminCache()
    const persister = createGazettaPersister(cache, { throttleTime: 0 })
    const persisted = await persister.restoreClient()
    expect(persisted).toBeUndefined()
  })

  it('discards persisted client when buster changes', async () => {
    const cache = fakeAdminCache()
    // Save with buster=v1.
    const persisterV1 = createGazettaPersister(cache, { throttleTime: 0 })
    const saving = new QueryClient()
    saving.setQueryData(['pages'], [{ name: 'home' }])
    await persistQueryClientSave({ queryClient: saving, persister: persisterV1, buster: 'v1' })

    // Restore with buster=v2 — different buster, persistQueryClientRestore
    // should evict and not hydrate.
    const persisterV2 = createGazettaPersister(cache, { throttleTime: 0 })
    const restoring = new QueryClient()
    await persistQueryClientRestore({
      queryClient: restoring,
      persister: persisterV2,
      buster: 'v2',
    })
    expect(restoring.getQueryData(['pages'])).toBeUndefined()
  })

  it('uses a stable default key (one persisted client per origin)', async () => {
    // Two persister instances against the same cache share the same
    // storage key — both see each other's writes. Pins the
    // single-Site-per-process invariant from the design doc.
    const cache = fakeAdminCache()
    const persister1 = createGazettaPersister(cache, { throttleTime: 0 })
    const persister2 = createGazettaPersister(cache, { throttleTime: 0 })

    const persisted: PersistedClient = {
      buster: '',
      timestamp: Date.now(),
      clientState: { mutations: [], queries: [] },
    }
    await persister1.persistClient(persisted)
    const restored = await persister2.restoreClient()
    expect(restored?.timestamp).toBe(persisted.timestamp)
  })
})
