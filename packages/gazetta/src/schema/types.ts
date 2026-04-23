/**
 * Asset schema — reference and resolved type spaces, and the `Content<T>`
 * utility that walks a Zod-inferred content type and swaps reference types
 * for resolved types.
 *
 * Two distinct type spaces:
 * - **Reference shapes** — what's stored in page/fragment content JSON. The
 *   authoring model: "this content field points to asset X with this optional
 *   override." Small, stable.
 * - **Resolved shapes** — what templates receive at render time after the
 *   resolver merges manifest + reference overrides. Large, evolves as
 *   templates gain capabilities.
 *
 * Brands distinguish reference types from plain objects. `Content<T>` reads
 * the brand to perform the swap. Brands are phantom — attached at the type
 * level via `z.brand(...)` in `helpers.ts`, invisible at runtime.
 *
 * Branding is split across the two modules by role:
 * - `types.ts` (this file) owns the `Resolved*Asset` shapes and the
 *   `Content<T>` mapper that consumes brands.
 * - `helpers.ts` owns the `embeddedAsset()` / `downloadable()` / `fontAsset()`
 *   Zod schemas that attach brands to their inferred output.
 */

// ---------- Brand markers ----------
//
// Zod v4's `.brand<T>(value)` attaches the brand as a phantom property
// `[$brand]: { [value]: value }`. The inferred type for a branded object schema
// looks like `{ ...props } & BRAND<'embedded'>`. We use string literal brands
// ("embedded", "downloadable", "font") and read them via the inference below.

/** Embedded asset reference — stored in content JSON for image/video/audio fields. */
export interface EmbeddedAssetRef {
  /** Asset name (path-like, e.g. `"hero"` or `"products/shot"`). */
  _asset: string
  /** Per-reference alt override. When absent, falls back to asset manifest's alt. */
  alt?: string
  /** Per-reference focal-point override. Image assets only; 0–1 normalized. */
  focalPoint?: { x: number; y: number }
}

/** Downloadable asset reference — stored in content JSON for file-download fields. */
export interface DownloadableAssetRef {
  _asset: string
  /** Per-reference title override (the human-readable link label). */
  title?: string
  /** Optional blurb rendered next to the link. */
  description?: string
}

/** Font asset reference — stored in content JSON for @font-face fields. */
export interface FontAssetRef {
  _asset: string
}

// ---------- Manifest shape (what lives in storage) ----------

/**
 * A single responsive variant of an image asset. Pre-generated at
 * upload time; the resolver composes these into a `srcset` string.
 */
export interface AssetVariant {
  /** Target width in pixels. */
  width: number
  /** Path relative to the assets root, e.g. `hero-a3b2c1d4-800w.jpg`. */
  path: string
  /** On-disk size of the variant in bytes. */
  size: number
}

/**
 * Asset manifest — the JSON written to `{name}.asset.json` for each asset.
 * Storage shape, distinct from reference (content JSON) and resolved (template
 * render). v1 slice fields; wider fields (animated, poster, font-specific,
 * etc.) are added as those capabilities land.
 *
 * `version: 1` is the forward-compatibility lever for future changes.
 *
 * Deviation from design-media.md:
 *   The design specifies a `variantsStatus: 'generating' | 'complete' | 'failed'`
 *   tri-state alongside `variants`. We don't carry it in v1 because ingest
 *   is synchronous + rolls back on variant-generation failure — when a
 *   manifest exists, variants are always complete by invariant, so the
 *   status field would be dead weight. If we ever move to async generation
 *   (a separate step), the tri-state comes back and callers distinguish
 *   "variants still generating" from "variants failed" the design-doc way.
 */
export interface AssetManifest {
  version: 1
  /** Asset name (matches the library key and the reference `_asset`). */
  name: string
  /** Rendering role — determines how templates use this asset. */
  kind: 'embedded' | 'downloadable' | 'font'
  /** Whether bytes live on target (`internal`) or elsewhere. v1 slice: internal only. */
  source: 'internal'
  /** Canonical MIME type (sniffed from bytes at upload). */
  mime: string
  /** Size in bytes of the default representation. */
  size: number
  /** 8-char SHA-256 prefix of default bytes. Matches the on-disk filename suffix. */
  hash: string
  /** Width in pixels (images) — null when not applicable. */
  width: number | null
  /** Height in pixels (images) — null when not applicable. */
  height: number | null
  /**
   * Responsive-image variants, pre-generated at upload time. Empty for
   * non-image assets (downloadable, font) or images smaller than the
   * smallest target width (no point upscaling). Ordered ascending by width.
   */
  variants: readonly AssetVariant[]
  /** Alt text per the three-state model; null means "not set". */
  alt: string | null
  /** Upload timestamp (ISO 8601 UTC). */
  uploadedAt: string
  /** Author who uploaded; empty string when RBAC isn't configured. */
  uploadedBy: string
}

/**
 * Library-list summary — the compact projection of `AssetManifest` that
 * the library UI displays. Deliberately smaller than the full manifest:
 * `uploadedBy` is excluded (RBAC / audit concern, not UI concern), and
 * future manifest fields (variants, animated flag, etc.) are only added
 * here when the UI genuinely needs them.
 */
export interface AssetSummary {
  name: string
  kind: AssetManifest['kind']
  mime: string
  size: number
  hash: string
  width: number | null
  height: number | null
  alt: string | null
  uploadedAt: string
}

// ---------- Resolved shapes (what templates receive) ----------

/** Embedded asset after the resolver merges manifest + per-ref overrides. */
export interface ResolvedEmbeddedAsset {
  /** Absolute or root-relative URL. */
  url: string
  /** Responsive `srcset` string; null for external, SVG, animated, or when variants aren't generated. */
  srcset: string | null
  width: number | null
  height: number | null
  /** Duration in ms — video, audio, or animated image. Null otherwise. */
  duration: number | null
  /** True for GIF, APNG, animated WebP, animated AVIF. */
  animated: boolean
  /** First-frame URL for animated content; null for static. */
  poster: string | null
  /** Alt text — always a string. Empty string (`""`) means "intentionally decorative". */
  alt: string
  /** Normalized 0–1 focal point; null when not set. */
  focalPoint: { x: number; y: number } | null
  mime: string
}

/** Downloadable asset after the resolver merges manifest + per-ref overrides. */
export interface ResolvedDownloadableAsset {
  url: string
  title: string
  description: string | null
  size: number | null
  mime: string
}

/** Font asset — a union of locale variants, each rendered as a `@font-face` declaration. */
export interface ResolvedFontAsset {
  /**
   * Gazetta-stable CSS font-family name. Templates reference this in their
   * `font-family` declarations. NOT the font file's intrinsic family name —
   * Gazetta owns this identifier so multi-script fonts (e.g. Inter for Latin
   * + Noto Sans Arabic for Arabic) can share one logical family from the
   * template's perspective.
   */
  cssName: string
  variants: Array<{
    url: string
    format: 'woff2' | 'woff' | 'ttf' | 'otf'
    weight: number | 'variable'
    style: 'normal' | 'italic'
    /** Unicode range for multi-script fallback. Null means "no range restriction". */
    unicodeRange: string | null
    mime: string
  }>
}

// ---------- Brand detection for Content<T> ----------
//
// Zod v4's `.brand<'embedded'>()` produces a phantom intersection:
//   `{ _asset: string; alt?: string; ... } & $brand<'embedded'>`
// where `$brand<K>` is `{ [$brand]: { [K]: true } }` (imported below). If
// Zod v5 changes brand representation, update only this module.
import type { $brand } from 'zod/v4/core'

/** True when `T` carries the `embedded` brand. */
export type HasEmbeddedBrand<T> = T extends $brand<'embedded'> ? true : false

/** True when `T` carries the `downloadable` brand. */
export type HasDownloadableBrand<T> = T extends $brand<'downloadable'> ? true : false

/** True when `T` carries the `font` brand. */
export type HasFontBrand<T> = T extends $brand<'font'> ? true : false

// ---------- Content<T> — the type mapper ----------

/**
 * Walks a content type `T` (typically `z.infer<typeof schema>`) and swaps every
 * asset reference type for its resolved counterpart.
 *
 * Mapping rules:
 * - branded `embedded` → `ResolvedEmbeddedAsset`
 * - branded `downloadable` → `ResolvedDownloadableAsset`
 * - branded `font` → `ResolvedFontAsset`
 * - Array: `Content<T[]>` (recurse into element type)
 * - Object: recurse into each property, preserving optionality
 * - Primitive: unchanged
 *
 * Depends only on Zod's `$brand` symbol and the resolved types above. If Zod
 * v5 changes brand representation, update only the `Has*Brand` predicates;
 * the mapper body stays the same.
 */
export type Content<T> =
  HasEmbeddedBrand<T> extends true
    ? ResolvedEmbeddedAsset
    : HasDownloadableBrand<T> extends true
      ? ResolvedDownloadableAsset
      : HasFontBrand<T> extends true
        ? ResolvedFontAsset
        : T extends ReadonlyArray<infer U>
          ? ReadonlyArray<Content<U>>
          : T extends object
            ? { [K in keyof T]: Content<T[K]> }
            : T
