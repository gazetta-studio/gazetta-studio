/**
 * Adapter that exposes our `AdminCache` as TanStack's `AsyncStorage<string>`
 * — the storage interface `createAsyncStoragePersister` expects.
 *
 * The persister stores ONE serialized `PersistedClient` (the entire
 * Vue Query cache + mutation queue) under a single key. The adapter
 * forwards that key/value through `AdminCache.get/set/invalidate`,
 * which under the hood lands in the L6 store (IndexedDB or, when
 * IndexedDB is unavailable, the browser-side MemoryCache fallback).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "translate TanStack's storage shape to
 *     `AdminCache`'s shape." It does not know about the persister
 *     itself, the QueryClient, or BroadcastChannel — those are
 *     siblings in `queries/`.
 *   - DIP: takes any `AdminCache`. The selector picks IndexedDB or
 *     memory; the adapter doesn't care which. The same Vue Query
 *     setup works for both.
 *   - LSP: substitutable for any other `AsyncStorage<string>` —
 *     conforms to the documented interface from
 *     `@tanstack/query-async-storage-persister`.
 *
 * # What about prefix isolation?
 *
 * The persister already prefixes its key (`PERSISTER_KEY_PREFIX` +
 * the operator-supplied `key`). Adding our own prefix here would
 * double-prefix and complicate cache-prefix invalidation when the
 * persister wants to clear its entry. So we pass the key through
 * verbatim. The single-Site-per-process invariant means we don't
 * need extra namespacing — one site, one cache, one persisted
 * client per origin.
 */
import type { AdminCache } from 'gazetta'

/**
 * The minimum subset of TanStack's `AsyncStorage<string>` we need.
 * Inlined as a type rather than imported from `@tanstack/...` so
 * this module compiles without pulling TanStack's full type graph
 * into every consumer.
 */
export interface AsyncStringStorage {
  getItem(key: string): Promise<string | undefined | null>
  setItem(key: string, value: string): Promise<unknown>
  removeItem(key: string): Promise<void>
}

/**
 * Build an `AsyncStringStorage` adapter over the given `AdminCache`.
 * Returned object is stateless beyond the closure on `cache`; safe
 * to construct once at admin boot and reuse.
 */
export function cacheAsyncStorage(cache: AdminCache): AsyncStringStorage {
  return {
    async getItem(key: string): Promise<string | null> {
      // AdminCache.get<T>() returns null on miss; that matches the
      // persister's "no persisted client yet" expectation.
      return cache.get<string>(key)
    },
    async setItem(key: string, value: string): Promise<void> {
      // No TTL — the persister expects manual eviction via
      // removeItem, and our LRS / LRU eviction at the cache cap
      // handles the catastrophic case.
      await cache.set(key, value)
    },
    async removeItem(key: string): Promise<void> {
      await cache.invalidate(key)
    },
  }
}
