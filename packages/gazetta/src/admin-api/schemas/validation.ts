/**
 * Zod schemas for the validation response. The save handlers return a 409
 * with `ValidationFailedResponseSchema` when save-delta validation finds
 * error-severity issues. Cut 2 adds the `/api/validation/issues` GET shape
 * for the background scanner's accumulated state.
 */
import { z } from 'zod'

export const SeveritySchema = z.enum(['error', 'warn', 'info'])
export type Severity = z.infer<typeof SeveritySchema>

export const IssueSchema = z.object({
  validator: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  itemPath: z.string(),
  contentPath: z.string().optional(),
  suppressible: z.boolean().optional(),
})
export type Issue = z.infer<typeof IssueSchema>

/**
 * 409 response body when save-delta validation blocks a write.
 *
 * `code` is a stable string for client dispatch; `issues` is the full set
 * found (both `error` and below — the client decides what to render).
 */
export const ValidationFailedResponseSchema = z.object({
  code: z.literal('VALIDATION_FAILED'),
  issues: z.array(IssueSchema),
})
export type ValidationFailedResponse = z.infer<typeof ValidationFailedResponseSchema>

/**
 * GET /api/validation/issues — current accumulated issues from the background
 * scanner (Cut 2). The drawer fetches this on admin load + on save SSE; it
 * doesn't run scans itself.
 */
export const ValidationIssuesResponseSchema = z.object({
  /** All current issues across the site, flat list. UI groups by `itemPath`. */
  issues: z.array(IssueSchema),
  /** Total count (== issues.length) — convenience field for the dot/badge. */
  total: z.number().int().nonnegative(),
})
export type ValidationIssuesResponse = z.infer<typeof ValidationIssuesResponseSchema>
