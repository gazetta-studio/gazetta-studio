/**
 * Zod schemas for /api/publish and /api/publish/stream.
 *
 * PublishResult is the per-target terminal outcome. PublishProgress is
 * the SSE event union streamed from /publish/stream — six discriminated
 * variants keyed by `kind`. Shared with the client so the stream parser
 * can derive its event type via z.infer rather than hand-maintaining a
 * parallel TS union.
 *
 * Reuses InvalidTemplate from compare.ts — same shape in both endpoints.
 */
import { z } from 'zod'
import { InvalidTemplateSchema } from './compare.js'
import { TargetCapabilitiesSchema } from './targets.js'
import { PublishAuditResponseSchema } from './validation.js'

/** Per-target outcome of a publish action. */
export const PublishResultSchema = z.object({
  target: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  copiedFiles: z.number(),
})
export type PublishResult = z.infer<typeof PublishResultSchema>

/**
 * SSE event variants streamed by POST /api/publish/stream. The server
 * emits events in this order:
 *   start → (target-start → progress* → target-result)+ → done
 * or:
 *   fatal (error anywhere before `done`).
 */
export const PublishProgressSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('start'),
    targets: z.array(z.string()),
    itemsPerTarget: z.number(),
  }),
  z.object({
    kind: z.literal('target-start'),
    target: z.string(),
    total: z.number(),
  }),
  z.object({
    kind: z.literal('progress'),
    target: z.string(),
    current: z.number(),
    total: z.number(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal('target-result'),
    result: PublishResultSchema,
  }),
  z.object({
    kind: z.literal('done'),
    results: z.array(PublishResultSchema),
  }),
  z.object({
    kind: z.literal('fatal'),
    error: z.string(),
    invalidTemplates: z.array(InvalidTemplateSchema).optional(),
  }),
])
export type PublishProgress = z.infer<typeof PublishProgressSchema>

/**
 * Body of POST /api/publish and /api/publish/stream. Missing `items` or
 * `targets` default to empty so the handler answers its own
 * "No items specified" / "No targets specified".
 */
export const PublishRequestSchema = z.object({
  /** `pages/<name>[:<locale>]`, `fragments/<name>[:<locale>]`, `templates/<name>` or `assets/<name>`. */
  items: z.array(z.string()).default([]),
  /** Destination target names. */
  targets: z.array(z.string()).default([]),
  /** Editable target to publish from; defaults to the default editable target. */
  source: z.string().optional(),
})
export type PublishRequest = z.infer<typeof PublishRequestSchema>

/** Response of POST /api/publish (200 when every target succeeded, 207 otherwise). */
export const PublishResponseSchema = z.object({
  results: z.array(PublishResultSchema),
})
export type PublishResponse = z.infer<typeof PublishResponseSchema>

/** The request-id header publish hands to hooks. */
export const PublishHeadersSchema = z.object({
  'x-request-id': z.string().optional(),
})

/** Body of POST /api/fetch. `source` is checked by the handler. */
export const FetchRequestSchema = z.object({
  /** Target to fetch from. */
  source: z.string().optional(),
  /** Items to copy; every page, fragment and template when omitted. */
  items: z.array(z.string()).optional(),
  /** Editable target to write into; defaults to the default editable target. */
  destination: z.string().optional(),
})
export type FetchRequest = z.infer<typeof FetchRequestSchema>

/** Query of GET /api/dependents. `item` is checked by the handler. */
export const DependentsQuerySchema = z.object({
  /** `fragments/<name>`. */
  item: z.string().optional(),
  /** Target whose index to read; the source when omitted. */
  target: z.string().optional(),
  source: z.string().optional(),
})

/** Query of POST /api/publish/audit: the source target to audit. */
export const PublishAuditQuerySchema = z.object({
  target: z.string().optional(),
})

/**
 * Response of POST /api/publish/audit: the audit result, plus the
 * destination's capabilities when the publish set includes archived items.
 */
export const PublishAuditResultSchema = PublishAuditResponseSchema.extend({
  capabilities: TargetCapabilitiesSchema.optional(),
})
export type PublishAuditResult = z.infer<typeof PublishAuditResultSchema>
