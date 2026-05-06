import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { CacheStats, InvalidationEvent } from '../../cache/types.js'
import type { CacheStatsResponse } from '../schemas/system.js'
import type { SourceContextResolver } from '../source-context.js'

/**
 * System routes — operational diagnostics for the admin process.
 *
 * `GET /api/system/cache/stats` returns the current snapshot of the
 * resolved source's `AdminCache`. Operators (or external monitoring)
 * pull this on demand; the periodic structured log emitted from
 * `admin-api/index.ts` covers passive observability via log
 * aggregators.
 *
 * # Why per-source, not process-global
 *
 * Per `design-cache.md` Gap 3, each `SourceContext` carries its own
 * `AdminCache` instance scoped via `forSite()`. Different targets
 * (read via `?target=...`) get different caches. The route mirrors
 * the rest of admin-api: every endpoint resolves a source from the
 * `?target=` query, so stats follow the same convention. Operators
 * monitoring "cache health" pick a target the same way they pick
 * one for `/api/pages`.
 */
export function systemRoutes(resolve: SourceContextResolver) {
  const app = new Hono()

  app.get('/api/system/cache/stats', async c => {
    const source = await resolve(c.req.query('target'))
    // `stats()` is optional on the AdminCache contract — providers
    // that don't expose it return a minimum-floor zero snapshot so
    // the response shape stays stable across providers.
    const stats: CacheStats = (await source.cache.stats?.()) ?? { hits: 0, misses: 0, size: 0 }
    const body: CacheStatsResponse = stats
    return c.json(body)
  })

  /**
   * Server-Sent Events stream of cache invalidations on the resolved
   * source's cache. Powers the L4→L6 cascade per `design-cache.md`'s
   * "Offline composition" section: server-side L4 invalidations
   * trigger SSE broadcast; browser-side L6 caches subscribe and
   * invalidate their entries in response.
   *
   * Subscribers receive the consumer-facing prefix (e.g., `pages:`)
   * — the version-prefix and per-site scope are stripped by the
   * forSite wrapper before the event reaches the route.
   *
   * Cleanup: stream.onAbort fires when the client disconnects (tab
   * close, navigation, network drop). The subscribe disposer
   * detaches the handler from the cache so we don't leak between
   * connections.
   */
  app.get('/api/system/cache/invalidations', async c => {
    const source = await resolve(c.req.query('target'))
    return streamSSE(c, async stream => {
      // Buffer events between MemoryCache's synchronous emit and our
      // async stream.writeSSE. If the client is slow to read, events
      // accumulate here rather than blocking the invalidation that
      // triggered them. Unbounded in v1 — admin invalidation volume
      // is low; bound + drop-oldest lands when concrete pain surfaces.
      const queue: InvalidationEvent[] = []
      let resolveWaiter: (() => void) | null = null

      const dispose = source.cache.subscribe(event => {
        queue.push(event)
        if (resolveWaiter) {
          const r = resolveWaiter
          resolveWaiter = null
          r()
        }
      })

      stream.onAbort(() => {
        dispose()
        if (resolveWaiter) {
          const r = resolveWaiter
          resolveWaiter = null
          r()
        }
      })

      // Send a comment immediately so the client's EventSource
      // transitions to OPEN — useful for tests that wait on
      // readyState before triggering invalidations.
      await stream.writeSSE({ data: '', event: 'ready' })

      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => {
            resolveWaiter = resolve
          })
          continue
        }
        const event = queue.shift()!
        await stream.writeSSE({
          event: 'invalidation',
          data: JSON.stringify(event),
        })
      }
    })
  })

  return app
}
