/**
 * Cache key encoding per `design-cache.md` Q1.
 *
 * Format: colon-separated `{domain}:{op}:{id?}:{dim1}:{dim2}...`
 *
 * Components are encoded via `encodeRefName` from `hash.ts` —
 * slashes become dots, dots in input throw. Same encoding as
 * sidecar filenames; reusing keeps page names like `blog/[slug]`
 * round-trip-safe across both surfaces.
 *
 * Cut 1 ships the basic encoder. Cut 3 wraps with the Gazetta
 * major-version prefix and the 255-char overflow-hash policy
 * (consumer keeps clean keys; provider stores capped form).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns key encoding. Cut 3's policy layer
 *     (version prefix, overflow-hash) wraps but doesn't replace.
 *   - DIP: consumers call `encodeCacheKey(parts)`; the encoding
 *     mechanism is internal.
 */
import { encodeRefName } from '../hash.js'

/**
 * Encode an array of components into a colon-separated cache key.
 *
 * Each component is passed through `encodeRefName`:
 *   - `/` becomes `.` (path-style components round-trip)
 *   - `.` in input throws (dot is reserved for the slash encoding)
 *
 * Examples:
 *   encodeCacheKey(['pages', 'detail', 'home']) → 'pages:detail:home'
 *   encodeCacheKey(['pages', 'detail', 'blog/[slug]']) → 'pages:detail:blog.[slug]'
 *   encodeCacheKey(['pages', 'has.dot']) throws
 */
export function encodeCacheKey(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new Error('encodeCacheKey requires at least one component')
  }
  return parts.map(encodeRefName).join(':')
}

/**
 * Extract the prefix portion of a key for `invalidatePrefix()`
 * convenience. Returns the first N components joined by `:`.
 *
 * Examples:
 *   prefixOf('pages:detail:home', 1) → 'pages:'
 *   prefixOf('pages:detail:home', 2) → 'pages:detail:'
 *
 * The trailing colon is included so prefix matches don't accidentally
 * include `pagesx:...` style siblings — `'pages:'` matches `'pages:detail:home'`
 * but not `'pages-archived:home'`.
 */
export function prefixOf(key: string, components: number): string {
  if (components <= 0) {
    throw new Error('prefixOf requires components >= 1')
  }
  const parts = key.split(':')
  if (components >= parts.length) {
    return `${key}:`
  }
  return `${parts.slice(0, components).join(':')}:`
}
