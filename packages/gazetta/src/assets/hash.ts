/**
 * Content-addressing hash for asset bytes.
 *
 * Uses **SHA-256**, 8-character hex prefix — the canonical asset-URL hash for
 * this codebase. Distinct from:
 * - `src/hash.ts` (MD5-based) used by publish-rendered sidecars
 * - Full SHA-256 used by history blob storage
 *
 * See design-media-reference.md "Codebase alignment verified → Two hash
 * algorithms coexist" for why asset work standardises on SHA-256 and doesn't
 * extend the legacy MD5 sidecar pattern.
 *
 * The streaming helper (`hashStream`) consumes the passed stream. Callers
 * that need both the hash AND the original bytes must tee the stream first.
 */
import { createHash } from 'node:crypto'

/** Length of the hex prefix embedded in asset URLs. Matches the doc's `{hash8}`. */
export const ASSET_HASH_LENGTH = 8

/** Hash a complete byte buffer — convenience wrapper for tests and small payloads. */
export function hashBytes(bytes: Uint8Array): string {
  const full = createHash('sha256').update(bytes).digest('hex')
  return full.slice(0, ASSET_HASH_LENGTH)
}

/**
 * Hash a byte stream as it flows through. Consumes the stream. Returns the
 * 8-char hex prefix once the stream ends.
 *
 * For upload pipelines that need to both hash and persist bytes, tee the
 * source stream and pass one branch here, the other to storage.
 */
export async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const digest = createHash('sha256')
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) digest.update(value)
  }
  return digest.digest('hex').slice(0, ASSET_HASH_LENGTH)
}
