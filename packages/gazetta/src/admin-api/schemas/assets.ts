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
  AssetNameInvalidError,
  AssetNameReservedError,
  AssetPathTraversalError,
  AssetSizeExceededError,
  AssetStorageError,
  AssetValidationError,
  AssetVariantGenerationError,
  type AssetErrorCode,
} from '../../assets/errors.js'

/**
 * Body of a 409 response on DELETE /api/assets/:name — emitted when the
 * asset is still referenced by at least one page or fragment. `refs` is
 * the exact usage list the server found; the client renders it verbatim.
 */
export const AssetInUseResponseSchema = z.object({
  code: z.literal('ASSET_IN_USE'),
  message: z.string(),
  assetName: z.string(),
  refs: z.array(AssetRefSchema),
})
export type AssetInUseResponse = z.infer<typeof AssetInUseResponseSchema>
