/**
 * Run the `adminCacheContractTests` helper against the in-tree
 * `MemoryCache` provider.
 *
 * Two purposes:
 *   1. Proves the helper itself is correct — if MemoryCache fails
 *      the contract, either the helper or the provider is wrong.
 *   2. Acts as the reference example for plugin authors — copy this
 *      file, swap the factory, point at your provider.
 *
 * MemoryCache opts in to none of the capability flags:
 *   - supportsTtl: false (LRU-only eviction in v1; design-cache.md
 *     Cut 2 doc explicitly notes this)
 *   - supportsCrossInstanceSubscribe: false (single-instance until
 *     Cut 4 ships SSE)
 *   - supportsTransportFailureSimulation: false (no transport)
 */
import { describe } from 'vitest'
import { createMemoryCache } from '../src/cache/memory.js'
import { adminCacheContractTests } from '../src/testing/admin-cache-contract.js'

describe('MemoryCache satisfies the AdminCache contract', () => {
  adminCacheContractTests(() => createMemoryCache())
})
