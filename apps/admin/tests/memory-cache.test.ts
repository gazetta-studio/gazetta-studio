/**
 * Validate `createBrowserMemoryCache` against the shared
 * `adminCacheContractTests` suite (same baseline contract as the
 * IndexedDB provider — proves LSP correctness across both
 * browser-side providers).
 *
 * The browser MemoryCache is the IndexedDB-fallback path per Cut 3:
 * when the IDB probe fails (Safari Lockdown, private mode), the
 * selector returns this provider. Without direct contract coverage,
 * a regression in the fallback path could ship silently — caches
 * still "work" for trivial round-trips but could break invariants
 * (eviction, subscribe semantics, stats).
 *
 * Mirrors the shape of indexeddb-cache.test.ts.
 */
import { describe } from 'vitest'
import { adminCacheContractTests } from 'gazetta/testing'
import { createBrowserMemoryCache } from '../src/client/cache/memory-cache.js'

describe('createBrowserMemoryCache satisfies the AdminCache contract', () => {
  adminCacheContractTests(() => Promise.resolve(createBrowserMemoryCache()), {
    // LRU-only eviction; ignores TTL options just like server-side
    // MemoryCache.
    supportsTtl: false,
    // Browser-side: no cross-instance subscribe; events stay
    // in-tab. Cross-tab fan-out is IndexedDBCache's territory
    // (BroadcastChannel, Cut 4).
    supportsCrossInstanceSubscribe: false,
    // Pure JS Map under the hood; no transport to fail.
    supportsTransportFailureSimulation: false,
  })
})
