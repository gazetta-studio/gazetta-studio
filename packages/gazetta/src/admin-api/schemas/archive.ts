/**
 * Zod schemas for /api/{pages,fragments}/:name/{archive,unarchive,purge}
 * routes — single source of truth for request/response shapes per
 * MCP discipline (see feature-design-process.md non-foundational
 * disciplines + testing-plan.md Priority 3.2).
 *
 * The 409 purge-blocked response carries a structured resolution
 * body (per design-soft-delete.md Q4 H1 lock) that the admin UI
 * consumes to drive the resolve modal.
 */
import { z } from 'zod'

/**
 * POST /api/{kind}/:name/archive body. `aliasOf` is optional —
 * absent means pure soft-delete (the runtime emits 410 Gone for
 * pages and the renderer throws ArchivedNoAliasError for fragments).
 */
export const ArchiveRequestSchema = z.object({
  /** Live target name to redirect to. Pages: name resolves via
   *  `deriveRoute`. Fragments: referenced as `@name` at compose time. */
  aliasOf: z.string().min(1).optional(),
})
export type ArchiveRequest = z.infer<typeof ArchiveRequestSchema>

/** Standard ok response with the archived item's name. */
export const ArchiveResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  archivedAt: z.string(),
  aliasOf: z.string().optional(),
})
export type ArchiveResponse = z.infer<typeof ArchiveResponseSchema>

export const UnarchiveResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
})
export type UnarchiveResponse = z.infer<typeof UnarchiveResponseSchema>

/** Reference one alias-pointer in a 409 DELETE_BLOCKED body. */
export const AliasPointerSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
})
export type AliasPointer = z.infer<typeof AliasPointerSchema>

/** Reference one live ref in a 409 DELETE_BLOCKED body. */
export const LiveRefSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
})
export type LiveRef = z.infer<typeof LiveRefSchema>

/**
 * 409 response body when purge is blocked by aliases or live refs.
 * Per design-soft-delete.md Q4 H1: refusal returns this structured
 * shape so the admin UI can drive the resolve modal (re-target
 * aliases / drop alias / cascade-purge / resolve refs / try again).
 */
export const PurgeBlockedSchema = z.object({
  code: z.literal('DELETE_BLOCKED'),
  aliases: z.array(AliasPointerSchema),
  liveRefs: z.array(LiveRefSchema),
})
export type PurgeBlocked = z.infer<typeof PurgeBlockedSchema>

export const PurgeResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
})
export type PurgeResponse = z.infer<typeof PurgeResponseSchema>
