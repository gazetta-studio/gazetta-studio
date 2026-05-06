/**
 * `MemoryCache` — process-internal `AdminCache` provider. v1 default.
 *
 * Per-instance scope; multi-instance-correct via independence (each
 * instance receives SSE invalidation for its own writes via Cut 4's
 * bridge). LRU eviction at configured caps; stats track operational
 * counters.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the in-memory provider. Stats, LRU,
 *     subscribe handling all live here because they're one cohesive
 *     "memory cache" concern; splitting would fragment.
 *   - LSP: substitutable for any future `AdminCache` provider via
 *     the contract test helper (Cut 10).
 *   - DIP: consumers depend on `AdminCache`, not `createMemoryCache`.
 *
 * # subscribe() in Cut 2 (no-op honest semantics)
 *
 * The contract is "events from other instances." Cut 2 ships
 * single-instance MemoryCache with no SSE bridge — there ARE no
 * other instances, so handlers register but no events fire. Cut 4
 * modifies this file to wire EventEmitter for the SSE bridge to
 * deliver cross-instance events.
 *
 * This is honest behavior, not a stub-throwing-not-implemented:
 *   - subscribe() returns a working disposer
 *   - handlers ARE in the registered set
 *   - events would fire if any source emitted them
 *   - it's just that v1 single-instance has no source
 */
import { applyKeyPolicy, applyPrefixPolicy } from './keys.js'
import type { AdminCache, CacheStats, InvalidationEvent } from './types.js'

/**
 * Options for constructing an in-process `MemoryCache`. Both fields
 * optional; defaults are 10,000 entries and 50 MB approximate.
 *
 * Lives on the factory signature (rather than as a separate `*Config`
 * interface in `types.ts`) per Phase 3 of the Path X migration — the
 * options type is provider-specific construction config, not a
 * runtime-manifest field.
 */
export interface MemoryCacheOptions {
  /** Max entry count before LRU eviction kicks in. Default 10,000. */
  maxEntries?: number
  /** Approximate max bytes before LRU eviction kicks in. Default 50 MB. */
  maxBytes?: number
}

/** Default cap when operator config doesn't override. */
const DEFAULT_MAX_ENTRIES = 10_000
/** Default cap when operator config doesn't override. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

interface CacheEntry {
  value: unknown
  /** Approximate byte size — `JSON.stringify(value).length`. */
  bytes: number
}

/**
 * Build a `MemoryCache` instance. Internal factory — kept public for
 * tests and advanced wiring. Operators use the operator-facing
 * `memoryCache()` factory exported from `gazetta` (Path X), which
 * delegates here.
 */
export function createMemoryCache(config: MemoryCacheOptions = {}): AdminCache {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES

  // Map insertion order is the LRU order; access touches it via
  // delete+set on hit (Map.set on existing key preserves order, so
  // the explicit delete-then-set is required to bump recency).
  const entries = new Map<string, CacheEntry>()
  let totalBytes = 0

  // Cross-instance event subscribers. Cut 2 never invokes these
  // (no SSE bridge yet); Cut 4 wires emit on incoming SSE messages.
  const subscribers = new Set<(event: InvalidationEvent) => void>()

  // Operational counters surfaced via stats() per design-cache.md Q5.
  let hits = 0
  let misses = 0
  let evictions = 0
  let lastInvalidation: { prefix: string; at: string; source: string } | undefined

  function evictOldestIfOverCap(): void {
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) return
      const entry = entries.get(oldestKey)
      entries.delete(oldestKey)
      if (entry) totalBytes -= entry.bytes
      evictions++
    }
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const wrapped = applyKeyPolicy(key)
      const entry = entries.get(wrapped)
      if (!entry) {
        misses++
        return null
      }
      // LRU touch — delete + re-insert moves to end (most recent).
      entries.delete(wrapped)
      entries.set(wrapped, entry)
      hits++
      return entry.value as T
    },

    async set<T>(key: string, value: T, _opts?: { ttl?: number }): Promise<void> {
      // TTL is part of the AdminCache contract but MemoryCache v1
      // doesn't honor it — eviction is LRU-only. A future TTL pass
      // (or a TTL-aware provider) handles expiry.
      const wrapped = applyKeyPolicy(key)
      const bytes = JSON.stringify(value).length
      const existing = entries.get(wrapped)
      if (existing) {
        totalBytes -= existing.bytes
        entries.delete(wrapped)
      }
      entries.set(wrapped, { value, bytes })
      totalBytes += bytes
      evictOldestIfOverCap()
    },

    async invalidate(key: string): Promise<void> {
      const wrapped = applyKeyPolicy(key)
      const entry = entries.get(wrapped)
      if (!entry) return
      entries.delete(wrapped)
      totalBytes -= entry.bytes
    },

    async invalidatePrefix(prefix: string): Promise<number> {
      const wrapped = applyPrefixPolicy(prefix)
      let cleared = 0
      for (const [key, entry] of entries) {
        if (key.startsWith(wrapped)) {
          entries.delete(key)
          totalBytes -= entry.bytes
          cleared++
        }
      }
      lastInvalidation = {
        prefix,
        at: new Date().toISOString(),
        source: 'local',
      }
      return cleared
    },

    subscribe(handler: (event: InvalidationEvent) => void): () => void {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },

    async stats(): Promise<CacheStats> {
      return {
        hits,
        misses,
        size: entries.size,
        evictions,
        bytesApproximate: totalBytes,
        lastInvalidation,
      }
    },
  }
}
