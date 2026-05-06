import { Hono } from 'hono'
import type { CacheStats } from '../../cache/types.js'
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

  return app
}
