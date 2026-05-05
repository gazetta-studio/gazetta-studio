import type { AdminCache } from './types.js'
import { createMemoryCache, type MemoryCacheOptions } from './memory.js'

/**
 * Operator-facing cache provider factories. Operators import these into
 * `site.config.ts` and call them inline at the `cache:` field; the field's
 * value IS the constructed `AdminCache` instance (Path X — see
 * `design-provider-config.md`).
 *
 * `gazetta.config.ts defaults.cache` is the documented Exception A: it
 * accepts raw options (not a constructed instance) so each inheriting
 * site builds its own per-site instance from the same defaults — required
 * by `design-cache.md` Gap 3 (per-site cache isolation).
 */

/** In-process LRU cache. Default 10K entries / 50MB approximate cap. */
export function memoryCache(opts: MemoryCacheOptions = {}): AdminCache {
  return createMemoryCache(opts)
}

export type { MemoryCacheOptions }
