import { describe, expect, it, vi } from 'vitest'
import { startCacheStatsLogger, type CacheStatsLogEntry } from '../src/admin-api/cache-stats-logger.js'
import { createMemoryCache } from '../src/cache/memory.js'

describe('startCacheStatsLogger', () => {
  it('emits a structured entry on tick()', async () => {
    const cache = createMemoryCache()
    await cache.set('k', 1)
    await cache.get('k') // hit
    await cache.get('missing') // miss

    const entries: CacheStatsLogEntry[] = []
    const logger = startCacheStatsLogger({
      cache,
      intervalMs: 0, // no timer; manual tick only
      sink: e => entries.push(e),
    })

    await logger.tick()
    logger.dispose()

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.level).toBe('info')
    expect(entry?.module).toBe('cache.stats')
    expect(entry?.stats.hits).toBe(1)
    expect(entry?.stats.misses).toBe(1)
    expect(entry?.stats.size).toBe(1)
    // ISO 8601 with Z suffix
    expect(entry?.timestamp).toMatch(/Z$/)
  })

  it('hoists instance to a top-level field for log-aggregator filtering (Gap 2)', async () => {
    const cache = createMemoryCache({ instance: 'pod-log-test' })
    const entries: CacheStatsLogEntry[] = []
    const logger = startCacheStatsLogger({
      cache,
      intervalMs: 0,
      sink: e => entries.push(e),
    })
    await logger.tick()
    logger.dispose()

    expect(entries).toHaveLength(1)
    expect(entries[0]?.instance).toBe('pod-log-test')
    // Also nested inside stats for direct-stats consumers.
    expect(entries[0]?.stats.instance).toBe('pod-log-test')
  })

  it('falls back to a zero snapshot when the provider has no stats()', async () => {
    // Construct a minimal AdminCache that omits the optional stats()
    // method — exercises the fallback path.
    const cache = {
      async get<T>() {
        return null as T | null
      },
      async set() {},
      async invalidate() {},
      async invalidatePrefix() {
        return 0
      },
      subscribe() {
        return () => undefined
      },
    }

    const entries: CacheStatsLogEntry[] = []
    const logger = startCacheStatsLogger({
      cache,
      intervalMs: 0,
      sink: e => entries.push(e),
    })

    await logger.tick()
    logger.dispose()

    expect(entries[0]?.stats).toEqual({ hits: 0, misses: 0, size: 0 })
  })

  it('schedules a periodic timer when intervalMs > 0', async () => {
    vi.useFakeTimers()
    try {
      const cache = createMemoryCache()
      const entries: CacheStatsLogEntry[] = []
      const logger = startCacheStatsLogger({
        cache,
        intervalMs: 1000,
        sink: e => entries.push(e),
      })

      // Tick the timer twice — async sink, so flush microtasks.
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)
      logger.dispose()

      expect(entries.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose() stops the timer', async () => {
    vi.useFakeTimers()
    try {
      const cache = createMemoryCache()
      const entries: CacheStatsLogEntry[] = []
      const logger = startCacheStatsLogger({
        cache,
        intervalMs: 1000,
        sink: e => entries.push(e),
      })

      await vi.advanceTimersByTimeAsync(1000)
      const after1 = entries.length
      logger.dispose()
      await vi.advanceTimersByTimeAsync(5000)
      // No new emissions after dispose.
      expect(entries.length).toBe(after1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues ticking even when an earlier tick rejects', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const cache = {
        async get<T>() {
          return null as T | null
        },
        async set() {},
        async invalidate() {},
        async invalidatePrefix() {
          return 0
        },
        subscribe() {
          return () => undefined
        },
        async stats() {
          calls++
          if (calls === 1) throw new Error('transient')
          return { hits: calls, misses: 0, size: 0 }
        },
      }
      const entries: CacheStatsLogEntry[] = []
      const logger = startCacheStatsLogger({
        cache,
        intervalMs: 1000,
        sink: e => entries.push(e),
      })

      await vi.advanceTimersByTimeAsync(1000) // tick 1 — rejects
      await vi.advanceTimersByTimeAsync(1000) // tick 2 — succeeds
      logger.dispose()

      // First tick emitted nothing (sink only fires when the stats
      // promise resolves); second tick succeeded and emitted.
      expect(entries.length).toBe(1)
      expect(entries[0]?.stats.hits).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
