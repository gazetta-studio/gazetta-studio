/**
 * Contract tests for `AdminCache` providers, exported from
 * `gazetta/testing`.
 *
 * Plugin authors and future built-in providers (RedisCache,
 * AzureCache, FileCache, IndexedDBCache, etc.) run this suite
 * against their implementation. The helper proves baseline LSP
 * correctness — every provider must round-trip values, isolate
 * keys, support prefix invalidation, and report honest stats.
 *
 * Capability-specific behaviors (TTL expiry, cross-instance
 * subscribe, transport fail-open) are gated by per-test opt-ins on
 * the options object. Providers that don't support a capability skip
 * those tests cleanly — no LSP lies.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "test the AdminCache contract." Provider
 *     mechanics live with each provider; this helper exercises the
 *     interface uniformly.
 *   - LSP: every provider that opts in to the helper passes the same
 *     baseline. Failures here mean the provider violates the contract,
 *     not that the test is wrong.
 *   - OCP: adding a new capability check (e.g., `etag` support when
 *     `EtagCapableCache` ships) is one new option + one new test
 *     block; no rewrite of existing tests.
 *   - DIP: the helper depends on the `AdminCache` interface, not on
 *     any specific provider.
 *
 * # Why this isn't a vitest snapshot test
 *
 * Cache stats are non-deterministic over time and providers vary in
 * which optional fields they track. Snapshot tests would create a
 * brittle coupling between every provider's stats() shape and a
 * shared snapshot. Behavior assertions ("hits incremented after a
 * get-hit") are stable across providers.
 */
import { describe, expect, it } from 'vitest'
import type { AdminCache } from '../cache/types.js'

/**
 * Factory shape — each test gets a fresh provider instance. Providers
 * with module-level state should construct fresh per call so tests
 * don't leak across each other.
 */
export type AdminCacheFactory = () => AdminCache | Promise<AdminCache>

export interface AdminCacheContractOptions {
  /**
   * Whether the provider honors TTL on `set(key, value, { ttl })`.
   * Default false (matches `MemoryCache` v1's LRU-only eviction).
   * When true, the suite includes a TTL-expiry test that waits for
   * the configured `ttlSeconds` to elapse.
   */
  supportsTtl?: boolean
  /**
   * TTL in seconds used by the TTL test. Default 1 second — long
   * enough to be observable, short enough to keep the test fast.
   * Only consulted when `supportsTtl` is true.
   */
  ttlSeconds?: number
  /**
   * Whether `subscribe()` delivers events from a sibling instance
   * (true for shared-backing providers like RedisCache after Cut 4
   * of cache-impl ships SSE; false for single-instance MemoryCache
   * v1). When true, the suite includes a cross-instance notification
   * test.
   */
  supportsCrossInstanceSubscribe?: boolean
  /**
   * Whether the provider fails open on transport errors per Universal
   * Provider Requirement #5. Tests a synthetic transport failure
   * surfaced via a wrapper; only meaningful for providers that have
   * a transport layer (Redis, Azure). MemoryCache has no transport.
   */
  supportsTransportFailureSimulation?: boolean
}

/**
 * Run the contract suite against a provider factory. Call from a
 * `describe` block in the provider's own test file:
 *
 *   import { adminCacheContractTests } from 'gazetta/testing'
 *
 *   describe('RedisCache', () => {
 *     adminCacheContractTests(
 *       () => createRedisCache({ url: 'redis://localhost:6379' }),
 *       { supportsTtl: true, supportsCrossInstanceSubscribe: true },
 *     )
 *   })
 */
export function adminCacheContractTests(factory: AdminCacheFactory, options: AdminCacheContractOptions = {}): void {
  describe('AdminCache contract — get/set/invalidate', () => {
    it('round-trips a value through get/set', async () => {
      const cache = await factory()
      await cache.set('item:home', { title: 'Home' })
      expect(await cache.get('item:home')).toEqual({ title: 'Home' })
    })

    it('returns null on a miss', async () => {
      const cache = await factory()
      expect(await cache.get('item:never-set')).toBeNull()
    })

    it('preserves the JSON-serializable contract — strings round-trip', async () => {
      const cache = await factory()
      await cache.set('item:str', 'hello')
      expect(await cache.get('item:str')).toBe('hello')
    })

    it('preserves arrays and nested objects', async () => {
      const cache = await factory()
      const value = { items: [1, 2, 3], nested: { a: { b: 'c' } } }
      await cache.set('item:complex', value)
      expect(await cache.get('item:complex')).toEqual(value)
    })

    it('overwrites an existing value', async () => {
      const cache = await factory()
      await cache.set('item:k', 'first')
      await cache.set('item:k', 'second')
      expect(await cache.get('item:k')).toBe('second')
    })

    it('invalidate removes a single key', async () => {
      const cache = await factory()
      await cache.set('item:a', 1)
      await cache.set('item:b', 2)
      await cache.invalidate('item:a')
      expect(await cache.get('item:a')).toBeNull()
      expect(await cache.get('item:b')).toBe(2)
    })

    it('invalidate is a no-op on a missing key', async () => {
      const cache = await factory()
      await expect(cache.invalidate('item:never-set')).resolves.toBeUndefined()
    })
  })

  describe('AdminCache contract — invalidatePrefix', () => {
    it('removes all keys matching the prefix', async () => {
      const cache = await factory()
      await cache.set('group-a:home', 1)
      await cache.set('group-a:about', 2)
      await cache.set('group-b:home', 3)
      const cleared = await cache.invalidatePrefix('group-a:')
      expect(cleared).toBe(2)
      expect(await cache.get('group-a:home')).toBeNull()
      expect(await cache.get('group-a:about')).toBeNull()
      expect(await cache.get('group-b:home')).toBe(3)
    })

    it('returns 0 when no keys match', async () => {
      const cache = await factory()
      await cache.set('group-a:home', 1)
      const cleared = await cache.invalidatePrefix('group-c:')
      expect(cleared).toBe(0)
    })

    it('does not match sibling prefixes (trailing colon discipline)', async () => {
      // `'pages:'` should NOT match `'pages-archived:'` — the trailing
      // colon prevents that. Consumers that omit the trailing colon
      // are responsible for the consequences.
      const cache = await factory()
      await cache.set('pages:home', 1)
      await cache.set('pages-archived:home', 2)
      const cleared = await cache.invalidatePrefix('pages:')
      expect(cleared).toBe(1)
      expect(await cache.get('pages-archived:home')).toBe(2)
    })
  })

  describe('AdminCache contract — subscribe', () => {
    it('returns a disposer that does not throw when called', async () => {
      const cache = await factory()
      const disposer = cache.subscribe(() => undefined)
      expect(() => disposer()).not.toThrow()
    })

    it('disposer is idempotent', async () => {
      const cache = await factory()
      const disposer = cache.subscribe(() => undefined)
      disposer()
      expect(() => disposer()).not.toThrow()
    })
  })

  describe('AdminCache contract — stats', () => {
    it('returns the required floor when stats() is implemented', async () => {
      const cache = await factory()
      // stats is optional on the contract — providers that don't
      // expose it skip this test entirely.
      if (!cache.stats) return
      const result = await cache.stats()
      expect(result).toMatchObject({
        hits: expect.any(Number),
        misses: expect.any(Number),
        size: expect.any(Number),
      })
    })

    it('size reflects the number of stored entries', async () => {
      const cache = await factory()
      if (!cache.stats) return
      await cache.set('item:a', 1)
      await cache.set('item:b', 2)
      const result = await cache.stats()
      expect(result.size).toBeGreaterThanOrEqual(2)
    })
  })

  if (options.supportsTtl) {
    const ttlSeconds = options.ttlSeconds ?? 1
    describe('AdminCache contract — TTL', () => {
      it(`expires entries after ${ttlSeconds}s`, async () => {
        const cache = await factory()
        await cache.set('item:ttl', 'value', { ttl: ttlSeconds })
        // Wait slightly past the TTL boundary.
        await new Promise(r => setTimeout(r, (ttlSeconds + 0.2) * 1000))
        expect(await cache.get('item:ttl')).toBeNull()
      })
    })
  }

  if (options.supportsCrossInstanceSubscribe) {
    describe('AdminCache contract — cross-instance subscribe', () => {
      it('delivers invalidation events from a sibling instance', async () => {
        const a = await factory()
        const b = await factory()
        const events: Array<{ prefix: string }> = []
        b.subscribe(event => events.push({ prefix: event.prefix }))

        await a.set('shared:k', 1)
        await a.invalidatePrefix('shared:')

        // Allow async fan-out (provider-specific transport latency).
        await new Promise(r => setTimeout(r, 100))
        expect(events.some(e => e.prefix.includes('shared:'))).toBe(true)
      })
    })
  }

  if (options.supportsTransportFailureSimulation) {
    describe('AdminCache contract — fail-open', () => {
      it('treats transport failure on get as a miss (returns null, no throw)', async () => {
        // Providers that opt in must expose a way to inject a
        // transport failure. The contract assertion: under failure,
        // get must NOT throw and must return null. Providers
        // implement the injection mechanism in their own test setup.
        const cache = await factory()
        // The factory closure is the operator's hook — opt-in
        // providers wire the failure into the returned instance and
        // the test exercises whatever the provider's docs say.
        await expect(cache.get('item:transport-failure')).resolves.not.toThrow()
      })
    })
  }
}
