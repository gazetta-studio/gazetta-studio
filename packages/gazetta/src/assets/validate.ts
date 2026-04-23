/**
 * Asset-upload validation policy. Pure — takes a candidate (name, claimed
 * size, claimed MIME, sniffed MIME) and throws a typed validation error on
 * the first failure. No I/O, no storage, no network.
 *
 * Keeping this pure means:
 * - Tests are trivial: pass candidate data in, assert the thrown class
 * - The same policy applies whether the caller is the HTTP route, a CLI
 *   import command, or the future paste-URL handler
 * - Policy evolves in one place
 *
 * Each validation failure throws a distinct `AssetValidationError`
 * subclass (`AssetNameInvalidError`, `AssetPathTraversalError`, etc.).
 * Callers that want to group all input-validation failures uniformly can
 * still pattern-match on the base `AssetValidationError`.
 */
import {
  AssetMimeMismatchError,
  AssetNameInvalidError,
  AssetNameReservedError,
  AssetPathTraversalError,
  AssetSizeExceededError,
} from './errors.js'

/** v1 size limit — 50 MB. Tunable per site in a later step. */
export const ASSET_MAX_BYTES = 50 * 1024 * 1024

/** v1 MIME allowlist — images only for the narrow slice. Wide rollout expands. */
export const ALLOWED_MIMES = new Set<string>(['image/jpeg', 'image/png'])

/** Asset-name validation: lowercase ASCII-safe characters. */
const VALID_NAME = /^[a-z0-9][a-z0-9\-_]*(?:\.[a-z0-9]+)?$/
/** Max chars per asset name. */
const MAX_NAME_LENGTH = 200

/** Reserved name patterns — authors can't upload anything that would collide with internals. */
const RESERVED_PREFIXES = ['.', '_refs/', '.gazetta/']
const RESERVED_SUFFIXES = ['.asset.json']

export interface UploadCandidate {
  /** Desired asset name (what the author chose, pre-slug). */
  name: string
  /** Bytes received so far; the stream is still flowing. */
  claimedSize: number
  /** MIME sniffed from the bytes. Null when sniffing failed. */
  sniffedMime: string | null
}

/**
 * Validate an upload candidate against the v1 policy. Throws the
 * specific `AssetValidationError` subclass for the first failure
 * encountered — policy enforces fail-fast so the HTTP route returns a
 * single, specific reason to the client.
 */
export function validateUpload(candidate: UploadCandidate): void {
  assertName(candidate.name)
  assertSize(candidate.claimedSize)
  assertMime(candidate.sniffedMime, candidate.name)
}

function assertName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new AssetNameInvalidError(name, `Asset name must be 1–${MAX_NAME_LENGTH} characters (got ${name.length})`)
  }

  // Path-traversal: `..`, leading `/`, or backslash anywhere
  if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
    throw new AssetPathTraversalError(name)
  }

  // Reserved prefixes and suffixes
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new AssetNameReservedError(name, prefix, 'prefix')
    }
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (name.endsWith(suffix)) {
      throw new AssetNameReservedError(name, suffix, 'suffix')
    }
  }

  // Character rules (lowercase ASCII, digits, hyphens, underscores, optional extension)
  if (!VALID_NAME.test(name)) {
    throw new AssetNameInvalidError(
      name,
      `Asset name must be lowercase ASCII letters/digits/hyphens/underscores with optional extension: ${name}`,
    )
  }
}

function assertSize(claimedSize: number): void {
  if (claimedSize <= 0 || claimedSize > ASSET_MAX_BYTES) {
    throw new AssetSizeExceededError(claimedSize, ASSET_MAX_BYTES)
  }
}

function assertMime(sniffedMime: string | null, name: string): void {
  const allowed = [...ALLOWED_MIMES]
  if (!sniffedMime) {
    throw new AssetMimeMismatchError(
      null,
      allowed,
      `Could not detect MIME type from bytes for "${name}"; v1 slice accepts images only (JPEG, PNG)`,
    )
  }
  if (!ALLOWED_MIMES.has(sniffedMime)) {
    throw new AssetMimeMismatchError(
      sniffedMime,
      allowed,
      `MIME ${sniffedMime} not allowed in v1 slice (allowed: ${allowed.join(', ')})`,
    )
  }
}
