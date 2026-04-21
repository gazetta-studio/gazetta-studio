/**
 * Typed errors for the asset domain.
 *
 * Every asset-domain failure is one of these classes — never a plain
 * `new Error('not implemented')`. Callers pattern-match on the class to
 * decide what to do (HTTP status, CLI exit code, retry policy, user
 * message). Subclassing keeps the public error taxonomy small and stable.
 *
 * The `code` property is the machine-readable identifier. Messages are
 * human-readable and may include path/name details; tests should match
 * on `code`, not on message text.
 */

export type AssetErrorCode =
  | 'ASSET_VALIDATION_FAILED'
  | 'ASSET_MIME_MISMATCH'
  | 'ASSET_SIZE_EXCEEDED'
  | 'ASSET_NAME_INVALID'
  | 'ASSET_NAME_RESERVED'
  | 'ASSET_PATH_TRAVERSAL'
  | 'ASSET_PROVIDER_NOT_CAPABLE'
  | 'ASSET_STORAGE_FAILURE'
  | 'ASSET_MANIFEST_CORRUPT'
  | 'ASSET_MANIFEST_NOT_FOUND'

abstract class AssetError extends Error {
  abstract readonly code: AssetErrorCode
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

/** Input bytes failed upload-time validation — wrong MIME, bad name, too large, etc. */
export class AssetValidationError extends AssetError {
  readonly code: AssetErrorCode
  constructor(
    code: Exclude<
      AssetErrorCode,
      'ASSET_PROVIDER_NOT_CAPABLE' | 'ASSET_STORAGE_FAILURE' | 'ASSET_MANIFEST_CORRUPT' | 'ASSET_MANIFEST_NOT_FOUND'
    >,
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

/**
 * The target's storage provider doesn't support binary streaming. Distinct from
 * validation (nothing's wrong with the bytes) and storage failure (the storage
 * didn't fail — it simply can't stream). Maps to 501 at the HTTP layer or a
 * clear CLI error.
 */
export class AssetProviderNotCapableError extends AssetError {
  readonly code = 'ASSET_PROVIDER_NOT_CAPABLE' as const
  constructor(detail: string) {
    super(`Storage provider does not support binary streaming: ${detail}`)
  }
}

/** Wraps an underlying storage-layer failure during an asset operation. */
export class AssetStorageError extends AssetError {
  readonly code = 'ASSET_STORAGE_FAILURE' as const
  constructor(
    public readonly operation: 'read' | 'write' | 'delete' | 'stat',
    public readonly path: string,
    cause: unknown,
  ) {
    super(`Storage ${operation} failed for ${path}: ${(cause as Error)?.message ?? cause}`)
  }
}

/** Manifest JSON couldn't be parsed. */
export class AssetManifestCorruptError extends AssetError {
  readonly code = 'ASSET_MANIFEST_CORRUPT' as const
  constructor(path: string, cause: unknown) {
    super(`Asset manifest corrupt at ${path}: ${(cause as Error)?.message ?? cause}`)
  }
}

/** Manifest file missing — asset name doesn't exist on this target. */
export class AssetManifestNotFoundError extends AssetError {
  readonly code = 'ASSET_MANIFEST_NOT_FOUND' as const
  constructor(name: string) {
    super(`Asset not found: ${name}`)
  }
}
