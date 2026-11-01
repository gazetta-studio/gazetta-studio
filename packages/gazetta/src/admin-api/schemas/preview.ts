/**
 * Zod schemas for the preview routes (`/preview/*`). Outside the
 * versioned API: the draft-overrides format is internal to the admin
 * (design-agent-access.md Q5, design-editor-ux.md).
 */
import { z } from 'zod'

/** A component entry: a fragment reference (`@header`) or an inline component. */
const PreviewComponentEntrySchema = z.union([z.string(), z.looseObject({ name: z.string(), template: z.string() })])

/** Unsaved edits the preview renders over the stored content. */
export const PreviewDraftOverridesSchema = z.object({
  /** Component content by tree path. */
  content: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** Component lists by manifest key (`page:home`, `fragment:header`). */
  structural: z.record(z.string(), z.array(PreviewComponentEntrySchema)).optional(),
})

/** Body of POST /preview/*. */
export const PreviewRequestSchema = z.object({
  overrides: PreviewDraftOverridesSchema.optional(),
})
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>

/** Query of the preview routes: the target to render from. */
export const PreviewQuerySchema = z.object({
  target: z.string().optional(),
})
