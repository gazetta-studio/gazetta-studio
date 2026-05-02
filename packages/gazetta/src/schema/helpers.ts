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

// ---------- accept-filter matching ----------

/**
 * Map a MIME's top-level type to its picker `AcceptFilter` kind name.
 * `image/jpeg` → `image`, `application/pdf` → `document`, etc.
 *
 * The asset-kind taxonomy (`image | video | audio | document | font |
 * other`) is defined by design-media.md; this maps the IANA top-level
 * type into that vocabulary. Anything not in the table maps to `'other'`
 * — the picker can still accept these via MIME prefix or exact MIME.
 *
 * `kind` is the asset's manifest kind (`embedded | downloadable | font`),
 * which discriminates rendering contract — separate axis from this
 * MIME-derived category. Both inform `matchesAccept`.
 */
export function mimeToAcceptKind(mime: string): AcceptFilter {
  const slash = mime.indexOf('/')
  const top = slash === -1 ? mime : mime.slice(0, slash)
  switch (top) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'application':
    case 'text':
      return 'document'
    case 'font':
      return 'font'
    default:
      return 'other'
  }
}

/**
 * Does this asset satisfy any one of the picker's `accept` filters?
 *
 * Empty `accept` matches everything — that's "no filter configured."
 * Otherwise the asset matches if at least one filter entry holds:
 *   - kind name (`'image'`, `'video'`, ...) matches `mimeToAcceptKind`
 *   - MIME prefix (ends with `/`) is a prefix of the asset's MIME
 *   - exact MIME equals the asset's MIME
 *
 * Pure, side-effect-free — picker UIs use it to filter the grid; the
 * resolver could use it to validate refs at render time.
 */
export function matchesAccept(asset: { mime: string }, accept: readonly AcceptFilter[]): boolean {
  if (accept.length === 0) return true
  const assetKind = mimeToAcceptKind(asset.mime)
  for (const filter of accept) {
    if (filter === assetKind) return true
    if (filter.endsWith('/')) {
      if (asset.mime.startsWith(filter)) return true
    } else if (filter.includes('/')) {
      if (asset.mime === filter) return true
    }
  }
  return false
}
