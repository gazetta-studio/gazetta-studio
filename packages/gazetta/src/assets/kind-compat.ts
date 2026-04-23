/**
 * Asset-kind compatibility for replace operations.
 *
 * Per design-media.md → Delete semantics:
 *   "Replace compatibility: same kind (embedded ↔ embedded,
 *    downloadable ↔ downloadable). Within embedded, cross-subtype is
 *    blocked (image ≠ video). Same kind + different MIME is allowed
 *    (JPEG → PNG, PDF → DOCX)."
 *
 * Single responsibility: decide "can asset B replace asset A?" — pure,
 * no I/O. Callers (replace, future rename) use this to validate
 * compatibility before rewriting refs.
 */
import type { AssetManifest } from '../schema/types.js'

/**
 * The coarse MIME category used for compatibility within `embedded`.
 * We're not asking "same MIME" (PNG → JPEG is fine); we're asking
 * "same rendering contract" (image tags can't swap with video tags).
 */
export function mimeCategory(mime: string): string {
  // "image/jpeg" → "image"; "video/mp4" → "video"; "application/pdf" → "application"
  const slash = mime.indexOf('/')
  return slash === -1 ? mime : mime.slice(0, slash)
}

export interface CompatCheck {
  readonly compatible: boolean
  readonly oldKind: string
  readonly oldMimeCategory: string
  readonly newKind: string
  readonly newMimeCategory: string
}

/**
 * Is `newAsset` a valid replacement for `oldAsset`? Returns a result
 * object either way — callers can branch on `compatible` and pass the
 * detail fields into the typed error when it's false.
 */
export function checkKindCompat(oldAsset: AssetManifest, newAsset: AssetManifest): CompatCheck {
  const oldCat = mimeCategory(oldAsset.mime)
  const newCat = mimeCategory(newAsset.mime)
  // Compatible when kind matches AND mime-category matches. The MIME
  // check is only meaningful within `embedded` (that's where the
  // image/video/audio distinction lives), but applying it to
  // `downloadable` and `font` is harmless — all PDFs share the
  // "application" category, all fonts share "font", etc.
  const compatible = oldAsset.kind === newAsset.kind && oldCat === newCat
  return {
    compatible,
    oldKind: oldAsset.kind,
    oldMimeCategory: oldCat,
    newKind: newAsset.kind,
    newMimeCategory: newCat,
  }
}
