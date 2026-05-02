/**
 * Format-specific upload preprocessing — the seam where formats register
 * "transform these bytes before storage."
 *
 * # Why
 *
 * Some formats need work between MIME-sniff and storage write:
 *
 *   - SVG: strip script tags, event handlers, external hrefs, and
 *     oversized embedded base64 (security + bloat — see svg-sanitize.ts)
 *   - HEIC: transcode to JPEG (browsers can't display HEIC) — future
 *   - Animated GIF: extract first frame as poster, set `animated`
 *     manifest flag — future
 *   - JPEG with EXIF: apply orientation, strip personal metadata — future
 *
 * Without an abstraction, every new format adds an `if (mime === '...')`
 * branch to `ingestAsset`. The hot path grows with each format; format-
 * specific code lives in the wrong place; tests for one format have
 * to stand up the whole ingest pipeline.
 *
 * # Contract
 *
 * `UploadPreprocessor` is the open extension seam:
 *   - `matches(mime)` → does this preprocessor apply?
 *   - `preprocess(bytes)` → return new bytes (and optional warnings)
 *
 * Each registered preprocessor handles one MIME (or a small family —
 * a future "EXIF" preprocessor might handle both `image/jpeg` and
 * `image/heic`). The registry is checked in order; the first matching
 * preprocessor runs and its output replaces the buffer.
 *
 * # SOLID lenses
 *
 *   - SRP: each preprocessor module owns one format's preprocessing
 *   - OCP: adding a format = new module + register; ingest unchanged
 *   - LSP: every preprocessor honors the same contract — return bytes
 *     or throw `AssetPreprocessError`
 *   - ISP: callers (ingest) depend on `runPreprocessors`, not on the
 *     individual format modules
 *   - DIP: ingest depends on the abstraction; format modules implement
 *     it. SVG-specific knowledge lives in `preprocess-svg.ts`.
 *
 * # v1 scope
 *
 * Today's only registered preprocessor is SVG. The default registry
 * (`defaultPreprocessors`) is what `ingestAsset` uses out of the box;
 * tests can construct an empty registry to bypass preprocessing.
 */
import { AssetPreprocessError } from './errors.js'
import { svgPreprocessor } from './preprocess-svg.js'

/**
 * Non-fatal observations about how the bytes were transformed. Today
 * SVG can warn about large embedded base64; future preprocessors may
 * surface "EXIF orientation applied", "metadata stripped", etc.
 *
 * Open shape — preprocessors define their own warning codes via the
 * union of all registered preprocessors. Today only SVG warnings.
 */
export type PreprocessWarning =
  | { code: 'svg-stripped-element'; tag: string }
  | { code: 'svg-stripped-attribute'; attr: string; on: string }
  | { code: 'svg-large-base64'; sizeBytes: number; threshold: number }

export interface PreprocessResult {
  /** Bytes after preprocessing — may be the same reference when no transform applied. */
  bytes: Uint8Array
  /** Format-specific non-fatal warnings. Empty when nothing to flag. */
  warnings: readonly PreprocessWarning[]
}

/**
 * One format's preprocessing contract. Implementations are pure
 * (no I/O, no storage, no history) so they're trivially testable.
 */
export interface UploadPreprocessor {
  /** Stable identifier for diagnostics (`'svg'`, `'heic'`, etc.). */
  readonly name: string
  /** Whether this preprocessor applies to the given MIME. */
  matches(mime: string | null): boolean
  /**
   * Transform the bytes. Return new bytes (may be the same reference
   * if no transformation is needed) plus any warnings. Throw
   * `AssetPreprocessError` for unrecoverable input problems.
   */
  preprocess(bytes: Uint8Array): PreprocessResult | Promise<PreprocessResult>
}

/**
 * The default registry — what ingest uses out of the box. Order
 * matters when more than one preprocessor matches; today only one
 * preprocessor matches any given MIME.
 *
 * Adding a new format-specific preprocessor: implement
 * `UploadPreprocessor`, append it here. Ingest needs no edits.
 */
export const defaultPreprocessors: readonly UploadPreprocessor[] = [svgPreprocessor]

/**
 * Run the matching preprocessor for the given MIME. Returns the
 * (possibly-transformed) bytes + any warnings; pass through unchanged
 * when no preprocessor matches.
 *
 * Thrown errors propagate. Preprocessors throw `AssetPreprocessError`
 * for client-correctable input problems; other thrown errors (e.g.
 * out-of-memory during a large transform) bubble as-is.
 */
export async function runPreprocessors(
  bytes: Uint8Array,
  mime: string | null,
  preprocessors: readonly UploadPreprocessor[] = defaultPreprocessors,
): Promise<PreprocessResult> {
  for (const p of preprocessors) {
    if (p.matches(mime)) {
      try {
        return await p.preprocess(bytes)
      } catch (err) {
        if (err instanceof AssetPreprocessError) throw err
        // Wrap unexpected errors so the caller always sees a typed
        // surface for preprocessing failures.
        throw new AssetPreprocessError(p.name, 'unexpected', err)
      }
    }
  }
  return { bytes, warnings: [] }
}
