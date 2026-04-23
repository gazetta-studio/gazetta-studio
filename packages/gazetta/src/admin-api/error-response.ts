/**
 * Asset-error → HTTP response mapper.
 *
 * Every `AssetError` subclass owns two pieces of transport-boundary data:
 *   - `httpStatus` (the status code)
 *   - `toResponseBody()` (the JSON body — default `{ code, message }`,
 *     overridden by subclasses that carry structured data)
 *
 * The mapper is one line: delegate to the polymorphic method. No
 * `instanceof` chains, no special-casing by subclass. Adding a new
 * `AssetError` subclass with a new body shape means overriding
 * `toResponseBody()` on that subclass — the mapper stays unchanged.
 */
import type { Context } from 'hono'
import { AssetError } from '../assets/errors.js'

/**
 * Serialize an `AssetError` into a Hono JSON response. Returns `null`
 * when the error is not an `AssetError` — the caller should rethrow so
 * the framework's default handler can produce a 500.
 */
export function respondWithAssetError(c: Context, err: unknown): Response | null {
  if (!(err instanceof AssetError)) return null
  return c.json(err.toResponseBody(), err.httpStatus)
}
