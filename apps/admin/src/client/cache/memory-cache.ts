/**
 * Browser-side in-memory `AdminCache` provider.
 *
 * Used as the IndexedDB-fallback path per `design-offline.md`'s
 * "Provider selection logic": when IndexedDB is unavailable
 * (private-mode browsers, embedded contexts), this provider keeps
 * offline UX functional in-memory only. No persistence; tab close
 * loses everything. The Vue layer surfaces a banner via the
 * `degraded` flag from `provider-selector.ts`.
 *
 * Mirrors the server-side `MemoryCache` from the gazetta package
 * but doesn't import it — the server-side version pulls in
 * `node:crypto` and `node:os` for env-aware instance ID resolution
 * (Cloud Run's K_REVISION, K8s hostname). Browser doesn't need
 * those; a tab-session-scoped random hex is the right identity.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the browser-memory provider. Selector,
 *     IndexedDB provider, and Vue-layer banner are siblings.
 *   - LSP: passes `adminCacheContractTests` from `gazetta/testing`.
 *   - DIP: callers depend on `AdminCache`, not on this constructor.
 *
 * # Differences from server-side `MemoryCache`
 *
 * Same contract; same caps (10K entries / 50MB); same LRU eviction
 * via `Map` insertion-order touch on hit. Two surface differences:
 *
 *  - Instance ID is `crypto.getRandomValues`-derived (browser-native);
 *    no env-var fallback chain.
 *  - No `applyKeyPolicy`: the server-side provider applies a version
 *    prefix and overflow-hash before storing. Browser-side stores
 *    keys as received. Same justification as `IndexedDBCache` —
 *    consumers see the same public API; provider internals diverge.
 */
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

interface CacheEntry {
  value: unknown
  /** Approximate byte size — `JSON.stringify(value).length`. */
  bytes: number
}

export interface BrowserMemoryCacheOptions {
  /** Max entry count before LRU eviction kicks in. Default 10,000. */
  maxEntries?: number
  /** Approximate max bytes before LRU eviction kicks in. Default 50 MB. */
  maxBytes?: number
  /**
   * Stable identifier emitted on `InvalidationEvent.source.instance`
   * and `CacheStats.instance`. Defaults to a random 8-char hex
   * generated at construction — scoped to the tab session.
   */
  instance?: string
}

export function createBrowserMemoryCache(opts: BrowserMemoryCacheOptions = {}): AdminCache {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const instance = opts.instance ?? randomHex(4)

  // Map insertion order is the LRU order; access touches it via
  // delete+set on hit (Map.set on existing key preserves order, so
  // the explicit delete-then-set is required to bump recency).
  const entries = new Map<string, CacheEntry>()
  let totalBytes = 0

  const subscribers = new Set<(event: InvalidationEvent) => void>()
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
      evictions += 1
    }
  }

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
      const entry = entries.get(key)
      if (!entry) {
        misses += 1
        return null
      }
      // LRU touch — delete + re-insert moves to end (most recent).
      entries.delete(key)
      entries.set(key, entry)
      hits += 1
      return entry.value as T
    },

    async set<T>(key: string, value: T, _opts?: { ttl?: number }): Promise<void> {
      // TTL is part of the AdminCache contract but this provider
      // ignores it — eviction is LRU-only.
      const bytes = JSON.stringify(value).length
      const existing = entries.get(key)
      if (existing) {
        totalBytes -= existing.bytes
        entries.delete(key)
      }
      entries.set(key, { value, bytes })
      totalBytes += bytes
      evictOldestIfOverCap()
    },

    async invalidate(key: string): Promise<void> {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      totalBytes -= entry.bytes
      emit(key)
    },

    async invalidatePrefix(prefix: string): Promise<number> {
      let cleared = 0
      for (const [key, entry] of entries) {
        if (key.startsWith(prefix)) {
          entries.delete(key)
          totalBytes -= entry.bytes
          cleared += 1
        }
      }
      lastInvalidation = {
        prefix,
        at: new Date().toISOString(),
        source: 'local',
      }
      // Emit even when cleared === 0 — same rule as server-side
      // MemoryCache: cross-tab BroadcastChannel subscribers (Cut 4)
      // want every invalidation intent.
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
        instance,
        evictions,
        bytesApproximate: totalBytes,
        lastInvalidation,
      }
    },
  }
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}
