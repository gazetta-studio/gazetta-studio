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
 * Keeping these in a dedicated module means `client.ts` stays a thin
 * JSON-CRUD surface, and asset-specific types (errors, responses) live
 * next to the code that speaks the asset protocol.
 *
 * Uploaded manifest / list-summary types still live in `gazetta/schema`
 * (authoritative shapes owned by the gazetta package). Error types
 * for delete live here because they're transport-specific — the server
 * has its own `AssetInUseError` with the same semantics but a richer
 * `Error` hierarchy that doesn't cross the package boundary.
 */
import type { AssetInUseResponse, AssetRef } from 'gazetta/admin-api/schemas'
import type { AssetSummary } from 'gazetta/schema'
import { apiUrl, authHeaders } from './_request.js'

export type { AssetRef } from 'gazetta/admin-api/schemas'

/** Response payload from a successful asset upload. */
export interface UploadedAsset {
  manifest: AssetSummary & { version: 1; source: 'internal'; uploadedBy: string }
  bytesPath: string
}

/**
 * Thrown when the server rejects a delete because refs still exist.
 * Carries the usage list so the dialog can render it without a second
 * fetch. Other delete failures use the generic `AssetApiError`.
 */
export class AssetInUseError extends Error {
  readonly code = 'ASSET_IN_USE' as const
  constructor(
    public readonly assetName: string,
    public readonly refs: readonly AssetRef[],
  ) {
    super(`Asset "${assetName}" is still referenced by ${refs.length} item(s)`)
    this.name = 'AssetInUseError'
  }
}

/**
 * Thrown on any non-success asset response other than 409. `code` is
 * the server's typed error code (`ASSET_MANIFEST_NOT_FOUND`, etc.)
 * when present; `status` is the HTTP status for callers that need to
 * branch on "missing vs storage failure."
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
