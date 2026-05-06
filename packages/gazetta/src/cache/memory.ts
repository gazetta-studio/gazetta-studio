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
 * # subscribe() — local emission per Cut 4
 *
 * The contract evolved during Cut 4. The original framing was "events
 * from other instances," with single-instance providers as honest
 * no-ops. Real consumers (the L4→L6 server-to-browser cascade per
 * `design-cache.md` "Offline composition") need server-side L4
 * invalidations to reach browser-side L6 caches. From the browser's
 * POV the server IS another instance, so the right contract is
 * "events from any source" — including local ones.
 *
 * `invalidate()` and `invalidatePrefix()` fire to subscribers with
 * the **input** key/prefix (the consumer-facing form passed to the
 * method). The `applyKeyPolicy` version prefix and overflow-hash are
 * provider-internal storage details — they don't leak to event
 * payloads.
 *
 * `forSite()` filters events whose prefix doesn't belong to the
 * wrapping site (cross-site events from a future shared backing
 * service); the SSE bridge subscribes to the forSite wrapper and
 * sees consumer-facing prefixes.
 */
import { randomBytes } from 'node:crypto'
import { applyKeyPolicy, applyPrefixPolicy } from './keys.js'
import type { AdminCache, CacheStats, InvalidationEvent } from './types.js'

/**
 * Options for constructing an in-process `MemoryCache`. All fields
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
  /**
   * Stable identifier emitted on `InvalidationEvent.source.instance`.
   * Defaults to a random 8-char hex generated once per construction.
   * Plays the same role as Kubernetes pod / Cloud Run revision IDs in
   * future shared-backing providers (per `design-logging.md`).
   */
  instance?: string
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
  const instance = config.instance ?? randomBytes(4).toString('hex')

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

  /**
   * Notify subscribers of an invalidation. `prefix` is the **input**
   * form (what the consumer passed to invalidate / invalidatePrefix);
   * the version-prefix + overflow-hash applied by `applyKeyPolicy` is
   * a storage encoding detail and never reaches event payloads.
   *
   * Subscribers that throw shouldn't poison sibling subscribers —
   * each notification is wrapped in a try/catch. The error is
   * swallowed (subscribe is observational; failing-open keeps the
   * invalidation honest from the caller's POV).
   */
  function emit(prefix: string): void {
    if (subscribers.size === 0) return
    const event: InvalidationEvent = {
      prefix,
      source: { instance, timestamp: new Date().toISOString() },
    }
    for (const handler of subscribers) {
      try {
        handler(event)
      } catch {
        // Subscriber faults must not interfere with the
        // invalidation that triggered them. Silently swallow.
      }
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
      emit(key)
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
      // Emit even when cleared === 0 — subscribers (notably the
      // L4→L6 SSE bridge) want every invalidation intent, not just
      // those that hit something locally. A consumer's L6 cache may
      // hold an entry the server's L4 already evicted via LRU.
      emit(prefix)
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
