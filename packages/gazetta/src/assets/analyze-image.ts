/**
 * Image analyzers — read final bytes, contribute manifest fields
 * (and a poster file for animated content). Two analyzers behind
 * the abstraction:
 *
 *   - `staticImageAnalyzer` — extracts width + height for any image
 *     MIME. Always runs. Animated images also produce dimensions
 *     (the canvas size); they get the same width/height treatment.
 *   - `animatedImageAnalyzer` — runs for formats that can carry
 *     animation (GIF, APNG, animated WebP, animated AVIF). Reads
 *     `pages` + `delay[]` from sharp's metadata, sets
 *     `animated/frames/duration`, extracts the first frame as a
 *     poster PNG.
 *
 * Both analyzers are sharp-backed. SVG bypasses (no analyzer matches
 * `image/svg+xml`) — sharp can metadata SVG via libvips, but the
 * sanitizer-modified bytes are what we want characterized, and the
 * existing inline `extractImageDimensions` already handles SVG dims
 * correctly inside ingest. Kept separate for now; SVG could move into
 * an analyzer when the dimension-extraction call site changes.
 */
import sharp from 'sharp'
import type { AnalyzerInput, AnalysisResult, UploadAnalyzer } from './analyze.js'

const ANIMATED_MIMES = new Set([
  'image/gif',
  'image/png', // APNG; sharp surfaces pages > 1 when animated
  'image/webp', // animated WebP
  'image/avif', // animated AVIF
])

/**
 * Static-image analyzer — width + height. Runs for any `image/*`
 * MIME except SVG (which has its own dimension path; libvips
 * sometimes mis-reports vector content).
 */
export const staticImageAnalyzer: UploadAnalyzer = {
  name: 'static-image',
  matches(mime) {
    return !!mime && mime.startsWith('image/') && mime !== 'image/svg+xml'
  },
  async analyze(input: AnalyzerInput): Promise<AnalysisResult> {
    try {
      const meta = await sharp(input.bytes).metadata()
      const width = typeof meta.width === 'number' ? meta.width : null
      const height = typeof meta.height === 'number' ? meta.height : null
      return { manifestPatch: { width, height } }
    } catch {
      // sharp couldn't decode — return null dims so downstream code
      // doesn't break. This isn't a hard error: a bad image will fail
      // variant generation later with a more specific message.
      return { manifestPatch: { width: null, height: null } }
    }
  },
}

/**
 * Animated-image analyzer — `pages > 1` detection, frame count,
 * duration sum, and first-frame poster extraction.
 *
 * Per design-media.md: animated images render as `<img>` in v1
 * (no `<video>` transcoding — that requires ffmpeg). The poster
 * is provided so future UI layers (lazy-load, video-style poster
 * fallback) can use it; v1 templates can also render the poster
 * for reduced-motion preferences.
 */
export const animatedImageAnalyzer: UploadAnalyzer = {
  name: 'animated-image',
  matches(mime) {
    return !!mime && ANIMATED_MIMES.has(mime)
  },
  async analyze(input: AnalyzerInput): Promise<AnalysisResult> {
    let pages: number | undefined
    let delays: number[] | undefined
    try {
      const meta = await sharp(input.bytes).metadata()
      pages = typeof meta.pages === 'number' ? meta.pages : undefined
      // sharp returns delay as `number[]` per frame in milliseconds when
      // animated (some encoders use 0 for "use default" — tolerate).
      delays = Array.isArray(meta.delay) ? meta.delay : undefined
    } catch {
      // sharp couldn't decode — bail out. Static-image analyzer will
      // also fail and we'll fall through with no manifest patch.
      return {}
    }

    // Static (single-frame) — nothing to contribute. The static
    // analyzer already sets width/height; this analyzer skips when
    // there's no animation to describe.
    if (!pages || pages <= 1) return {}

    // Animated. Compute total duration (sum of frame delays).
    const duration = delays ? delays.reduce((sum, d) => sum + d, 0) : null
    const frames = pages

    // Extract first frame as a PNG poster. PNG keeps alpha lossless;
    // for solid-frame GIFs the size penalty over JPEG is worth the
    // simplicity (no quality knob to tune at this layer).
    let posterBytes: Uint8Array
    try {
      const buf = await sharp(input.bytes, { page: 0 }).png().toBuffer()
      posterBytes = new Uint8Array(buf)
    } catch {
      // Poster extraction failed — return manifest fields without
      // poster. Better partial enrichment than zero enrichment.
      return {
        manifestPatch: { animated: true, frames, duration, poster: null },
      }
    }

    // Path is content-addressed alongside the source asset:
    // {name}-{hash}-poster.png. Same-pattern as the variant ladder so
    // delete/rename/path-enumeration logic finds them via filename
    // glob without special-casing.
    const posterPath = `${input.assetName}-${input.hash}-poster.png`

    return {
      manifestPatch: {
        animated: true,
        frames,
        duration,
        poster: posterPath,
      },
      supplementaryFiles: [{ path: posterPath, bytes: posterBytes }],
    }
  },
}
