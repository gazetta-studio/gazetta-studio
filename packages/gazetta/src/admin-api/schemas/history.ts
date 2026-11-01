/**
 * Zod schemas for /api/history* endpoints.
 *
 * Revision mirrors the `Revision` interface in history.ts (metadata
 * only — snapshot is server-internal and stripped from the wire).
 * ListHistoryResponse wraps it in `{ revisions }`; RestoreResponse
 * is the shared shape for both /undo and /restore.
 */
import { z } from 'zod'

export const RevisionOperationSchema = z.enum(['save', 'publish', 'rollback'])
export type RevisionOperation = z.infer<typeof RevisionOperationSchema>

/** Summary of a single revision — server emits this from /history. */
export const RevisionSummarySchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    operation: RevisionOperationSchema,
    author: z.string().optional(),
    source: z.string().optional(),
    items: z.array(z.string()),
    message: z.string().optional(),
    restoredFrom: z.string().optional(),
    /** How the write came in (Q47). Absent on revisions written outside the admin. */
    channel: z.enum(['browser', 'token', 'mcp']).optional(),
    /** The agent run it belongs to (Q22). */
    runId: z.string().optional(),
    /** For a token write: the token, and whether an elevation covered it. */
    tokenId: z.string().optional(),
    elevated: z.boolean().optional(),
  })
  .meta({ id: 'RevisionSummary' })
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>

/** Response body for GET /api/history. */
export const ListHistoryResponseSchema = z.object({
  revisions: z.array(RevisionSummarySchema),
})
export type ListHistoryResponse = z.infer<typeof ListHistoryResponseSchema>

/**
 * Response body for both POST /api/history/undo and
 * POST /api/history/restore. `restoredFrom` is the revision id the
 * new revision rolled back to.
 */
export const RestoreRevisionResponseSchema = z.object({
  revision: RevisionSummarySchema,
  restoredFrom: z.string(),
})
export type RestoreRevisionResponse = z.infer<typeof RestoreRevisionResponseSchema>

/**
 * Query of POST /api/history/undo. `target` is checked by the handler,
 * which answers its own message.
 */
export const HistoryUndoQuerySchema = z.object({
  /** The target whose history to use. */
  target: z.string().optional(),
  source: z.string().optional(),
})

/** Query of GET /api/history. */
export const HistoryListQuerySchema = HistoryUndoQuerySchema.extend({
  /** How many revisions, newest first (default 50). */
  limit: z.string().optional(),
})

/** Query of POST /api/history/restore. `id` is checked by the handler. */
export const HistoryRestoreQuerySchema = HistoryUndoQuerySchema.extend({
  /** The revision to restore. */
  id: z.string().optional(),
})
