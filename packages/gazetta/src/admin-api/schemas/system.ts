/**
 * Zod schema for /api/system/cache/stats — operational diagnostics
 * for the admin's L4 `AdminCache`.
 *
 * Shape mirrors `CacheStats` from `cache/types.ts`. Required floor is
 * (hits, misses, size); optional fields surface when the underlying
 * provider tracks them (MemoryCache tracks all; future providers may
 * not).
 */
import { z } from 'zod'

export const CacheStatsResponseSchema = z.object({
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative().optional(),
  evictions: z.number().int().nonnegative().optional(),
  bytesApproximate: z.number().int().nonnegative().optional(),
  oldestEntryAt: z.string().optional(),
  lastInvalidation: z
    .object({
      prefix: z.string(),
      at: z.string(),
      source: z.string(),
    })
    .optional(),
  subscribeReconnects: z.number().int().nonnegative().optional(),
})

export type CacheStatsResponse = z.infer<typeof CacheStatsResponseSchema>
