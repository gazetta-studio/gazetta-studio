/**
 * Asset-specific API surface.
 *
 * Separated from `client.ts` (the general CRUD API) because the asset
 * endpoints have concerns the general surface does not:
 *   - multipart/form-data uploads (not JSON)
 *   - typed error codes (`ASSET_*`) rather than the `{ error }` wrapper
 *   - a 409 response that carries structured usage data the caller must
 *     pattern-match on, not a generic "request failed"
 *
 * Typed errors and the `AssetRef` shape come from
 * `gazetta/admin-api/schemas` — the same classes the server throws. No
 * parallel client-only copies: an `instanceof AssetInUseError` check
 * works identically whether the thrower is this file (after parsing a
 * 409 body) or the server (in tests that reach directly into handlers).
 */
import { AssetInUseError, type AssetInUseResponse, type AssetRef } from 'gazetta/admin-api/schemas'
import type { AssetSummary } from 'gazetta/schema'
import { apiUrl, authHeaders } from './_request.js'

export { AssetInUseError }
export type { AssetRef }

/** Response payload from a successful asset upload. */
export interface UploadedAsset {
  manifest: AssetSummary & { version: 1; source: 'internal'; uploadedBy: string }
  bytesPath: string
}

/**
 * Thrown on any non-success asset response other than the structured
 * 409 (handled via `AssetInUseError`). `code` is the server's typed
 * error code (`ASSET_MANIFEST_NOT_FOUND`, etc.) when present; `status`
 * is the HTTP status for callers that need to branch on "missing vs
 * storage failure." This is client-transport-specific — the server
 * never throws this; it throws a specific `AssetError` subclass.
 */
export class AssetApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
  ) {
    super(message)
    this.name = 'AssetApiError'
  }
}

/**
 * Upload an asset. On success returns the new asset's manifest + bytes path.
 * On validation failure (bad MIME, reserved name, etc.) throws
 * `AssetApiError` with `status: 400` and the typed `code`.
 */
export async function uploadAsset(file: File, name: string, alt: string | null): Promise<UploadedAsset> {
  const form = new FormData()
  form.set('file', file)
  form.set('name', name)
  if (alt !== null) form.set('alt', alt)

  const res = await fetch(apiUrl('/assets'), {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (res.ok) return (await res.json()) as UploadedAsset
  throw await parseAssetError(res, 'Upload failed')
}

/**
 * Delete an asset. Resolves on 204 (success). Throws `AssetInUseError`
 * on 409 (refs still exist). Throws `AssetApiError` on any other failure.
 */
export async function deleteAsset(name: string): Promise<void> {
  const res = await fetch(apiUrl(`/assets/${encodeURIComponent(name)}`), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (res.status === 204) return
  if (res.status === 409) throw await parseInUseResponse(res, name)
  throw await parseAssetError(res, 'Delete failed')
}

/** Read a 409 response body and return a typed `AssetInUseError`. */
async function parseInUseResponse(res: Response, fallbackName: string): Promise<AssetInUseError> {
  const body = (await res.json().catch(() => ({}))) as Partial<AssetInUseResponse>
  return new AssetInUseError(body.assetName ?? fallbackName, body.refs ?? [])
}

/** Read a non-success, non-409 response body and return a typed `AssetApiError`. */
async function parseAssetError(res: Response, fallbackPrefix: string): Promise<AssetApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    code?: string
    message?: string
  }
  return new AssetApiError(body.message ?? `${fallbackPrefix}: ${res.status}`, res.status, body.code)
}
