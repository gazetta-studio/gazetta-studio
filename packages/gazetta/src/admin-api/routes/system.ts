import { createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import type { CacheStats, InvalidationEvent } from '../../cache/types.js'
import { CacheStatsResponseSchema, type CacheStatsResponse } from '../schemas/system.js'
import { TargetQuerySchema } from '../schemas/target-query.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { apiApp, json, problems } from '../openapi.js'

const cacheStats = createRoute({
  method: 'get',
  path: '/system/cache/stats',
  summary: "The admin cache's statistics",
  middleware: [requireCapability('configure:site')] as const,
  request: { query: TargetQuerySchema },
  responses: {
    200: json(CacheStatsResponseSchema, 'A snapshot of the cache'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
  },
})

const cacheInvalidations = createRoute({
  method: 'get',
  path: '/system/cache/invalidations',
  summary: "The admin cache's invalidations, as they happen",
  middleware: [requireCapability('configure:site')] as const,
  request: { query: TargetQuerySchema },
  responses: {
    200: {
      description:
        'Server-sent events: one `ready` event, then an `invalidation` event (JSON `{ prefix, ... }`) per invalidation',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
  },
})

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
  const app = apiApp()

  app.openapi(cacheStats, async c => {
    const source = await resolve(c.req.valid('query').target)
    // `stats()` is optional on the AdminCache contract — providers
    // that don't expose it return a minimum-floor zero snapshot so
    // the response shape stays stable across providers.
    const stats: CacheStats = (await source.cache.stats?.()) ?? { hits: 0, misses: 0, size: 0 }
    const body: CacheStatsResponse = stats
    return c.json(body, 200)
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
   *
   * # Reconnect contract — clients must reset their cache
   *
   * The stream does NOT emit event IDs (`SSEMessage.id`), so the
   * standard EventSource `Last-Event-ID` reconnect mechanism has
   * nothing to anchor on. Servers can't replay missed events.
   * Clients reconnecting must assume "I may have missed any
   * invalidation that happened during the gap" and reset their own
   * cache state. Per `design-offline.md`'s reconnect strategy: full
   * local cache reset is the simplest correctness mechanism.
   *
   * # Multi-instance scope (v1)
   *
   * The stream forwards invalidations from THIS instance's cache
   * only. With v1's `MemoryCache`, there's no cross-instance fan-out;
   * when `RedisCache` ships, its `subscribe()` will deliver cross-
   * instance events via Redis pub/sub and this route forwards them
   * unchanged.
   */
  app.openapi(cacheInvalidations, async c => {
    const source = await resolve(c.req.valid('query').target)
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
