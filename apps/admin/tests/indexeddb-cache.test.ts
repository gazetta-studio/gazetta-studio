/**
 * Validate `IndexedDBCache` against the shared `adminCacheContractTests`
 * suite from `gazetta/testing`. Same baseline contract as the
 * server-side `MemoryCache` — proves LSP correctness for the L4↔L6
 * cache architecture.
 *
 * vitest's jsdom environment doesn't include IndexedDB, so we
 * polyfill via `fake-indexeddb/auto`. The `auto` import sets up
 * `globalThis.indexedDB` and `globalThis.IDBKeyRange` before any
 * test runs.
 *
 * Each contract test gets a fresh database (unique `dbName`) so
 * tests don't share state. fake-indexeddb stores everything in
 * memory; cleanup happens implicitly when the provider goes out of
 * scope.
 */
import 'fake-indexeddb/auto'
import { describe } from 'vitest'
import { adminCacheContractTests } from 'gazetta/testing'
import { createIndexedDBCache } from '../src/client/cache/indexeddb-cache.js'

describe('IndexedDBCache satisfies the AdminCache contract', () => {
  let counter = 0
  adminCacheContractTests(() => createIndexedDBCache({ dbName: `gazetta-test-${++counter}` }), {
    // IndexedDBCache evicts via LRS, not TTL — same as MemoryCache.
    supportsTtl: false,
    // Cross-tab fan-out via BroadcastChannel lands in offline Cut 4.
    supportsCrossInstanceSubscribe: false,
    // No transport — IndexedDB calls go to local storage, no network.
    supportsTransportFailureSimulation: false,
  })
})
