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
import {
  AssetInUseError,
  type AssetInUseResponse,
  AssetKindMismatchError,
  type AssetRef,
} from 'gazetta/admin-api/schemas'
import type { AssetSummary } from 'gazetta/schema'
import { apiUrl, authHeaders } from './_request.js'

export { AssetInUseError, AssetKindMismatchError }
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
class AssetApiError extends Error {
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

/**
 * Replace every reference to `oldName` with `newName` across the site,
 * then delete `oldName`. One history revision covers the whole op.
 *
 * On 409 distinguishes between two server-side AssetError subclasses:
 *   - `AssetKindMismatchError` — replacement kind/MIME incompatible
 *   - (no AssetInUseError here — replacement implies refs exist; we
 *      fix them, we don't refuse)
 */
export async function replaceAsset(oldName: string, newName: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/assets/${encodeURIComponent(oldName)}/replace-with/${encodeURIComponent(newName)}`),
    { method: 'POST', headers: authHeaders() },
  )
  if (res.status === 204) return
  if (res.status === 409) throw await parseKindMismatchResponse(res, oldName, newName)
  throw await parseAssetError(res, 'Replace failed')
}

/** Selector identifying which override (locale and/or theme) to write or remove. */
export interface AssetSelector {
  locale?: string
  theme?: string
}

function selectorQuery(selector: AssetSelector): string {
  const params = new URLSearchParams()
  if (selector.locale) params.set('locale', selector.locale)
  if (selector.theme) params.set('theme', selector.theme)
  return params.toString()
}

/**
 * Upload a per-locale (or per-theme) bytes override for an existing
 * asset. The default asset must already exist; the override's MIME
 * must share the same kind category as the default (jpeg→png ok,
 * image→pdf rejected with 409 AssetKindMismatchError).
 */
export async function uploadLocaleBytes(
  assetName: string,
  selector: AssetSelector,
  file: File,
): Promise<UploadedAsset> {
  const form = new FormData()
  form.set('file', file)
  const qs = selectorQuery(selector)
  const res = await fetch(apiUrl(`/assets/${encodeURIComponent(assetName)}/locale-bytes?${qs}`), {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (res.ok) return (await res.json()) as UploadedAsset
  if (res.status === 409) throw await parseKindMismatchResponse(res, assetName, assetName)
  throw await parseAssetError(res, 'Locale-bytes upload failed')
}

/**
 * Remove a per-locale (or per-theme) bytes override. The default asset
 * is unaffected; the locale falls back to default bytes.
 */
export async function removeLocaleOverride(assetName: string, selector: AssetSelector): Promise<void> {
  const qs = selectorQuery(selector)
  const res = await fetch(apiUrl(`/assets/${encodeURIComponent(assetName)}/locale-bytes?${qs}`), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (res.status === 204) return
  throw await parseAssetError(res, 'Override removal failed')
}

/**
 * Fetch a single asset's summary including override-locale/theme lists.
 * The detail pane uses this to render the locale section accurately
 * after upload/remove operations.
 */
export async function getAsset(name: string): Promise<AssetSummary> {
  const res = await fetch(apiUrl(`/assets/${encodeURIComponent(name)}`), {
    headers: authHeaders(),
  })
  if (res.ok) return (await res.json()) as AssetSummary
  throw await parseAssetError(res, 'Asset fetch failed')
}

/**
 * Patch shape for `updateAssetMetadata`. Each field is optional;
 * "absent in patch = unchanged" preserves three-state semantics.
 *
 * - omit `alt`              → no change
 * - `alt: "string"`         → meaningful description
 * - `alt: ""`               → decorative
 * - `alt: null`             → explicitly clear
 *
 * - omit `focalPoint`       → no change
 * - `focalPoint: { x, y }`  → set (0–1 normalized)
 * - `focalPoint: null`      → clear (manifest field becomes absent;
 *                              resolver falls back to center 0.5/0.5)
 */
export interface AssetMetadataPatch {
  alt?: string | null
  focalPoint?: { x: number; y: number } | null
}

/**
 * Update an asset's metadata (alt today; tags, focalPoint, title,
 * description as those land). Returns the updated summary.
 *
 * 200 → resolves with the new summary. 400/404/500 throw `AssetApiError`.
 */
export async function updateAssetMetadata(name: string, patch: AssetMetadataPatch): Promise<AssetSummary> {
  const res = await fetch(apiUrl(`/assets/${encodeURIComponent(name)}`), {
    method: 'PATCH',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.ok) {
    const body = (await res.json()) as { manifest: AssetSummary }
    return body.manifest
  }
  throw await parseAssetError(res, 'Asset metadata update failed')
}

/** Read a 409 response body and return a typed `AssetInUseError`. */
async function parseInUseResponse(res: Response, fallbackName: string): Promise<AssetInUseError> {
  const body = (await res.json().catch(() => ({}))) as Partial<AssetInUseResponse>
  return new AssetInUseError(body.assetName ?? fallbackName, body.refs ?? [])
}

/**
 * Read a 409 response body for the replace endpoint and return a typed
 * `AssetKindMismatchError`. The body includes the same structured
 * fields the server attached via `toResponseBody()` (oldKind,
 * oldMimeCategory, newKind, newMimeCategory).
 */
async function parseKindMismatchResponse(
  res: Response,
  _oldName: string,
  _newName: string,
): Promise<AssetKindMismatchError> {
  const body = (await res.json().catch(() => ({}))) as {
    oldKind?: string
    oldMimeCategory?: string
    newKind?: string
    newMimeCategory?: string
  }
  return new AssetKindMismatchError(
    body.oldKind ?? 'unknown',
    body.oldMimeCategory ?? 'unknown',
    body.newKind ?? 'unknown',
    body.newMimeCategory ?? 'unknown',
  )
}

/** Read a non-success, non-409 response body and return a typed `AssetApiError`. */
async function parseAssetError(res: Response, fallbackPrefix: string): Promise<AssetApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    code?: string
    message?: string
  }
  return new AssetApiError(body.message ?? `${fallbackPrefix}: ${res.status}`, res.status, body.code)
}

/**
 * Result shape for `suggestAlt`. Mirrors the server's
 * `SuggestAltResponseSchema`: text + structured refusal info.
 *
 * UI consumers branch on `refused` to decide whether to display the
 * suggestion or surface `refusalReason` (e.g., as a toast).
 */
export interface SuggestAltResult {
  text: string
  refused: boolean
  refusalReason: string | null
}

/**
 * Generate alt text for the named asset using the configured AI
 * adapter. The server fetches asset bytes from storage; the client
 * passes name + optional locale.
 *
 * `signal` aborts the in-flight request — used by the upload-list row
 * to cancel suggestions when the author starts typing alt manually
 * (author intent always wins).
 *
 * Returns a structured result on 200 (including refusals — refusal is
 * not an error). Throws `AssetApiError` on 400/404/502/503.
 */
export async function suggestAlt(name: string, locale?: string, signal?: AbortSignal): Promise<SuggestAltResult> {
  const params = new URLSearchParams()
  if (locale) params.set('locale', locale)
  const qs = params.toString() ? `?${params.toString()}` : ''
  const res = await fetch(apiUrl(`/assets/${encodeURIComponent(name)}/suggest-alt${qs}`), {
    method: 'POST',
    headers: authHeaders(),
    signal,
  })
  if (res.ok) return (await res.json()) as SuggestAltResult
  throw await parseAssetError(res, 'Alt-text suggestion failed')
}
