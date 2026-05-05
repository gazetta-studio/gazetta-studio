/**
 * `AdminCache` — provider-substitutable interface for the L4 cache
 * tier (admin / origin server). One concrete implementation ships in
 * v1: `MemoryCache` (Cut 2). Reserved for v2: `RedisCache`,
 * `AzureCache`, `FileCache`.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the cache contract (interface, stats,
 *     invalidation event). Nothing else lives here.
 *   - OCP: new providers implement `AdminCache` and slot into the
 *     factory (Cut 9). No existing module changes.
 *   - LSP: every provider honors the same contract. Substitutable
 *     in tests via the `adminCacheContractTests` helper (Cut 10).
 *   - ISP: callers depend on this interface, not on a specific
 *     provider's mechanism (Map, Redis pub/sub, Service Bus).
 *   - DIP: feature code calls `cache.get(key)` etc.; the seam to
 *     concrete providers is the factory.
 *
 * Locked invariants per `design-cache.md`:
 *   - Cached values MUST be JSON-serializable (no functions, no
 *     Symbols, no top-level Maps/Sets) — required for L4 → L6
 *     handoff via IndexedDB / localStorage.
 *   - `subscribe()` delivers events from OTHER instances, not from
 *     local invalidations. Single-instance providers (MemoryCache
 *     in single-process deployments) register handlers but never
 *     fire events; multi-instance deployments wire the SSE bridge
 *     in Cut 4.
 *   - `invalidatePrefix()` is best-effort with a time cap (~100ms
 *     default per design-cache.md PWA-responsiveness principle);
 *     un-cleared entries clear at TTL or on next invalidation.
 */

/**
 * The cache contract. All providers implement this; consumers depend
 * only on the interface.
 */
export interface AdminCache {
  /** Get cached value or null on miss. */
  get<T>(key: string): Promise<T | null>
  /**
   * Set value with optional TTL (seconds). Provider may ignore TTL
   * if it doesn't support expiry; `MemoryCache` ignores TTL in v1
   * (LRU-only eviction).
   */
  set<T>(key: string, value: T, opts?: { ttl?: number }): Promise<void>
  /** Invalidate one key. */
  invalidate(key: string): Promise<void>
  /** Invalidate all keys matching a prefix. Returns count cleared. */
  invalidatePrefix(prefix: string): Promise<number>
  /**
   * Subscribe to invalidation events from other instances. Returns
   * disposer.
   *
   * Single-instance providers (MemoryCache in single-process)
   * register handlers but no events fire — the cross-instance SSE
   * bridge that drives this lands in Cut 4.
   */
  subscribe(handler: (event: InvalidationEvent) => void): () => void
  /** Stats for diagnostics. Optional — not every provider exposes. */
  stats?(): Promise<CacheStats>
}

/**
 * Event delivered to `subscribe()` handlers when another instance
 * invalidates a cache prefix. Source identifies the originating
 * instance for cross-instance correlation.
 */
export interface InvalidationEvent {
  /** Key or prefix that was invalidated. */
  prefix: string
  /** Originating instance + wall-clock timestamp (ISO 8601). */
  source: { instance: string; timestamp: string }
}

/**
 * Cache stats — minimum required + provider-specific extras allowed.
 *
 * The required floor (hits, misses, size) lets the
 * `/api/system/cache/stats` route (Cut 7) report a useful baseline
 * across all providers. Optional fields (errors, evictions,
 * bytesApproximate, oldestEntryAt, lastInvalidation,
 * subscribeReconnects) ship as the relevant provider tracks them.
 */
export interface CacheStats {
  hits: number
  misses: number
  /** Entry count. */
  size: number
  // Provider-specific extras allowed.
  errors?: number
  evictions?: number
  bytesApproximate?: number
  oldestEntryAt?: string
  lastInvalidation?: { prefix: string; at: string; source: string }
  subscribeReconnects?: number
}
