/**
 * Zod schemas for /api/templates list endpoint.
 *
 * Scope note: GET /api/templates/:name/schema returns a spread JSON
 * Schema with `hasEditor`/`editorUrl`/`fieldsBaseUrl` siblings — that
 * wire shape is awkward to validate against a static Zod schema
 * because the JSON Schema payload is arbitrary. Migrating it is a
 * separate slice that should come with reshaping the response into
 * a proper `{ jsonSchema, ... }` envelope.
 */
import { z } from 'zod'
import { IssueSchema } from './validation.js'

/** Summary used in list responses (GET /api/templates). */
export const TemplateSummarySchema = z.object({
  name: z.string(),
})
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>

/**
 * GET /api/templates/:name/impact (Validation Cut 6).
 *
 * One row per page or fragment that uses the template — top-level
 * (manifest.template) AND nested inline components (recursive walk).
 * `issues` is the scanner's per-item issue list; empty when the item
 * is clean.
 */
export const TemplateImpactItemSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
  itemPath: z.string(),
  issues: z.array(IssueSchema),
})
export type TemplateImpactItem = z.infer<typeof TemplateImpactItemSchema>

export const TemplateImpactResponseSchema = z.object({
  template: z.string(),
  items: z.array(TemplateImpactItemSchema),
  /** Convenience: items.filter(i => i.issues.length > 0).length. */
  affectedItemCount: z.number().int().nonnegative(),
})
export type TemplateImpactResponse = z.infer<typeof TemplateImpactResponseSchema>
