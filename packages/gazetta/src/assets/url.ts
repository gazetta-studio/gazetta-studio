/**
 * Asset URL construction — pure function from (siteUrl, asset manifest
 * fields, extension) to the URL the template emits.
 *
 * Kept separate from `resolve.ts` because:
 * - The resolver composes manifest I/O + URL construction + override merging.
 *   URL construction is the only piece that's purely computational.
 * - Future transform adapters (Cloudflare Images, imgproxy) build URLs too —
 *   they share the `{name}-{hash}.{ext}` origin-URL shape and wrap it. Having
 *   that builder in one place means adapters compose rather than duplicate.
 *
 * Output is root-relative when `siteUrl` is absent, absolute when present.
 * Root-relative works anywhere; absolute is needed for targets that live on
 * a different origin from the admin (CDN-split deployments).
 */

/** Path prefix (relative to storage root) where internal asset bytes live. */
export const ASSETS_URL_PREFIX = '/assets'

import { type Selector, selectorSuffix } from '../schema/dimensions.js'

export interface BuildAssetUrlInput {
  /** Asset name (the canonical identifier). */
  name: string
  /**
   * 8-char SHA-256 prefix of the bytes (matches the manifest `hash`).
   * For locale-bytes overrides this is the OVERRIDE's hash, distinct
   * from the default's hash.
   */
  hash: string
  /** File extension without the dot (e.g., `"jpg"`). */
  ext: string
  /**
   * Optional site URL — absolute URL prefix for targets served from a separate
   * origin (e.g., `"https://cdn.example.com"`). When absent, the returned URL
   * is root-relative.
   */
  siteUrl?: string
  /**
   * Optional selector — when set, builds the URL for a locale/theme override.
   * Path becomes `/assets/{name}-{hash}.{locale}[.{theme}].{ext}`. Null/omitted
   * = default-bytes URL.
   */
  selector?: Selector | null
}

/**
 * Construct the public URL for an internal asset. Path pattern is
 * `{ASSETS_URL_PREFIX}/{name}-{hash}[.{locale}][.{theme}].{ext}`, optionally
 * prefixed with `siteUrl`.
 *
 * Normalizes trailing slashes — `siteUrl: "https://cdn.example.com/"` and
 * `siteUrl: "https://cdn.example.com"` both produce the same URL.
 */
export function buildAssetUrl(input: BuildAssetUrlInput): string {
  const suffix = selectorSuffix(input.selector ?? null)
  const path = `${ASSETS_URL_PREFIX}/${input.name}-${input.hash}${suffix}.${input.ext}`
  if (!input.siteUrl) return path

  // Strip trailing slash from siteUrl before appending the root-relative path.
  const base = input.siteUrl.endsWith('/') ? input.siteUrl.slice(0, -1) : input.siteUrl
  return `${base}${path}`
}

/**
 * Construct the public URL for a variant whose filename is already
 * known (from the manifest's `variants[].path`). The filename is
 * already hash-encoded and width-suffixed at ingest time, so this
 * helper is just a prefix composer — keeps siteUrl normalization in
 * one place.
 */
export function buildVariantUrl(variantPath: string, siteUrl?: string): string {
  const path = `${ASSETS_URL_PREFIX}/${variantPath}`
  if (!siteUrl) return path
  const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl
  return `${base}${path}`
}

/**
 * Build the responsive `srcset` string from a manifest's variant list.
 * Each variant contributes one `<url> <width>w` descriptor; the browser
 * picks the best match for the viewport. Joined with `", "` per the
 * HTML `srcset` spec.
 *
 * Lives here (not in `resolve.ts`) because URL composition — including
 * this multi-variant flavor — is the `url.ts` module's single
 * responsibility. Future transform adapters (Cloudflare Images,
 * imgproxy) that build their own srcset ladders will compose this or
 * substitute their own from the same module.
 */
export function buildSrcset(variants: readonly { width: number; path: string }[], siteUrl?: string): string {
  return variants.map(v => `${buildVariantUrl(v.path, siteUrl)} ${v.width}w`).join(', ')
}

/**
 * Derive a file extension from a MIME type for the v1 allowlist.
 * Returns `null` for unknown MIMEs — callers should already have validated
 * MIME before reaching URL construction, so this is a defensive fallback.
 */
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
