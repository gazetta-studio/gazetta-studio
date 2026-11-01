/**
 * Zod schemas + typed errors for asset-domain HTTP contracts.
 *
 * Thin transport envelopes around the domain-owned shapes. The `AssetRef`
 * schema lives in `../../assets/refs.ts` (domain); this module wraps it
 * in HTTP-shaped responses and re-exports the domain error classes so
 * both server and admin client can import them from a single place.
 *
 * Single source of truth. The server throws `AssetInUseError` from the
 * asset domain; the route adapter serializes via `AssetInUseResponseSchema`;
 * the admin client parses the 409 body into the same `AssetInUseError`
 * class. No parallel client-only copy.
 */
import { z } from 'zod'
import { ErrorResponseSchema } from './error.js'
import { AssetRefSchema } from '../../assets/refs.js'

// Re-export the domain schema + type so admin-api consumers can get
// everything they need from this barrel without reaching into the domain.
export { AssetRefSchema } from '../../assets/refs.js'
export type { AssetRef } from '../../assets/refs.js'

// Re-export the typed error hierarchy. The admin client imports
// `AssetInUseError` from here and uses `instanceof` to branch; the server
// throws the same class. One identity across the wire.
export {
  AssetInUseError,
  AssetKindMismatchError,
  AssetManifestCorruptError,
  AssetManifestNotFoundError,
  AssetMimeMismatchError,
  AssetMimeUnsupportedError,
  AssetNameCollisionError,
  AssetNameInvalidError,
  AssetNameReservedError,
  AssetPathTraversalError,
  AssetPreprocessError,
  AssetSizeExceededError,
  AssetStorageError,
  AssetValidationError,
  AssetVariantGenerationError,
  type AssetErrorCode,
} from '../../assets/errors.js'

/**
 * Problem body of a 409 response on DELETE /api/assets/:name — emitted when the
 * asset is still referenced by at least one page or fragment. `refs` is
 * the exact usage list the server found; the client renders it verbatim.
 */
export const AssetInUseResponseSchema = ErrorResponseSchema.extend({
  code: z.literal('ASSET_IN_USE'),
  detail: z.string(),
  assetName: z.string(),
  refs: z.array(AssetRefSchema),
})
export type AssetInUseResponse = z.infer<typeof AssetInUseResponseSchema>

/**
 * Problem body of a 409 response on POST /api/assets/:name/rename-to/:newName —
 * emitted when `newName` already maps to an existing asset. The author
 * either picks a different name or uses replace-and-delete to merge.
 */
export const AssetNameCollisionResponseSchema = ErrorResponseSchema.extend({
  code: z.literal('ASSET_NAME_COLLISION'),
  detail: z.string(),
  newName: z.string(),
})
export type AssetNameCollisionResponse = z.infer<typeof AssetNameCollisionResponseSchema>

/**
 * Body of a 200 response on POST /api/assets/:name/suggest-alt — the AI
 * adapter's structured suggestion. `refused: true` means the model
 * declined; consumers display `refusalReason` instead of auto-filling
 * the alt input. Refusals are NOT errors — the API call succeeded.
 *
 * 503 (no adapter / unsupported MIME) and 502 (adapter call failed)
 * answer the problem+json shape (`ErrorResponseSchema`) — see `AIErrorCode` in
 * `ai/errors.ts` for the code values.
 */
export const SuggestAltResponseSchema = z.object({
  text: z.string(),
  refused: z.boolean(),
  refusalReason: z.string().nullable(),
})
export type SuggestAltResponse = z.infer<typeof SuggestAltResponseSchema>

const FocalPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })

const AssetVariantSchema = z.object({ width: z.number(), path: z.string(), size: z.number() })

/** Library-list summary of an asset (GET /api/assets, GET /api/assets/:name). */
export const AssetSummarySchema = z.object({
  name: z.string(),
  kind: z.enum(['embedded', 'downloadable', 'font']),
  mime: z.string(),
  size: z.number(),
  hash: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  alt: z.string().nullable(),
  focalPoint: FocalPointSchema.optional(),
  animated: z.boolean().optional(),
  poster: z.string().nullable().optional(),
  uploadedAt: z.string(),
  overrideLocales: z.array(z.string()).readonly(),
  overrideThemes: z.array(z.string()).readonly(),
})

/** Body of a 200 response on PATCH /api/assets/:name. */
export const AssetMetadataResponseSchema = z.object({ manifest: AssetSummarySchema })

/** An asset's default manifest (`{name}.asset.json`). */
export const AssetManifestSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  kind: z.enum(['embedded', 'downloadable', 'font']),
  source: z.literal('internal'),
  mime: z.string(),
  size: z.number(),
  hash: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  variants: z.array(AssetVariantSchema).readonly(),
  alt: z.string().nullable(),
  focalPoint: FocalPointSchema.optional(),
  animated: z.boolean().optional(),
  frames: z.number().optional(),
  duration: z.number().nullable().optional(),
  poster: z.string().nullable().optional(),
  uploadedAt: z.string(),
  uploadedBy: z.string(),
})

/** Body of a 201 response on POST /api/assets. */
export const AssetUploadResponseSchema = z.object({
  manifest: AssetManifestSchema,
  /** Where the bytes were written, relative to the target root. */
  bytesPath: z.string(),
})

/** A locale (or theme) bytes override manifest (`{name}.asset.{selector}.json`). */
export const LocaleBytesManifestSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  hash: z.string(),
  size: z.number(),
  mime: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  variants: z.array(AssetVariantSchema).readonly(),
  alt: z.string().nullable().optional(),
  focalPoint: FocalPointSchema.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})

/** Body of a 201 response on POST /api/assets/:name/locale-bytes. */
export const LocaleBytesUploadResponseSchema = z.object({
  manifest: LocaleBytesManifestSchema,
  bytesPath: z.string(),
})

/**
 * Body of PATCH /api/assets/:name. Alt is three-state: a string, `""`
 * (decorative) or `null` (cleared); an omitted field is left unchanged.
 */
export const AssetMetadataPatchSchema = z.object({
  alt: z.string().nullable().optional(),
  focalPoint: FocalPointSchema.nullable().optional(),
})

/** Path of the single-asset routes. */
export const AssetNameParamSchema = z.object({ name: z.string() })

/** Path of the rename-to and replace-with routes. */
export const AssetRenameParamSchema = z.object({ name: z.string(), newName: z.string() })

/**
 * Query of the locale-bytes and suggest-alt routes. The handler checks
 * `locale` and `theme` and answers its own message.
 */
export const AssetSelectorQuerySchema = z.object({
  target: z.string().optional(),
  /** BCP 47 locale code, lowercase. */
  locale: z.string().optional(),
  /** Theme name, lowercase. */
  theme: z.string().optional(),
})

/** A file field in a multipart body; the handler checks it's a file. */
const FileFieldSchema = z.any().optional().meta({ type: 'string', format: 'binary' })

/** Multipart body of POST /api/assets. The handler checks `file` and `name`. */
export const AssetUploadFormSchema = z.object({
  /** The bytes. */
  file: FileFieldSchema,
  /** The asset name. */
  name: z.any().optional().meta({ type: 'string' }),
  /** Alt text; empty means decorative, absent means not set. */
  alt: z.any().optional().meta({ type: 'string' }),
})

/** Multipart body of POST /api/assets/:name/locale-bytes. */
export const LocaleBytesFormSchema = z.object({ file: FileFieldSchema })

/** Query of POST /api/assets/:name/suggest-alt; the handler checks `locale`. */
export const SuggestAltQuerySchema = AssetSelectorQuerySchema.omit({ theme: true })
