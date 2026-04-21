/**
 * Image metadata extraction — wraps sharp's `.metadata()` to get width +
 * height from bytes without decoding the full image. Read-only, no transform,
 * no resize.
 *
 * Step 4 will add a sibling transform module (variants via sharp's
 * `.resize()` + `.toFormat()`) that shares the sharp dependency. This file
 * stays focused on "describe the image" — a reason to change independent of
 * variant generation.
 *
 * sharp is an Apache-2.0 Node binding over libvips. See
 * design-media-reference.md → Library and tooling specifics.
 */
import sharp from 'sharp'

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Extract dimensions from an image buffer. Returns `null` when sharp
 * can't parse the bytes (unsupported format, corrupt, or non-image MIME
 * that slipped past sniffing).
 */
export async function extractImageDimensions(bytes: Uint8Array): Promise<ImageDimensions | null> {
  try {
    const meta = await sharp(bytes).metadata()
    if (typeof meta.width !== 'number' || typeof meta.height !== 'number') return null
    return { width: meta.width, height: meta.height }
  } catch {
    return null
  }
}
