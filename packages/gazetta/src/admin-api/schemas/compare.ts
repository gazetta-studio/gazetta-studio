/**
 * Zod schema for /api/compare — logical diff between source and target.
 *
 * Mirrors the `CompareResult` type that compare.ts returns from
 * `compareTargets`. The server sends it verbatim via `c.json(result)`,
 * so the wire shape is identical to the compare function's return
 * type. Keeping both defined through z.infer means there's a single
 * source of truth rather than a TS interface *and* a Zod schema that
 * could drift apart.
 */
import { z } from 'zod'

export const InvalidTemplateSchema = z.object({
  name: z.string(),
  errors: z.array(z.string()),
})
export type InvalidTemplate = z.infer<typeof InvalidTemplateSchema>

export const CompareResultSchema = z.object({
  /** Items present locally but not on target (no sidecar found) */
  added: z.array(z.string()),
  /** Items present on both, hashes differ */
  modified: z.array(z.string()),
  /** Items present on target but not locally */
  deleted: z.array(z.string()),
  /** Items present on both with matching hashes */
  unchanged: z.array(z.string()),
  /** Target has no sidecars at all (never published, or pre-sidecar) */
  firstPublish: z.boolean(),
  /** Templates that failed to scan — compare still completes, but hashes for affected pages may be off */
  invalidTemplates: z.array(InvalidTemplateSchema),
})
export type CompareResult = z.infer<typeof CompareResultSchema>

/**
 * Query of GET /api/compare. `target` is the destination to diff against
 * (the handler checks it's present); `source` the target read from.
 */
export const CompareQuerySchema = z.object({
  target: z.string().optional(),
  source: z.string().optional(),
})
