/**
 * Zod schema helpers for asset references.
 *
 * Three helpers (`embeddedAsset`, `downloadable`, `fontAsset`), each emitting
 * a Zod object schema branded with its asset kind via `.brand()`. The brand
 * is phantom (type-level only) — runtime consumers see a plain Zod object.
 *
 * Shared grammar:
 * - `AcceptFilter` — the filter used by picker UIs to narrow the set of
 *   assets offered for a field. Kind names (`'image'`, `'video'`, `'audio'`,
 *   `'document'`, `'font'`, `'other'`), MIME prefixes (`'image/'`), or exact
 *   MIMEs (`'image/svg+xml'`). Shared because all three helpers accept it.
 *
 * Brand values — consumed by `Content<T>` in types.ts:
 * - `embeddedAsset()` → `.brand<'embedded'>()`
 * - `downloadable()` → `.brand<'downloadable'>()`
 * - `fontAsset()` → `.brand<'font'>()`
 */
import { z } from 'zod'

/**
 * Acceptance filter — passed to picker UIs to narrow which assets are offered.
 * Shared across all three helpers.
 */
export type AcceptFilter =
  // Kind names
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'font'
  | 'other'
  // MIME prefix (ends with `/`)
  | `${string}/`
  // Exact MIME (contains `/`, no wildcard)
  | `${string}/${string}`

// ---------- embeddedAsset ----------

export interface EmbeddedAssetOptions {
  /** Which assets the picker should offer. Default: any embedded kind (image, video, audio). */
  accept?: AcceptFilter[]
  /** Show per-reference alt override UI. Default: true for images, false otherwise. */
  altOverride?: boolean
  /** Warn at save if alt is null on this reference. Default: false. */
  altRequired?: boolean
  /** Show per-reference focal-point override UI. Default: true for images. */
  focalPointOverride?: boolean
}

/**
 * Zod helper for an embedded asset reference — rendered inline by templates
 * (`<img>`, `<video>`, `<audio>`). Templates receive `ResolvedEmbeddedAsset`
 * after the resolver merges the manifest with per-reference overrides.
 */
export function embeddedAsset(options: EmbeddedAssetOptions = {}) {
  // Store options as a sibling metadata object — the picker reads them to
  // configure the UI. The Zod schema itself only validates the runtime shape.
  const base = z
    .object({
      _asset: z.string(),
      alt: z.string().optional(),
      focalPoint: z
        .object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
        })
        .optional(),
    })
    .brand<'embedded'>()

  // Attach options via .meta() so custom picker UIs can read them.
  return base.meta({ assetOptions: options })
}

// ---------- downloadable ----------

export interface DownloadableOptions {
  /** Which files the picker should offer. Default: any non-embedded kind. */
  accept?: AcceptFilter[]
  /** Show per-reference title override UI. Default: true. */
  titleOverride?: boolean
  /** Show per-reference description field. Default: true. */
  descriptionOverride?: boolean
}

/**
 * Zod helper for a downloadable asset reference — rendered as `<a href download>`
 * by templates. Templates receive `ResolvedDownloadableAsset`.
 */
export function downloadable(options: DownloadableOptions = {}) {
  const base = z
    .object({
      _asset: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .brand<'downloadable'>()

  return base.meta({ assetOptions: options })
}

// ---------- fontAsset ----------

export interface FontAssetOptions {
  /** Which font formats the picker should offer. Default: all supported. */
  accept?: ('woff2' | 'woff' | 'ttf' | 'otf')[]
  /** Expects a variable font (single file, axis-driven weights). Default: false. */
  variable?: boolean
}

/**
 * Zod helper for a font asset reference — templates emit `@font-face` declarations
 * from the resolved variants. Locale manifests add variants to the union rather than
 * overriding; the browser picks per character based on `unicode-range`.
 */
export function fontAsset(options: FontAssetOptions = {}) {
  const base = z
    .object({
      _asset: z.string(),
    })
    .brand<'font'>()

  return base.meta({ assetOptions: options })
}
