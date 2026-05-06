/**
 * Cache key encoding per `design-cache.md` Q1 + Gap 2.
 *
 * Two layers:
 *   1. Consumer-facing encoder (`encodeCacheKey`): colon-separated
 *      `{domain}:{op}:{id?}:{dim1}:{dim2}...` with components passed
 *      through `encodeRefName` (slashes → dots; dots in input throw).
 *      Same encoding as sidecar filenames; page names like
 *      `blog/[slug]` round-trip across both surfaces.
 *   2. Provider-internal policy (`applyKeyPolicy`): prepends the
 *      cache schema version and caps total length at 255 chars,
 *      replacing the overflow tail with an 8-char sha256 hash so
 *      prefix-invalidation still works when the prefix is below the
 *      cap. Consumers never see the policy-wrapped form.
 *
 * # SOLID lenses
 *
 *   - SRP: encoder owns "consumer key shape"; policy owns "what the
 *     provider stores." Two concerns, two functions.
 *   - DIP: consumers call `encodeCacheKey(parts)`; providers call
 *     `applyKeyPolicy(key)` internally before storing/looking up.
 *     Neither leaks the version-prefix mechanism to callers.
 *
 * # Schema versioning
 *
 * `CACHE_SCHEMA_VERSION` is bumped manually when the on-the-wire
 * shape of cached values changes in a way that makes old entries
 * unreadable (e.g., a field removed from a summary type). NOT tied
 * to the package version — patch releases can ship cache-shape
 * changes; minor releases can be cache-compatible. Manual bumping
 * keeps the trigger explicit.
 */
import { createHash } from 'node:crypto'
import { encodeRefName } from '../hash.js'

/**
 * Bump when the shape of cached values changes incompatibly. Old
 * entries with a mismatched prefix are inaccessible and eventually
 * evicted by LRU.
 */
export const CACHE_SCHEMA_VERSION = 1

/**
 * Maximum stored key length. 255 matches filesystem-provider key-as-
 * filename ergonomics for future `FileCache` providers; safely under
 * Redis's 512MB cap and Azure's 250-char path limits.
 */
const MAX_KEY_LENGTH = 255

/** sha256 hex prefix length used for overflow hashing. */
const OVERFLOW_HASH_LENGTH = 8

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

/**
 * Apply the version + overflow-hash policy to a consumer-encoded key.
 * Provider-internal — consumers don't see the result; they pass clean
 * keys to `cache.get/set/invalidate`, and the provider wraps before
 * storing or looking up.
 *
 * Two transforms:
 *   1. Prepend `{CACHE_SCHEMA_VERSION}:` so a schema bump invalidates
 *      every entry across the process atomically.
 *   2. If the wrapped key exceeds `MAX_KEY_LENGTH`, keep everything up
 *      to the last `:` boundary that fits in `MAX_KEY_LENGTH - 9`
 *      chars, then append `:{8-char-sha256}`. Prefix-invalidation
 *      still works on the kept prefix; only the tail is opaque.
 *
 * Examples:
 *   applyKeyPolicy('pages:detail:home') → '1:pages:detail:home'
 *   applyKeyPolicy(very-long-key) →
 *     '1:pages:detail:long-prefix-portion:{hash8}'
 */
export function applyKeyPolicy(consumerKey: string): string {
  const versioned = `${CACHE_SCHEMA_VERSION}:${consumerKey}`
  if (versioned.length <= MAX_KEY_LENGTH) return versioned

  // Need to overflow. Reserve OVERFLOW_HASH_LENGTH + 1 (for the
  // ':' separator) at the tail; cut the prefix at the last ':' that
  // fits in the remaining budget.
  const reserve = OVERFLOW_HASH_LENGTH + 1
  const budget = MAX_KEY_LENGTH - reserve

  // Find the last ':' at or before `budget` so prefix matches still
  // align with consumer-visible component boundaries.
  let cut = versioned.lastIndexOf(':', budget)
  // Always at least the version prefix is present (`1:`); cut > 0
  // here because versioned.length > MAX_KEY_LENGTH > budget > 1.
  if (cut <= 0) {
    // Pathological: no ':' in budget. Hard-cut at budget. Prefix
    // invalidation degrades to "first N chars" rather than aligning
    // to component boundaries, but keys this dense are unusual.
    cut = budget
  }

  const kept = versioned.slice(0, cut)
  const tail = versioned.slice(cut)
  const hash = createHash('sha256').update(tail).digest('hex').slice(0, OVERFLOW_HASH_LENGTH)
  return `${kept}:${hash}`
}

/**
 * Apply the version prefix to a `invalidatePrefix()` argument.
 * Provider-internal. Distinct from `applyKeyPolicy` because prefixes
 * are not capped or hashed — `invalidatePrefix('pages:')` should
 * match every stored `'1:pages:...'` key, not just keys that happen
 * to fit under `MAX_KEY_LENGTH`. The cap-and-hash policy on `set/get`
 * keeps long keys lookupable; prefix invalidation operates on the
 * first chars, which the policy preserves verbatim up to the cap.
 */
export function applyPrefixPolicy(consumerPrefix: string): string {
  return `${CACHE_SCHEMA_VERSION}:${consumerPrefix}`
}
