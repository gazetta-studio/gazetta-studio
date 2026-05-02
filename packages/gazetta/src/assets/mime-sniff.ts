/**
 * MIME sniffing from a byte stream — detect the type from magic bytes without
 * consuming the stream. The returned stream replays every byte of the input
 * (including the sample bytes used for detection); the detected MIME is
 * attached once sniffing completes.
 *
 * Wraps `file-type`'s `fileTypeStream`, which builds an internal sample
 * buffer (default 4100 bytes) without losing the originals.
 *
 * SVG handling: `file-type` v22+ detects SVG as `application/xml` (not the
 * semantic `image/svg+xml`) because SVG is XML by syntax — magic bytes
 * alone can't distinguish "SVG" from "any XML." This module promotes
 * detected XML to `image/svg+xml` when the root element is `<svg>`. The
 * promotion is conservative: malformed input that happens to start with
 * `<svg` but isn't valid SVG will fail later sanitization, not here.
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
 * or plain text that doesn't match any format. Callers handle the null
 * case — this module doesn't throw.
 */
export async function sniffMimeFromStream(input: ReadableStream<Uint8Array>): Promise<MimeSniffResult> {
  const sniffed = await fileTypeStream(input)
  let mime = sniffed.fileType?.mime ?? null
  let ext = sniffed.fileType?.ext ?? null

  // SVG promotion. file-type returns `application/xml` for any XML;
  // peek the head of the stream and check for `<svg` near the start.
  if (mime === 'application/xml' || mime === null) {
    const promoted = await tryPromoteSvg(sniffed as ReadableStream<Uint8Array>)
    if (promoted) {
      return { stream: promoted, mime: 'image/svg+xml', ext: 'svg' }
    }
  }

  return {
    stream: sniffed as ReadableStream<Uint8Array>,
    mime,
    ext,
  }
}

/**
 * Drain a stream into chunks, check if the head looks like SVG
 * (`<svg` near the start, optionally preceded by an XML prolog and/or
 * whitespace), and return a fresh replay stream when so. Returns
 * `null` when the input doesn't start with an `<svg>` root.
 */
async function tryPromoteSvg(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array> | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let head = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
      if (head.length < 512) {
        head += new TextDecoder('utf-8', { fatal: false }).decode(value).slice(0, 512 - head.length)
      }
    }
  }

  const looksSvg = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)
  if (!looksSvg) return null

  // Replay every byte we drained as a fresh stream.
  const flat = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    flat.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(flat)
      controller.close()
    },
  })
}
