/**
 * Client-side mirror of `src/assets/url.ts` for the admin UI. Tiny — builds
 * URLs the browser uses to render asset thumbnails. Duplicated (not imported
 * from gazetta/schema) because:
 * - The server's module would import Node-only dependencies (via the
 *   assets/ barrel). This is browser-only surface.
 * - The logic is two pure functions. Extracting to a shared package entry
 *   for two callers violates team-preferences rule #15 ("extract at 3+ callers").
 *
 * If a third caller appears, promote this + the server's copy into a tiny
 * shared module.
 */

/** Path prefix where the admin API serves internal asset bytes. */
export const ASSETS_URL_PREFIX = '/assets'

export interface BuildAssetUrlInput {
  name: string
  hash: string
  ext: string
  siteUrl?: string
}

export function buildAssetUrl(input: BuildAssetUrlInput): string {
  const path = `${ASSETS_URL_PREFIX}/${input.name}-${input.hash}.${input.ext}`
  if (!input.siteUrl) return path
  const base = input.siteUrl.endsWith('/') ? input.siteUrl.slice(0, -1) : input.siteUrl
  return `${base}${path}`
}

/** Derive a file extension from a MIME type for v1 (JPEG, PNG). */
export function extFromMime(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    default:
      return null
  }
}
