/**
 * Zod schemas for /api/pages routes — the single source of truth for
 * request/response shapes on that endpoint.
 *
 * Shared across server (routes/pages.ts uses .parse() to validate
 * incoming bodies) and client (apps/admin/src/client/api/client.ts
 * derives types via z.infer) so drift between them is impossible:
 * either one of them fails to compile, or the contract test in
 * apps/admin/tests/api-contract.test.ts surfaces the mismatch.
 *
 * First slice — POST /api/pages only. The rest of the endpoints still
 * use hand-rolled shape checks; migrating them is mechanical and
 * tracked as a follow-up to testing-plan.md Priority 3.2.
 */
import { z } from 'zod'

/** SEO metadata for a page — surfaced in <head> and used by sitemap generation. */
export const PageMetadataSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    ogImage: z.string().optional(),
    canonical: z.string().optional(),
    robots: z.string().optional(),
  })
  .optional()
export type PageMetadata = z.infer<typeof PageMetadataSchema>

/** Summary used in list responses (GET /api/pages). */
export const PageSummarySchema = z.object({
  name: z.string(),
  route: z.string(),
  template: z.string(),
  locales: z.array(z.string()).optional(),
  /**
   * Archive state per design-soft-delete.md Q1 A1 / Q7 J1. When true,
   * the admin tree renders the page greyed under the "Show archived
   * (N)" filter toggle. Absent or false = live.
   */
  archived: z.boolean().optional(),
  /**
   * Alias target name when archived with aliasOf. Tree row appends
   * "(archived → {aliasOf})" per Q7 J1 visualization.
   */
  aliasOf: z.string().optional(),
})
export type PageSummary = z.infer<typeof PageSummarySchema>

/** Body for POST /api/pages (create). */
export const CreatePageRequestSchema = z.object({
  /** Page name — used as the directory name and identity. Must be non-empty. */
  name: z.string().min(1),
  /** Template name to bind. Must be non-empty. */
  template: z.string().min(1),
  /** Optional initial content; defaults to `{ title: name }` server-side. */
  content: z.record(z.string(), z.unknown()).optional(),
})
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>

/** Response for POST /api/pages (create). */
export const CreatePageResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
})
export type CreatePageResponse = z.infer<typeof CreatePageResponseSchema>
