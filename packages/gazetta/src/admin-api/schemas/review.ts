/**
 * Review routes' wire shapes (design-review-workflow.md cut 7, #521).
 * One review state per page or fragment, covering its translations, so
 * no locale anywhere (2026-10-25 item 8).
 */
import { z } from 'zod'
import { AuditEventSchema } from './audit.js'

export const ReviewStateSchema = z.enum(['draft', 'pending-review', 'approved'])

/** The item's review state after a transition, or as stored. */
export const ReviewStatusSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
  state: ReviewStateSchema,
  /** Who submitted; absent in draft. */
  submitter: z.string().optional(),
  /** Approvals needed, snapshotted at submit; absent in draft. */
  requiredApprovers: z.number().int().optional(),
  /** Who has approved this submission. */
  approvers: z.array(z.string()),
  submittedAt: z.string().optional(),
  approvedAt: z.string().optional(),
})
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>

/**
 * `GET /api/review/{kind}/:name`: the state plus the item's review
 * events, newest first as the audit query returns them (#1244, #1245).
 */
export const ReviewDetailSchema = ReviewStatusSchema.extend({
  history: z.array(AuditEventSchema),
})
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>

/** Reject's body: a comment is required; an empty one answers 400 `COMMENT_REQUIRED`. */
export const ReviewRejectRequestSchema = z.object({ comment: z.string().optional() })
