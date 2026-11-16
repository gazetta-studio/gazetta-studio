/**
 * Raster image types that may be inlined as `data:` URIs: the formats
 * `design-media.md` serves as images. `image/svg+xml` is deliberately absent:
 * an inline SVG would skip SVG sanitizing (design-content-trust.md Q2).
 * Shared by the content save check and the SVG sanitizer, so the two
 * allow-lists can't drift.
 */
export const SAFE_DATA_IMAGE_TYPES = ['png', 'jpeg', 'gif', 'webp', 'avif'] as const

const TYPES = SAFE_DATA_IMAGE_TYPES.join('|')

/** Regex source matching the start of a base64 `data:image/...` URI of a safe type. */
export const SAFE_DATA_IMAGE_BASE64_SOURCE = `data:image\\/(?:${TYPES});base64,`

const SAFE_DATA_IMAGE = new RegExp(`^data:image\\/(?:${TYPES})(?:;base64)?,`, 'i')

/** True when `uri` is a `data:` URI of a safe image type, base64 or percent-encoded. */
export function isSafeDataImage(uri: string): boolean {
  return SAFE_DATA_IMAGE.test(uri)
}
