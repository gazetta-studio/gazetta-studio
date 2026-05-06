/**
 * Eviction tests for both browser-side cache providers.
 *
 * The shared `adminCacheContractTests` suite covers the public API
 * (get/set/invalidate/subscribe/stats). It does NOT exercise the
 * size-cap eviction path — providers can advertise eviction limits
 * but the contract suite stays neutral about WHEN eviction fires.
 *
 * Eviction is real correctness logic: cursor walks (IndexedDB),
 * Map insertion-order tracking (Memory), totalBytes accounting,
 * the evictions counter on stats. A bug here means caches grow
 * unbounded or evict the wrong entry first; both are silent
 * failures the contract suite wouldn't catch.
 *
 * # IndexedDBCache: LRS (Least Recently Set)
 *
 * Tracks the `setAt` timestamp; oldest writes evict first. Cursor-
 * walks the `setAt` index in ascending order until back under cap.
 *
 * # Browser MemoryCache: LRU (Least Recently Used)
 *
 * Touches Map insertion-order on every hit (`delete + set` to bump
 * recency). Eviction walks `entries.keys().next()` to find the
 * least-recently-used.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import type { AdminCache } from 'gazetta'
import { createIndexedDBCache } from '../src/client/cache/indexeddb-cache.js'
import { createBrowserMemoryCache } from '../src/client/cache/memory-cache.js'

let dbCounter = 0

describe('IndexedDBCache eviction', () => {
  let cache: (AdminCache & { close(): void }) | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('evicts the oldest entry when entry count exceeds maxEntries (LRS)', async () => {
    cache = await createIndexedDBCache({
      dbName: `evict-test-${++dbCounter}`,
      maxEntries: 3,
    })

    await cache.set('a', 'A')
    await cache.set('b', 'B')
    await cache.set('c', 'C')
    // Cap reached. All three present.
    expect(await cache.get('a')).toBe('A')
    expect(await cache.get('b')).toBe('B')
    expect(await cache.get('c')).toBe('C')

    // Insert a fourth entry; oldest (a) evicts.
    await cache.set('d', 'D')
    expect(await cache.get('a')).toBeNull() // evicted
    expect(await cache.get('b')).toBe('B')
    expect(await cache.get('c')).toBe('C')
    expect(await cache.get('d')).toBe('D')

    // Stats reflect the eviction.
    const stats = await cache.stats!()
    expect(stats.evictions).toBe(1)
    expect(stats.size).toBe(3)
  })

  it('evicts multiple entries when a single set blows past maxEntries', async () => {
    // Edge: when caller mutates an existing key, totalBytes grows
    // by delta; size stays. But if we set a NEW key when the cache
    // was already at exactly maxEntries, size briefly exceeds and
    // eviction must catch up.
    cache = await createIndexedDBCache({
      dbName: `evict-test-${++dbCounter}`,
      maxEntries: 2,
    })

    await cache.set('a', 'A')
    await cache.set('b', 'B')
    await cache.set('c', 'C')

    expect(await cache.get('a')).toBeNull()
    expect((await cache.stats!()).size).toBe(2)
  })

  it('evicts on byte-cap overflow', async () => {
    // Each value's bytes ≈ JSON.stringify(value).length. Three
    // 50-byte strings, cap at 80 bytes — only the most-recent
    // ~80 bytes worth survives.
    cache = await createIndexedDBCache({
      dbName: `evict-test-${++dbCounter}`,
      maxBytes: 80,
    })

    const big = 'x'.repeat(50)
    await cache.set('a', big) // ~52 bytes (string + quotes)
    await cache.set('b', big) // total ~104 — over cap; a evicts
    expect(await cache.get('a')).toBeNull()
    expect(await cache.get('b')).toBe(big)
  })

  it('updating an existing entry does not double-count bytes', async () => {
    // Earlier `set` should subtract the old entry's bytes before
    // adding the new entry. Without that, repeated overwrites of
    // the same key would inflate totalBytes.
    cache = await createIndexedDBCache({
      dbName: `evict-test-${++dbCounter}`,
      maxBytes: 200,
    })

    const fifty = 'x'.repeat(50) // ~52 bytes
    for (let i = 0; i < 10; i++) {
      await cache.set('one-key', fifty)
    }
    // After 10 overwrites of the same key, only 1 entry exists.
    const stats = await cache.stats!()
    expect(stats.size).toBe(1)
    // No eviction should have fired (we never exceeded 200 bytes).
    expect(stats.evictions).toBe(0)
  })

  it('size and evictions counters are accurate after mixed operations', async () => {
    cache = await createIndexedDBCache({
      dbName: `evict-test-${++dbCounter}`,
      maxEntries: 3,
    })

    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.set('c', 3)
    await cache.set('d', 4) // 1 eviction (a)
    await cache.set('e', 5) // 1 eviction (b)
    await cache.invalidate('e') // not an eviction; explicit removal

    const stats = await cache.stats!()
    expect(stats.size).toBe(2) // c, d
    expect(stats.evictions).toBe(2)
  })
})

describe('Browser MemoryCache eviction (LRU)', () => {
  it('evicts the least-recently-used entry when entry count exceeds maxEntries', () => {
    const cache = createBrowserMemoryCache({ maxEntries: 3 })

    void cache.set('a', 'A')
    void cache.set('b', 'B')
    void cache.set('c', 'C')

    // Cap reached; insert d → oldest (a) evicts.
    void cache.set('d', 'D')
    return Promise.all([
      cache.get('a').then(v => expect(v).toBeNull()),
      cache.get('b').then(v => expect(v).toBe('B')),
      cache.get('c').then(v => expect(v).toBe('C')),
      cache.get('d').then(v => expect(v).toBe('D')),
    ])
  })

  it('LRU touch on hit bumps recency (recently-read entry survives eviction)', async () => {
    const cache = createBrowserMemoryCache({ maxEntries: 3 })
    await cache.set('a', 'A')
    await cache.set('b', 'B')
    await cache.set('c', 'C')

    // Touch `a` via get → it becomes most-recently-used.
    await cache.get('a')

    // Insert `d` → least-recently-used is now `b`, which evicts.
    await cache.set('d', 'D')
    expect(await cache.get('a')).toBe('A') // survived (touched)
    expect(await cache.get('b')).toBeNull() // evicted
    expect(await cache.get('c')).toBe('C')
    expect(await cache.get('d')).toBe('D')
  })

  it('evicts on byte-cap overflow', async () => {
    const cache = createBrowserMemoryCache({ maxBytes: 80 })
    const big = 'x'.repeat(50)
    await cache.set('a', big)
    await cache.set('b', big) // exceeds 80; a evicts
    expect(await cache.get('a')).toBeNull()
    expect(await cache.get('b')).toBe(big)
  })

  it('updating an existing entry does not double-count bytes', async () => {
    const cache = createBrowserMemoryCache({ maxBytes: 200 })
    const fifty = 'x'.repeat(50)
    for (let i = 0; i < 10; i++) {
      await cache.set('one-key', fifty)
    }
    const stats = await cache.stats!()
    expect(stats.size).toBe(1)
    expect(stats.evictions).toBe(0)
  })

  it('evictions counter increments per evicted entry', async () => {
    const cache = createBrowserMemoryCache({ maxEntries: 2 })
    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.set('c', 3) // 1 eviction
    await cache.set('d', 4) // 1 eviction
    await cache.set('e', 5) // 1 eviction

    const stats = await cache.stats!()
    expect(stats.size).toBe(2)
    expect(stats.evictions).toBe(3)
  })
})

describe('cache.set sanitizes Vue reactive values (CI regression)', () => {
  // Real bug caught by CI: IndexedDBCache.set used to store the
  // value raw via `db.put`. When persistence callers snapshotted
  // Pinia state — which wraps everything in Vue reactive Proxies —
  // structured-clone rejected with:
  //   "Failed to execute 'put' on 'IDBObjectStore':
  //    #<Object> could not be cloned."
  // The fix round-trips through JSON before put, stripping Proxies
  // (and any other non-cloneable wrappers) along the way.

  let cache: (AdminCache & { close(): void }) | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('IndexedDBCache.set accepts a Vue reactive object', async () => {
    cache = await createIndexedDBCache({ dbName: `proxy-test-${Math.random()}` })
    const reactiveValue = reactive({ title: 'Hello', tags: ['a', 'b'] })

    // Without the JSON sanitize, this throws inside db.put.
    await cache.set('key', reactiveValue)
    const got = await cache.get<{ title: string; tags: string[] }>('key')
    expect(got).toEqual({ title: 'Hello', tags: ['a', 'b'] })
  })

  it('IndexedDBCache.set accepts a deeply-nested reactive object', async () => {
    // The Pinia stores the persistence layer snapshots have nested
    // shapes (entries Map → entry → editedContent → arbitrary
    // user JSON). Verify the round-trip handles depth.
    cache = await createIndexedDBCache({ dbName: `proxy-test-${Math.random()}` })
    const nested = reactive({
      version: 1 as const,
      entries: [
        [
          'page:home::_root',
          reactive({ key: 'page:home::_root', editedContent: reactive({ title: 'Mine' }), updatedAt: '' }),
        ],
      ],
    })

    await cache.set('snap', nested)
    const got = await cache.get<{
      version: number
      entries: Array<[string, { key: string; editedContent: { title: string }; updatedAt: string }]>
    }>('snap')
    expect(got!.version).toBe(1)
    expect(got!.entries[0][1].editedContent.title).toBe('Mine')
  })

  it('Browser MemoryCache.set accepts a Vue reactive object (parity)', async () => {
    // Memory cache stores in a Map (no structured clone), so this
    // already works — the regression test pins the parity so a
    // future refactor that adds clone semantics doesn't break it.
    const memCache = createBrowserMemoryCache()
    const reactiveValue = reactive({ title: 'Hello', tags: ['a', 'b'] })

    await memCache.set('key', reactiveValue)
    const got = await memCache.get<{ title: string; tags: string[] }>('key')
    expect(got).toEqual({ title: 'Hello', tags: ['a', 'b'] })
  })
})
