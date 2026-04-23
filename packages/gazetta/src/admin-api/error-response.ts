/**
 * Generic asset-error → HTTP response mapper.
 *
 * Every `AssetError` subclass carries its own `httpStatus` (see
 * `assets/errors.ts`). This module is the transport-side mirror: given an
 * error, return the (body, status) pair that represents it on the wire.
 *
 * Why a separate helper (OCP):
 *   Route handlers don't pattern-match on specific error subclasses any
 *   more. A new `AssetError` subclass carries its own status; the helper
 *   picks it up automatically. No handler edits, no `if (err instanceof
 *   NewError)` chain to keep in sync.
 *
 * Special-cased structured errors:
 *   Some errors carry extra structured data beyond `{ code, message }` —
 *   notably `AssetInUseError.refs`. The mapper branches on those narrowly
 *   (via subclass check, once) and routes their serialization through
 *   the shared Zod schema. All other errors flatten to the generic
 *   `{ code, message }` envelope.
 */
import type { Context } from 'hono'
import { AssetError, AssetInUseError } from '../assets/errors.js'
import { type AssetInUseResponse, AssetInUseResponseSchema } from './schemas/assets.js'

/**
 * Serialize an `AssetError` into a Hono JSON response at its declared
 * `httpStatus`. Callers use this in a single catch block per route; no
 * instanceof chains needed for the generic case.
 *
 * Returns `null` when the error is not an `AssetError` — the caller
 * should rethrow so the framework's default handler can produce a 500.
 */
export function respondWithAssetError(c: Context, err: unknown): Response | null {
  if (!(err instanceof AssetError)) return null

  if (err instanceof AssetInUseError) {
    // 409 carries the usage list. Validated through the shared schema so
    // any drift between server serialization and client-derived types is
    // caught by Zod at runtime in dev and by TypeScript at build time.
    const body: AssetInUseResponse = AssetInUseResponseSchema.parse({
      code: err.code,
      message: err.message,
      assetName: err.assetName,
      refs: err.refs,
    })
    return c.json(body, err.httpStatus)
  }

  // Generic envelope for every other AssetError subclass.
  return c.json({ code: err.code, message: err.message }, err.httpStatus)
}
