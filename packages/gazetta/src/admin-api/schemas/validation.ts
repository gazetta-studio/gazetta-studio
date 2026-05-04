/**
 * Zod schemas for the validation response. The save handlers return a 409
 * with this shape when save-delta validation finds error-severity issues.
 *
 * Cut 1: only the response shape ships. Cut 2 will add a separate
 * `/api/validation/issues` route shape; Cut 4 will add a publish-gate shape.
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
