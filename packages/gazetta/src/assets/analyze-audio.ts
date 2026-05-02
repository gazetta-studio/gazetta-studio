/**
 * Audio analyzer — extracts duration via the `music-metadata` library.
 *
 * Single responsibility: read audio bytes, return manifest enrichment
 * (`duration` in milliseconds; null when the format technically
 * supports duration but the value couldn't be derived from headers).
 *
 * Design notes (per design-media.md):
 *   - Personal-metadata stripping is documented as the default for
 *     audio, with opt-in preservation. The analyzer reads metadata
 *     non-destructively here; stripping is a *byte-transform* concern
 *     (preprocessor surface, not analyzer). Wiring an
 *     `audioMetadataPreprocessor` is a v1.5 follow-up — the analyzer
 *     reading duration doesn't preclude future stripping.
 *   - No supplementary files in v1. Future waveform-image extraction
 *     would slot in here (`supplementaryFiles: [{ path: ...waveform.svg }]`).
 *   - Format-specific MIME match: MP3, WAV, FLAC, Opus, AAC, M4A, OGG.
 *     `music-metadata` v11+ handles all of these natively.
 *
 * SOLID lenses:
 *   - SRP: this module owns "audio bytes → duration"
 *   - OCP: adding waveform extraction = same module gains a
 *     supplementary-file output; no other module changes
 *   - LSP: honors the `UploadAnalyzer` contract — match + analyze
 *   - ISP / DIP: ingest depends on `runAnalyzers`, not on this module
 */
import { parseBuffer } from 'music-metadata'
import type { AnalyzerInput, AnalysisResult, UploadAnalyzer } from './analyze.js'

/**
 * MIMEs the audio analyzer matches. Mirrors the v1 audio allowlist
 * documented in design-media.md. Adding a new audio MIME here +
 * `ALLOWED_MIMES` admits it; no other code changes.
 */
const AUDIO_MIMES = new Set([
  'audio/mpeg', // MP3
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'audio/aac',
  'audio/mp4', // M4A
  'audio/x-m4a',
])

export const audioAnalyzer: UploadAnalyzer = {
  name: 'audio',
  matches(mime) {
    return !!mime && AUDIO_MIMES.has(mime)
  },
  async analyze(input: AnalyzerInput): Promise<AnalysisResult> {
    let durationSec: number | undefined
    try {
      // music-metadata accepts a Buffer or Uint8Array; we already have
      // the bytes from the preprocess pass.
      const meta = await parseBuffer(
        input.bytes,
        { mimeType: input.mime, size: input.bytes.byteLength },
        {
          skipPostHeaders: true,
        },
      )
      durationSec = typeof meta.format.duration === 'number' ? meta.format.duration : undefined
    } catch {
      // Malformed audio header — bail out with no enrichment. The
      // upload still succeeds (the user's bytes are valid as far as
      // MIME sniffing was concerned); we just couldn't extract a
      // duration. A future stricter mode could throw here.
      return {}
    }

    if (durationSec === undefined) {
      // Format supports duration in principle but we couldn't extract.
      // null distinguishes "not applicable" (static image, document)
      // from "applicable but unknown" (corrupt header, streaming OGG
      // without a length).
      return { manifestPatch: { duration: null } }
    }

    // music-metadata returns seconds; manifest stores milliseconds
    // (matching animated-image duration units, where sharp returns ms).
    const durationMs = Math.round(durationSec * 1000)
    return { manifestPatch: { duration: durationMs } }
  },
}
