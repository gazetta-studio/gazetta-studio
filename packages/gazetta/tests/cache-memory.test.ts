import { describe, it, expect } from 'vitest'
import { createMemoryCache } from '../src/cache/memory.js'
import type { InvalidationEvent } from '../src/cache/types.js'

describe('MemoryCache get/set/invalidate', () => {
  it('round-trips values through get/set', async () => {
    const cache = createMemoryCache()
    await cache.set('pages:home', { title: 'Home' })
    expect(await cache.get('pages:home')).toEqual({ title: 'Home' })
  })

  it('returns null on miss', async () => {
    const cache = createMemoryCache()
    expect(await cache.get('pages:nope')).toBeNull()
  })

  it('invalidate removes a single key', async () => {
    const cache = createMemoryCache()
    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.invalidate('a')
    expect(await cache.get('a')).toBeNull()
    expect(await cache.get('b')).toBe(2)
  })

  it('invalidate is no-op on missing key', async () => {
    const cache = createMemoryCache()
    await expect(cache.invalidate('never-set')).resolves.toBeUndefined()
  })

  it('set overwrites existing value', async () => {
    const cache = createMemoryCache()
    await cache.set('k', 'first')
    await cache.set('k', 'second')
    expect(await cache.get('k')).toBe('second')
  })
})

describe('MemoryCache LRU eviction', () => {
  it('evicts oldest entry when maxEntries exceeded', async () => {
    const cache = createMemoryCache({ maxEntries: 3 })
    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.set('c', 3)
    await cache.set('d', 4) // evicts 'a' (oldest)
    expect(await cache.get('a')).toBeNull()
    expect(await cache.get('b')).toBe(2)
    expect(await cache.get('c')).toBe(3)
    expect(await cache.get('d')).toBe(4)
  })

  it('get touches recency — accessed entry survives eviction', async () => {
    const cache = createMemoryCache({ maxEntries: 3 })
    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.set('c', 3)
    await cache.get('a') // touches 'a' — moves to end
    await cache.set('d', 4) // evicts 'b' (now oldest)
    expect(await cache.get('a')).toBe(1)
    expect(await cache.get('b')).toBeNull()
  })

  it('evicts on byte cap', async () => {
    // Each value JSON.stringify's to a known size; cap forces eviction.
    // 'aaa' → 5 bytes (with quotes). Three entries = 15 bytes.
    const cache = createMemoryCache({ maxBytes: 12, maxEntries: 1000 })
    await cache.set('k1', 'aaa')
    await cache.set('k2', 'aaa')
    await cache.set('k3', 'aaa') // total 15 bytes; evicts oldest
    const stats = await cache.stats?.()
    expect(stats?.evictions).toBeGreaterThan(0)
    expect(stats?.bytesApproximate).toBeLessThanOrEqual(12)
  })

  it('overwriting a key updates byte total', async () => {
    const cache = createMemoryCache({ maxBytes: 100, maxEntries: 100 })
    await cache.set('k', 'small')
    const before = (await cache.stats?.())?.bytesApproximate ?? 0
    await cache.set('k', 'much-longer-string')
    const after = (await cache.stats?.())?.bytesApproximate ?? 0
    expect(after).toBeGreaterThan(before)
    // Size stays at 1 entry — overwrite, not new entry.
    expect((await cache.stats?.())?.size).toBe(1)
  })
})

describe('MemoryCache invalidatePrefix', () => {
  it('clears all entries matching prefix; returns count', async () => {
    const cache = createMemoryCache()
    await cache.set('pages:home', 1)
    await cache.set('pages:about', 2)
    await cache.set('fragments:header', 3)
    const cleared = await cache.invalidatePrefix('pages:')
    expect(cleared).toBe(2)
    expect(await cache.get('pages:home')).toBeNull()
    expect(await cache.get('pages:about')).toBeNull()
    expect(await cache.get('fragments:header')).toBe(3)
  })

  it('returns 0 when no keys match', async () => {
    const cache = createMemoryCache()
    await cache.set('pages:home', 1)
    expect(await cache.invalidatePrefix('fragments:')).toBe(0)
  })

  it('records lastInvalidation in stats', async () => {
    const cache = createMemoryCache()
    await cache.set('pages:home', 1)
    await cache.invalidatePrefix('pages:')
    const stats = await cache.stats?.()
    expect(stats?.lastInvalidation?.prefix).toBe('pages:')
    expect(stats?.lastInvalidation?.source).toBe('local')
    // ISO 8601 timestamp; verify shape, not exact value
    expect(stats?.lastInvalidation?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('MemoryCache subscribe (Cut 2 — no-op semantics)', () => {
  it('registers handler and returns disposer', () => {
    const cache = createMemoryCache()
    const events: InvalidationEvent[] = []
    const disposer = cache.subscribe(e => events.push(e))
    expect(typeof disposer).toBe('function')
    disposer()
  })

  it('does not fire events on local invalidate (cross-instance only)', async () => {
    // Cut 2 ships subscribe() registering in a Set; Cut 4 wires the
    // SSE bridge that delivers events. Local invalidations don't
    // emit because the contract is "events from OTHER instances."
    const cache = createMemoryCache()
    const events: InvalidationEvent[] = []
    cache.subscribe(e => events.push(e))
    await cache.set('k', 1)
    await cache.invalidate('k')
    await cache.invalidatePrefix('p')
    expect(events).toEqual([])
  })

  it('disposer removes handler from registered set', () => {
    // Indirect verification: dispose, then no path can reach the
    // handler. (Cut 4 will add a real test of this once events fire.)
    const cache = createMemoryCache()
    const handler = () => undefined
    const disposer = cache.subscribe(handler)
    disposer() // should not throw; should be idempotent if called twice
    disposer()
  })
})

describe('MemoryCache stats', () => {
  it('counts hits and misses', async () => {
    const cache = createMemoryCache()
    await cache.set('k', 1)
    await cache.get('k') // hit
    await cache.get('k') // hit
    await cache.get('missing') // miss
    const stats = await cache.stats?.()
    expect(stats?.hits).toBe(2)
    expect(stats?.misses).toBe(1)
  })

  it('reports current size', async () => {
    const cache = createMemoryCache()
    await cache.set('a', 1)
    await cache.set('b', 2)
    const stats = await cache.stats?.()
    expect(stats?.size).toBe(2)
  })
})

describe('MemoryCache key policy (Cut 1)', () => {
  it('round-trips values keyed by very long consumer keys', async () => {
    // Long keys force the overflow-hash path inside applyKeyPolicy.
    // The provider must be consistent: set under a long consumer key,
    // get under the same long consumer key, and read the value back.
    const cache = createMemoryCache()
    const longKey = `pages:detail:${'x'.repeat(300)}`
    await cache.set(longKey, { title: 'long' })
    expect(await cache.get(longKey)).toEqual({ title: 'long' })
  })

  it('distinguishes two different long keys via the overflow hash', async () => {
    // Two long keys differing only in the overflow tail must NOT
    // collide — overflow hash is what makes them distinct.
    const cache = createMemoryCache()
    const a = `pages:detail:${'a'.repeat(300)}`
    const b = `pages:detail:${'b'.repeat(300)}`
    await cache.set(a, 'A')
    await cache.set(b, 'B')
    expect(await cache.get(a)).toBe('A')
    expect(await cache.get(b)).toBe('B')
  })

  it('invalidatePrefix matches long-keyed entries when the prefix is short', async () => {
    // Critical contract from design-cache.md Gap 2: prefix invalidation
    // works regardless of how long the full key is, as long as the
    // prefix is short enough to be preserved verbatim by applyKeyPolicy.
    const cache = createMemoryCache()
    await cache.set(`pages:detail:${'a'.repeat(300)}`, 1)
    await cache.set(`pages:detail:${'b'.repeat(300)}`, 2)
    await cache.set('fragments:detail:header', 3)
    const cleared = await cache.invalidatePrefix('pages:')
    expect(cleared).toBe(2)
    expect(await cache.get(`pages:detail:${'a'.repeat(300)}`)).toBeNull()
    expect(await cache.get(`pages:detail:${'b'.repeat(300)}`)).toBeNull()
    expect(await cache.get('fragments:detail:header')).toBe(3)
  })

  it('invalidate removes a long-keyed entry', async () => {
    const cache = createMemoryCache()
    const longKey = `pages:detail:${'z'.repeat(300)}`
    await cache.set(longKey, 'value')
    await cache.invalidate(longKey)
    expect(await cache.get(longKey)).toBeNull()
  })
})
