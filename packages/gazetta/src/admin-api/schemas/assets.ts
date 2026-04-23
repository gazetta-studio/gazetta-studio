/**
 * Zod schemas for asset-domain HTTP contracts.
 *
 * Thin transport envelopes around the domain-owned shapes. The `AssetRef`
 * schema lives in `../../assets/refs.ts` (domain) — this module just wraps
 * it in HTTP-shaped responses and exports their inferred types for the
 * admin client to consume via `gazetta/admin-api/schemas`.
 *
 * v1 surface covered:
 *   - `AssetInUseResponseSchema` — body of 409 on DELETE /api/assets/:name
 *
 * Upload and list endpoints' types predate this barrel; they still live
 * in `schema/types.ts` (AssetSummary, AssetManifest). Migrating them is a
 * separate pass — out of Step 7 scope.
 */
import { z } from 'zod'
import { AssetRefSchema } from '../../assets/refs.js'

// Re-export the domain schema + type so admin-api consumers can get
// everything they need from this barrel without reaching into the domain.
export { AssetRefSchema } from '../../assets/refs.js'
export type { AssetRef } from '../../assets/refs.js'

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
