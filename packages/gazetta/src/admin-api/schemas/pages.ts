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
import { isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE } from '../../item-name.js'

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
  /**
   * Template name. Optional because archived pages may omit it
   * (per design-redirect-ui.md Q2 sub-decision A1). Live pages
   * always set this — the persisted-manifest refinement guarantees
   * presence for non-archived rows.
   */
  template: z.string().optional(),
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
  /** Page name — used as the directory name and identity. Must be a safe item name. */
  name: z.string().refine(isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE),
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

/**
 * Cache configuration block as carried on the persisted page manifest.
 * Loose record at the schema layer — the runtime cast happens in the
 * loader (`packages/gazetta/src/manifest.ts`). Mirrors the existing
 * loader behavior, which trusts the field's shape after JSON parse.
 */
const PageCacheConfigSchema = z.record(z.string(), z.unknown()).optional()

/**
 * Persisted shape of a page manifest (`page.json`) — what's stored on
 * disk. Distinct from `CreatePageRequestSchema` (the create-page
 * contract), which always requires a template. Per design-redirect-ui.md
 * Q2 sub-decision A1 (locked per impl-doc Q1): `template` is
 * conditionally optional via `.refine` rather than a sentinel template
 * value (`'__redirect__'`) or a `z.discriminatedUnion`. `.refine` keeps
 * the base shape stable as new archive-related fields (e.g., a future
 * `gone: true` per design-redirects.md) extend it.
 *
 * Reflects the runtime reality: the renderer short-circuits archived
 * items via `if (isArchived(page)) return publishArchiveMarker(...)`,
 * never executing a template, so the archive-only manifest shape
 * `{ archived: true, aliasOf: 'x' }` is legitimate. Live manifests
 * still require a template.
 */
export const PageManifestSchema = z
  .object({
    template: z.string().min(1).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    /**
     * Components retain their full ComponentEntry shape (string ref
     * `"@name"` or inline `{ template, content?, components? }`). The
     * schema accepts an array of unknowns at this layer; structural
     * validation lives in the loader's `parseComponents` (per
     * existing parser pattern, which is what page.json reads through).
     */
    components: z.array(z.unknown()).optional(),
    metadata: PageMetadataSchema,
    cache: PageCacheConfigSchema,
    // Archive fields per design-soft-delete.md Q1 A1.
    archived: z.boolean().optional(),
    archivedAt: z.string().optional(),
    archivedBy: z.string().optional(),
    aliasOf: z.string().optional(),
    // Forward-compat passthrough for review-workflow (per
    // design-soft-delete.md Cut 14 + manifest.ts:parseReviewFields).
    reviewState: z.string().optional(),
  })
  .refine(data => data.archived === true || typeof data.template === 'string', {
    message: 'Live pages require a template; archived pages may omit it',
    path: ['template'],
  })
export type PageManifestParsed = z.infer<typeof PageManifestSchema>

/**
 * Response for POST /api/pages: `resolution` is set when the create
 * resolved an archived-name conflict (`?onConflict=`).
 */
export const CreatedPageResponseSchema = CreatePageResponseSchema.extend({
  resolution: z.string().optional(),
})
export type CreatedPageResponse = z.infer<typeof CreatedPageResponseSchema>

/**
 * Response for GET /api/pages/:name. Loose: `afterLoad` hooks may add or
 * change fields (design-hooks.md).
 */
export const PageDetailSchema = z.looseObject({
  name: z.string(),
  route: z.string(),
  template: z.string().optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  components: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dir: z.string().optional(),
  locale: z.string().optional(),
  locales: z.array(z.string()).optional(),
  archived: z.boolean().optional(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  aliasOf: z.string().optional(),
})
export type PageDetail = z.infer<typeof PageDetailSchema>

/**
 * Body for PUT /api/pages/:name: the fields to change; absent fields keep
 * the stored value. Loose, and metadata keeps keys the form doesn't show
 * (design-editor-ux.md, "Page metadata is a pending lane").
 */
export const SavePageRequestSchema = z.looseObject({
  template: z.string().optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  components: z.array(z.unknown()).optional(),
  metadata: z.looseObject(PageMetadataSchema.unwrap().shape).optional(),
  cache: z.record(z.string(), z.unknown()).optional(),
})
export type SavePageRequest = z.infer<typeof SavePageRequestSchema>

/** Response for PUT /api/pages/:name and /api/fragments/:name; `etag` is also the ETag header. */
export const SaveResponseSchema = z.object({
  ok: z.literal(true),
  etag: z.string(),
})
export type SaveResponse = z.infer<typeof SaveResponseSchema>
