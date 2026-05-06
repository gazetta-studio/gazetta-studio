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
 *   - `subscribe()` delivers invalidation events from any source
 *     (local OR cross-instance — Cut 4 contract evolution). The
 *     `event.source.instance` field discriminates origin so
 *     subscribers can filter as needed.
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
   * Subscribe to invalidation events from any source. Returns disposer.
   *
   * Local invalidations (this instance's `invalidate` /
   * `invalidatePrefix` calls) AND cross-instance invalidations
   * (delivered via SSE bridge or shared backing service) both fire
   * the handler. Discriminate via `event.source.instance` —
   * subscribers that only care about cross-instance events can filter
   * out their own.
   *
   * The L4→L6 server-to-browser cascade is the load-bearing consumer:
   * server-side `invalidatePrefix('pages:')` fires to a subscribed
   * SSE route, which forwards the event to connected browser admin
   * clients, which invalidate their L6 caches. From the browser's
   * POV the server IS another instance, so "events from any source"
   * is the right contract.
   *
   * Event payloads carry the **consumer-facing** prefix (the form
   * passed to the invalidate call). Provider-internal storage
   * details (version prefix, overflow hash, per-site scope) don't
   * leak into the event.
   *
   * **No replay on reconnect.** Subscribers (notably the SSE bridge
   * forwarding to browsers) that lose their connection get no
   * server-side replay of events they missed during the gap. The
   * contract: on reconnect, treat your own cached state as
   * potentially stale and reset (re-fetch from source). The L6 admin
   * cache (`design-offline.md`) follows this rule via full reset on
   * reconnect.
   *
   * **Handlers should be synchronous.** Providers fire subscribers
   * with `handler(event)` — without `await`. TypeScript's `void`
   * return type accepts async handlers for ergonomic reasons, but
   * the cache won't await them; rejections from a returned Promise
   * become unhandled. Subscribers needing async work should enqueue
   * synchronously and process asynchronously elsewhere (e.g., the
   * SSE bridge pushes to a buffer + drains from a stream loop).
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
  /**
   * Identity of the reporting cache instance — same value as
   * `InvalidationEvent.source.instance` for events emitted by this
   * provider. Operators querying `/api/system/cache/stats` in
   * multi-instance deployments use this to know which pod / revision
   * answered (the load balancer's choice can vary between requests).
   * Optional because some providers may not have a meaningful
   * identity (e.g., a no-op stub).
   */
  instance?: string
  // Provider-specific extras allowed.
  errors?: number
  evictions?: number
  bytesApproximate?: number
  oldestEntryAt?: string
  lastInvalidation?: { prefix: string; at: string; source: string }
  subscribeReconnects?: number
}
