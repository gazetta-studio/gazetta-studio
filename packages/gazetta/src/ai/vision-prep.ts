/**
 * Image preprocessing for vision-using AI tasks.
 *
 * # Single responsibility
 *
 * Take raw asset bytes; return bytes suitable for sending to a vision
 * provider. Concretely:
 *
 *   - Resize to `MAX_EDGE` long-edge (default 768) preserving aspect ratio
 *   - Re-encode to JPEG (or PNG if alpha) post-resize
 *   - Rasterize SVG to PNG at MAX_EDGE
 *   - Pass through if already small (no needless re-encode)
 *   - Use the analyzer-extracted poster bytes for animated images
 *
 * No knowledge of providers, prompts, refusal, or task-specific config.
 *
 * # Why 768
 *
 * Smallest size that fits all v1.5 providers natively without quality
 * loss:
 *
 *   - Ollama llama3.2-vision native input is 1120×1120
 *   - Anthropic Claude (non-Opus) recommended max long edge is 1568
 *   - OpenAI gpt-4o "high detail" mode targets 768 as the short-edge
 *     value when tiling 512×512 — chosen by OpenAI as the size where
 *     in-image text remains legible
 *
 * 768 sits below all three ceilings, makes OpenAI tile to exactly
 * 4 tiles + base = 765 tokens, and produces predictable cost on
 * Anthropic (~786 tokens for a 768×768 image, well under the 1568
 * token ceiling).
 *
 * Going lower (e.g., 512) hits OpenAI's "low detail" tier which the
 * provider's own docs mark as worse for in-image text. Going higher
 * exceeds Ollama's native input so the model downsamples internally
 * — we'd be paying upload bandwidth for bytes that get discarded.
 *
 * # Per-task override
 *
 * Vision tasks that need different sizing (e.g., a future tag-suggestion
 * task on detailed product shots wanting 1024) pass `maxEdge` per call.
 * `MAX_EDGE` is the default; `prepareForVision` accepts an override.
 *
 * # Animated images
 *
 * The animated-image analyzer (shipped in media v1) extracts a
 * first-frame PNG poster as a supplementary file. Suggester callers
 * pass those bytes via `posterBytes` — `prepareForVision` skips its
 * own rasterization and uses the poster directly. Cross-feature reuse
 * over duplication.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "raw asset bytes → vision-call bytes"
 *   - OCP: a future `pdf-prep.ts` peer handles document tasks the same way
 *   - DIP: callers depend on `prepareForVision`, not on sharp directly
 */
import sharp from 'sharp'

/** Default long-edge cap. Per-call override available via `maxEdge`. */
export const MAX_EDGE = 768

export interface PrepareInput {
  /** Source bytes (raw asset bytes, post-preprocess). */
  bytes: Uint8Array
  /** Source MIME type from the asset manifest. */
  mime: string
  /**
   * For animated images, the analyzer's extracted first-frame poster
   * bytes (always PNG). When provided, used directly — no further
   * rasterization. Skip for static images.
   */
  posterBytes?: Uint8Array
  /** Long-edge cap override; defaults to {@link MAX_EDGE}. */
  maxEdge?: number
}

export interface PreparedImage {
  /** Bytes ready to send to a vision provider. */
  bytes: Uint8Array
  /** MIME of the prepared bytes — `image/jpeg` or `image/png`. */
  mime: string
}

/**
 * SVG rasterization density. 144 dpi is a sensible doubled-72-dpi
 * default that produces ~2x the nominal SVG dimensions. Combined with
 * the resize step, the final output is bounded by `maxEdge` regardless
 * of the SVG's intrinsic size — density only affects rendering quality
 * before the cap kicks in.
 */
const SVG_DENSITY = 144

/**
 * Prepare image bytes for a vision-call. Single async call that picks
 * the right code path based on input.
 *
 * Throws on hard failures (corrupt source bytes that sharp can't
 * decode, even past metadata). Callers wrap in their adapter's error
 * taxonomy.
 */
export async function prepareForVision(input: PrepareInput): Promise<PreparedImage> {
  const maxEdge = input.maxEdge ?? MAX_EDGE

  // Animated source: use the pre-extracted poster bytes (always PNG).
  // Posters are extracted at upload time and already represent the
  // first frame; for vision-call purposes that's what we want.
  if (input.posterBytes) {
    return { bytes: input.posterBytes, mime: 'image/png' }
  }

  // SVG: rasterize to PNG at the cap. Vector input has no intrinsic
  // pixel size; we pick density × resize to bound the output.
  if (input.mime === 'image/svg+xml') {
    const buf = await sharp(input.bytes, { density: SVG_DENSITY })
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside' })
      .png()
      .toBuffer()
    return { bytes: new Uint8Array(buf), mime: 'image/png' }
  }

  // Raster: resize if larger than maxEdge on long edge; otherwise pass
  // through. Avoids a no-op JPEG-of-JPEG re-encode that would lose
  // quality without saving bandwidth.
  const meta = await sharp(input.bytes).metadata()
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0)
  if (longEdge > 0 && longEdge <= maxEdge) {
    return { bytes: input.bytes, mime: input.mime }
  }

  // Preserve PNG when source has alpha (logos with transparency lose
  // semantically when flattened to JPEG). Otherwise JPEG quality 85 —
  // sharp's default for `.jpeg()`, well-balanced for AI input.
  const hasAlpha = meta.hasAlpha === true
  const pipeline = sharp(input.bytes).resize({ width: maxEdge, height: maxEdge, fit: 'inside' })
  const buf = hasAlpha ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 85 }).toBuffer()
  return {
    bytes: new Uint8Array(buf),
    mime: hasAlpha ? 'image/png' : 'image/jpeg',
  }
}
