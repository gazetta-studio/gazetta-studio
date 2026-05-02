/**
 * SVG upload preprocessor — adapts `sanitizeSvg` to the
 * `UploadPreprocessor` contract.
 *
 * SRP: this module owns the SVG-specific decisions for the preprocess
 * pipeline (which MIMEs trigger it, how to wrap warnings, how to
 * translate sanitization errors). The actual sanitization rules
 * (DOMPurify config, base64 thresholds) live in `svg-sanitize.ts`
 * — that's the format-specific policy module.
 *
 * Adding a new preprocessor follows this exact shape: one module per
 * format, one matcher, one wrapper around the format's pure logic.
 */
import { AssetPreprocessError } from './errors.js'
import type { PreprocessResult, PreprocessWarning, UploadPreprocessor } from './preprocess.js'
import { sanitizeSvg, SvgSanitizeError, SVG_MIME_TYPE } from './svg-sanitize.js'

export const svgPreprocessor: UploadPreprocessor = {
  name: 'svg',
  matches(mime: string | null): boolean {
    return mime === SVG_MIME_TYPE
  },
  preprocess(bytes: Uint8Array): PreprocessResult {
    try {
      const result = sanitizeSvg(bytes)
      return {
        bytes: result.bytes,
        warnings: result.warnings.map(toPreprocessWarning),
      }
    } catch (err) {
      if (err instanceof SvgSanitizeError) {
        throw new AssetPreprocessError('svg', err.code, err)
      }
      // Other errors surface as-is; the registry wraps them into
      // AssetPreprocessError with reason='unexpected'.
      throw err
    }
  },
}

function toPreprocessWarning(w: ReturnType<typeof sanitizeSvg>['warnings'][number]): PreprocessWarning {
  switch (w.code) {
    case 'large-base64':
      return { code: 'svg-large-base64', sizeBytes: w.sizeBytes, threshold: w.threshold }
    case 'stripped-element':
      return { code: 'svg-stripped-element', tag: w.tag }
    case 'stripped-attribute':
      return { code: 'svg-stripped-attribute', attr: w.attr, on: w.on }
  }
}
