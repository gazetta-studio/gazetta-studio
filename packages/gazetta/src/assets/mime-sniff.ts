/**
 * MIME sniffing from a byte stream — detect the type from magic bytes without
 * consuming the stream. The returned stream replays every byte of the input
 * (including the sample bytes used for detection); the detected MIME is
 * attached once sniffing completes.
 *
 * Wraps `file-type`'s `fileTypeStream`, which builds an internal sample
 * buffer (default 4100 bytes) without losing the originals.
 *
 * SVG specifically: `file-type` v22+ detects SVG as `application/xml` (not
 * the semantic `image/svg+xml`). Callers that want to treat SVG as an image
 * must map `application/xml` → `image/svg+xml` based on root-tag inspection
 * or extension. This module returns what `file-type` says — no semantic
 * re-interpretation.
 */
import { fileTypeStream } from 'file-type'

export interface MimeSniffResult {
  /** The stream, replaying all original bytes. */
  stream: ReadableStream<Uint8Array>
  /** Detected MIME (e.g. `"image/jpeg"`) or null when no magic-byte match. */
  mime: string | null
  /** Detected canonical extension (e.g. `"jpg"`) or null when no match. */
  ext: string | null
}

/**
 * Sniff the MIME type from the head of a stream, returning a pass-through
 * stream that carries the full byte sequence downstream.
 *
 * Returns `{ mime: null, ext: null }` on unknown magic bytes, empty streams,
 * or plain text that doesn't match any format. SVG is detected as
 * `application/xml` (see module docstring). Callers handle the null case —
 * this module doesn't throw.
 */
export async function sniffMimeFromStream(input: ReadableStream<Uint8Array>): Promise<MimeSniffResult> {
  const sniffed = await fileTypeStream(input)
  return {
    stream: sniffed as ReadableStream<Uint8Array>,
    mime: sniffed.fileType?.mime ?? null,
    ext: sniffed.fileType?.ext ?? null,
  }
}
