/**
 * Save-concurrency etag — a content hash used by the save endpoints
 * to detect stale writes. Different from the publish-state hash in
 * `hash.ts`:
 *
 *   `.{8hex}.hash` (publish-state, MD5)
 *     - Substitutes template + fragment hashes into the manifest
 *     - Drives sidecars, compare, cache invalidation
 *     - Server-only: requires `templateHashes` and `fragmentHashes`
 *       maps that the client doesn't have
 *
 *   save etag (this module, SHA-256, 16 hex)
 *     - Pure manifest content; no template/fragment substitution
 *     - Drives `If-Match` save concurrency per `design-offline.md` Q3
 *     - Computable identically by client + server (same canonicalization,
 *       same Web Crypto API)
 *
 * # Why two etags
 *
 * Save concurrency asks: "did THIS page's manifest change between
 * my read and my write?" A template change doesn't dirty individual
 * pages from the author's perspective — the author edits page X;
 * if a colleague separately edits the template, that's a render
 * concern, not a save-conflict concern. Mixing the two would force
 * 409 STALE on every author after a template edit, which is wrong UX.
 *
 * The `.{8hex}.hash` etag legitimately includes template/fragment
 * dependencies because IT drives publish + cache invalidation, where
 * the question IS "did anything in the dep tree change."
 *
 * Two etags, two semantics, two consumers. Locked per `design-offline.md`
 * Cut 9 grilling.
 *
 * # Why SHA-256 truncated to 16 hex (not MD5 truncated to 8)
 *
 * Save etags collide more often than publish hashes — every save is
 * a new etag candidate; many saves per page over a long offline
 * session. A collision = silent stale-write (false negative on
 * conflict). 8 hex MD5 = 4B keyspace; tens of thousands of saves
 * across thousands of pages would hit the birthday bound. 16 hex
 * SHA-256 = 18.4 quintillion keyspace; collisions are not a
 * realistic concern. Cost: 8 extra characters in the ETag header.
 *
 * # Client + server parity contract
 *
 * Both call `computeSaveEtag(manifest)` and MUST produce identical
 * output. Canonicalization rules:
 *
 *   1. Pick fields: `template`, `content`, `components`, `metadata`,
 *      `route`. Other fields ignored (sidecars, derived state, etc.).
 *   2. JSON.stringify with sorted keys via the existing
 *      `sortedReplacer` (deep recursive object-key sort).
 *   3. SHA-256 via `globalThis.crypto.subtle.digest('SHA-256', bytes)`
 *      (Web Crypto; works in Node 18+ and all browsers).
 *   4. Take first 8 bytes (16 hex characters).
 */

/**
 * Manifest fields that participate in the save etag.
 *
 * Archive fields (per `design-soft-delete.md` Q1) are part of the etag
 * because archive transitions are saves the concurrency model must
 * detect: if author A archives page X while author B is editing it,
 * B's next save must 409-STALE rather than silently overwrite A's
 * archive. Same logic for `aliasOf` flatten cascades and unarchive.
 */
const SAVE_ETAG_FIELDS = [
  'template',
  'content',
  'components',
  'metadata',
  'route',
  'archived',
  'archivedAt',
  'archivedBy',
  'aliasOf',
] as const

/** Canonical JSON via sorted-key recursion. Same shape as the
 *  publish-hash module's sortedReplacer; duplicated here so this
 *  module is self-contained (see SRP note in the file header). */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = (value as Record<string, unknown>)[k]
    }
    return out
  }
  return value
}

/**
 * Compute the save etag for a page or fragment manifest. Returns 16
 * lowercase hex characters (first 8 bytes of SHA-256).
 *
 * Both client and server call this with the same manifest object;
 * both produce the same etag. Used for `ETag` response header on
 * GET and `If-Match` request header on PUT.
 *
 * Async because Web Crypto's `digest` is async. Callers in hot paths
 * (save handlers, contract tests) await once per save.
 */
export async function computeSaveEtag(manifest: Record<string, unknown>): Promise<string> {
  const picked: Record<string, unknown> = {}
  for (const field of SAVE_ETAG_FIELDS) {
    if (field in manifest) picked[field] = manifest[field]
  }
  const json = JSON.stringify(picked, sortedReplacer)
  const bytes = new TextEncoder().encode(json)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  // First 8 bytes = 16 hex characters.
  const view = new Uint8Array(digest, 0, 8)
  let out = ''
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0')
  }
  return out
}
