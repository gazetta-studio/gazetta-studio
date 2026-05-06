/**
 * `IndexedDBCache` — browser-side `AdminCache` provider per
 * `design-offline.md`. Persists cache entries across page reloads;
 * survives browser sessions; the L6 layer in the L4→L6 cascade
 * powering offline mode.
 *
 * Implements the same `AdminCache` contract as the server-side
 * `MemoryCache`. The contract is shared via the `gazetta` package's
 * type exports so consumers (Vue Query bridge, route helpers) can
 * depend on the interface without knowing whether they're talking to
 * the server-side or browser-side provider.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the IndexedDB-backed provider. Provider
 *     selection, BroadcastChannel cross-tab fan-out, and Vue Query
 *     bridging live in sibling files.
 *   - LSP: substitutable for any other `AdminCache` provider; passes
 *     `adminCacheContractTests` from `gazetta/testing`.
 *   - DIP: callers depend on the `AdminCache` interface, not on this
 *     concrete class.
 *
 * # Differences from `MemoryCache`
 *
 * - **LRS, not LRU**: tracks Least Recently Set rather than Least
 *   Recently Used. LRU would require a write on every read (to bump
 *   recency); LRS only writes on `set`. The browser's typical
 *   eviction pressure is "drop the oldest write," which LRS captures
 *   correctly without doubling write volume.
 *
 * - **Stats are in-memory only**: hit / miss counters live on the
 *   provider instance and reset on tab reload. Persisting them would
 *   make every `get` a write — kills the point of caching. Operators
 *   reading the structured stats log get per-tab-session counts.
 *
 * - **No `applyKeyPolicy`**: the server-side provider applies a
 *   version prefix and overflow-hash before storing. The browser-
 *   side provider stores keys as received. The L4↔L6 sync still
 *   works because both providers expose the same consumer-facing
 *   API; their internal storage encoding doesn't have to match.
 *
 * - **Cross-tab fan-out via BroadcastChannel**: `subscribe()` fires
 *   for events from any source — local invalidations on this provider
 *   AND invalidations from peer tabs in the same origin. Matches the
 *   server-side `MemoryCache` contract evolution ("events from any
 *   source"). Peer events skip the originator's own subscribers via
 *   instance-ID comparison; no infinite loop on rebroadcast.
 */
import { type IDBPDatabase, openDB } from 'idb'
import type { AdminCache, CacheStats, InvalidationEvent } from 'gazetta'

/** Default cap. Matches MemoryCache so operators get consistent behavior. */
const DEFAULT_MAX_ENTRIES = 10_000
/** Default cap. Matches MemoryCache so operators get consistent behavior. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

const DB_NAME = 'gazetta-cache'
const DB_VERSION = 1
const STORE_NAME = 'cache'
const SET_AT_INDEX = 'setAt'

/**
 * BroadcastChannel name prefix. Suffixed by `dbName` so different
 * cache databases in the same origin (tests, future per-site DB names)
 * don't cross-talk.
 */
const BROADCAST_CHANNEL_PREFIX = 'gazetta-cache:'

interface CacheRow {
  /** The cache key (primary key on the store). */
  key: string
  /** The cached value — JSON-serializable per `AdminCache` contract. */
  value: unknown
  /**
   * Wall-clock millis when this entry was written. Drives LRS
   * eviction; not load-bearing for correctness (entries don't expire
   * by age in v1).
   */
  setAt: number
  /** Approximate byte size — `JSON.stringify(value).length`. */
  bytes: number
}

export interface IndexedDBCacheOptions {
  /** Max entry count before LRS eviction kicks in. Default 10,000. */
  maxEntries?: number
  /** Approximate max bytes before LRS eviction kicks in. Default 50 MB. */
  maxBytes?: number
  /**
   * Stable identifier for this provider instance, emitted on
   * `InvalidationEvent.source.instance` and `CacheStats.instance`.
   * Defaults to a random 8-char hex generated at construction —
   * scoped to the tab session.
   */
  instance?: string
  /**
   * Override the database name. Defaults to `gazetta-cache`. Tests
   * pass a unique name per test to avoid cross-test contamination
   * since IndexedDB is browser-global.
   */
  dbName?: string
}

/**
 * Build an `IndexedDBCache` provider. Returns a Promise because the
 * IndexedDB connection is async — `openDB()` resolves once the
 * upgrade callback finishes.
 *
 * The returned provider keeps the connection open for its lifetime;
 * it doesn't expose a `close()` method. Browser tab close releases
 * the connection. Tests that need clean teardown can `db.close()` on
 * the underlying DB before the next test, or use unique `dbName`
 * options.
 */
export async function createIndexedDBCache(opts: IndexedDBCacheOptions = {}): Promise<AdminCache & { close(): void }> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const instance = opts.instance ?? randomHex(4)
  const dbName = opts.dbName ?? DB_NAME

  const db: IDBPDatabase = await openDB(dbName, DB_VERSION, {
    upgrade(database) {
      // Only one store; keys are arbitrary strings; setAt index for
      // LRS eviction sweeps.
      const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' })
      store.createIndex(SET_AT_INDEX, 'setAt')
    },
  })

  const subscribers = new Set<(event: InvalidationEvent) => void>()
  let hits = 0
  let misses = 0
  let evictions = 0
  let lastInvalidation: { prefix: string; at: string; source: string } | undefined

  // Cross-tab fan-out via BroadcastChannel. Same-origin tabs share
  // IndexedDB storage, so an invalidation in tab A means tab B's
  // cached read result is now stale; the channel notifies peers so
  // their local subscribers (Vue Query bridge, validation drawer,
  // etc.) can react. The underlying storage is already shared — we're
  // not syncing state, just notifying that state changed.
  //
  // BroadcastChannel can be undefined in older test runners or
  // sandboxed contexts; fall back to a no-op so cross-tab degrades
  // gracefully without breaking single-tab usage.
  const channel: BroadcastChannel | null =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`${BROADCAST_CHANNEL_PREFIX}${dbName}`) : null

  function fireSubscribers(event: InvalidationEvent): void {
    for (const handler of subscribers) {
      try {
        handler(event)
      } catch {
        // Subscriber faults must not interfere with the invalidation
        // that triggered them. Silently swallow.
      }
    }
  }

  if (channel) {
    channel.onmessage = (msgEvent: MessageEvent) => {
      const event = msgEvent.data as InvalidationEvent | undefined
      // Defensive: ignore messages we can't parse. BroadcastChannel
      // only delivers structured-clone-able payloads, so malformed
      // events shouldn't happen — but a future contract change in a
      // peer tab shouldn't crash this tab.
      if (!event || typeof event !== 'object' || typeof event.prefix !== 'string') return
      // Loop guard. The originating tab's local emit() already fired
      // its own subscribers; receiving the rebroadcast and firing
      // again would double-fire on the originator.
      if (event.source?.instance === instance) return
      fireSubscribers(event)
    }
  }

  /**
   * Build the invalidation event, fire local subscribers, then
   * broadcast to peer tabs. Local-fire-first ordering matches the
   * server-side `MemoryCache` contract: subscribers see the event in
   * the same order regardless of cross-tab semantics.
   */
  function emit(prefix: string): void {
    const event: InvalidationEvent = {
      prefix,
      source: { instance, timestamp: new Date().toISOString() },
    }
    fireSubscribers(event)
    if (channel) {
      try {
        channel.postMessage(event)
      } catch {
        // postMessage can throw on closed channels (test teardown
        // race) or when the payload isn't structured-cloneable. The
        // payload is plain JSON — clone failures shouldn't happen —
        // but we still don't want to corrupt the local invalidation.
      }
    }
  }

  /**
   * Sum bytes across every entry. Cursor-walk; one transaction. Used
   * by `evictUntilUnderCap` and `stats`. Both callers tolerate the
   * O(N) scan because:
   *   - eviction only runs after writes when caps may be exceeded;
   *   - stats() is called at observation cadence (5-min log), not
   *     hot-path. Operators with byte-cap concerns at envelope have
   *     a small enough cache that this is microseconds.
   */
  async function totalByteSum(): Promise<number> {
    let total = 0
    const tx = db.transaction(STORE_NAME, 'readonly')
    let cursor = await tx.store.openCursor()
    while (cursor) {
      total += (cursor.value as CacheRow).bytes
      cursor = await cursor.continue()
    }
    await tx.done
    return total
  }

  /**
   * Walk the setAt index from oldest forward, deleting entries until
   * the store is back under both caps. Two transactions:
   *   1. Read current size + bytes (skip if already under caps)
   *   2. Eviction sweep
   * Splitting avoids holding a write lock during the cheap-path
   * "no eviction needed" case.
   */
  async function evictUntilUnderCap(): Promise<void> {
    const initialSize = await db.count(STORE_NAME)
    const initialBytes = initialSize > 0 ? await totalByteSum() : 0
    if (initialSize <= maxEntries && initialBytes <= maxBytes) return

    const tx = db.transaction(STORE_NAME, 'readwrite')
    const index = tx.store.index(SET_AT_INDEX)
    let size = initialSize
    let totalBytes = initialBytes
    let cursor = await index.openCursor()
    while (cursor && (size > maxEntries || totalBytes > maxBytes)) {
      const row = cursor.value as CacheRow
      totalBytes -= row.bytes
      size -= 1
      await cursor.delete()
      evictions += 1
      cursor = await cursor.continue()
    }
    await tx.done
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const row = (await db.get(STORE_NAME, key)) as CacheRow | undefined
      if (!row) {
        misses += 1
        return null
      }
      hits += 1
      return row.value as T
    },

    async set<T>(key: string, value: T, _opts?: { ttl?: number }): Promise<void> {
      // TTL is part of the AdminCache contract but IndexedDBCache
      // ignores it — eviction is LRS-only. A future TTL pass would
      // add a `ttlAt` field and a periodic sweep.
      const serialized = JSON.stringify(value)
      const row: CacheRow = {
        key,
        value,
        setAt: Date.now(),
        bytes: serialized.length,
      }
      await db.put(STORE_NAME, row)
      await evictUntilUnderCap()
    },

    async invalidate(key: string): Promise<void> {
      const existed = (await db.get(STORE_NAME, key)) !== undefined
      if (!existed) return
      await db.delete(STORE_NAME, key)
      emit(key)
    },

    async invalidatePrefix(prefix: string): Promise<number> {
      // Cursor-walk over the keypath; delete every row whose key
      // starts with prefix. `￿` is the highest BMP code point —
      // any string starting with `prefix` sorts strictly less.
      // (Our keys are colon-separated ASCII, so BMP coverage is fine.)
      const range = IDBKeyRange.bound(prefix, prefix + '￿', false, true)
      const tx = db.transaction(STORE_NAME, 'readwrite')
      let cleared = 0
      let cursor = await tx.store.openCursor(range)
      while (cursor) {
        await cursor.delete()
        cleared += 1
        cursor = await cursor.continue()
      }
      await tx.done
      lastInvalidation = {
        prefix,
        at: new Date().toISOString(),
        source: 'local',
      }
      // Emit even when cleared === 0 — same rule as MemoryCache:
      // subscribers (cross-tab BroadcastChannel in Cut 4) want every
      // invalidation intent, not just those that hit something locally.
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
      const size = await db.count(STORE_NAME)
      const bytesApproximate = size > 0 ? await totalByteSum() : 0
      return {
        hits,
        misses,
        size,
        instance,
        evictions,
        bytesApproximate,
        lastInvalidation,
      }
    },

    /**
     * Close the underlying IndexedDB connection AND the
     * BroadcastChannel. Tests use this to release the database
     * between runs so version-bumps in upgrade don't get blocked,
     * and to avoid leaking channel listeners across tests. Production
     * code doesn't call this — the connection + channel live for the
     * tab session.
     */
    close(): void {
      channel?.close()
      db.close()
    },
  }
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}
