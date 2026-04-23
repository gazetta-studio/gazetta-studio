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
  | 'ASSET_IN_USE'
  | 'ASSET_MIME_UNSUPPORTED'

/**
 * `AssetRef` is owned by `./refs.ts` (single source of truth, Zod
 * schema + inferred type). Re-exported here for the error class that
 * carries refs as structured data. Other consumers import from `./refs`
 * directly.
 */
export type { AssetRef } from './refs.js'
import type { AssetRef } from './refs.js'

/**
 * Every asset error maps to exactly one HTTP status. Declaring it on the
 * class — not in every route handler — means adding a new error subclass
 * requires no route-handler changes (OCP). Kept as a type union rather
 * than `number` so that a typo at the class level fails to compile.
 */
export type AssetErrorHttpStatus = 400 | 404 | 409 | 500 | 501

/**
 * JSON body shape for `AssetError.toResponseBody()`. Every response body
 * has at least `{ code, message }`; structured subclasses (AssetInUseError,
 * AssetValidationError) override `toResponseBody()` to attach extra fields.
 *
 * The admin client's Zod schemas (`admin-api/schemas/assets.ts`) parse the
 * body into typed responses; drift between server serialization and client
 * parsing is a compile-time error.
 */
export interface AssetErrorResponseBody {
  readonly code: AssetErrorCode
  readonly message: string
  // Subclasses may attach extra fields; see AssetInUseError.
  readonly [extra: string]: unknown
}

export abstract class AssetError extends Error {
  abstract readonly code: AssetErrorCode
  /** HTTP status this error maps to at the transport boundary. */
  abstract readonly httpStatus: AssetErrorHttpStatus

  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }

  /**
   * Serialize this error to a JSON response body. Default shape is
   * `{ code, message }`; subclasses override to add structured data.
   * Transport-boundary polymorphism — no `instanceof` chain needed at
   * the route mapper.
   */
  toResponseBody(): AssetErrorResponseBody {
    return { code: this.code, message: this.message }
  }
}

/** Input bytes failed upload-time validation — wrong MIME, bad name, too large, etc. */
export class AssetValidationError extends AssetError {
  readonly code: AssetErrorCode
  readonly httpStatus = 400 as const
  constructor(
    code: Exclude<
      AssetErrorCode,
      | 'ASSET_PROVIDER_NOT_CAPABLE'
      | 'ASSET_STORAGE_FAILURE'
      | 'ASSET_MANIFEST_CORRUPT'
      | 'ASSET_MANIFEST_NOT_FOUND'
      | 'ASSET_IN_USE'
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
  readonly httpStatus = 501 as const
  constructor(detail: string) {
    super(`Storage provider does not support binary streaming: ${detail}`)
  }
}

/** Wraps an underlying storage-layer failure during an asset operation. */
export class AssetStorageError extends AssetError {
  readonly code = 'ASSET_STORAGE_FAILURE' as const
  readonly httpStatus = 500 as const
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
  readonly httpStatus = 500 as const
  constructor(path: string, cause: unknown) {
    super(`Asset manifest corrupt at ${path}: ${(cause as Error)?.message ?? cause}`)
  }
}

/** Manifest file missing — asset name doesn't exist on this target. */
export class AssetManifestNotFoundError extends AssetError {
  readonly code = 'ASSET_MANIFEST_NOT_FOUND' as const
  readonly httpStatus = 404 as const
  constructor(name: string) {
    super(`Asset not found: ${name}`)
  }
}

/**
 * Delete was attempted on an asset that pages or fragments still reference.
 * The design doc's delete-blocked contract: surface the usage list so the
 * author can rewrite refs or pick a replacement. `refs` is attached as
 * structured data — HTTP layer serializes it into the 409 response body.
 */
export class AssetInUseError extends AssetError {
  readonly code = 'ASSET_IN_USE' as const
  readonly httpStatus = 409 as const
  constructor(
    public readonly assetName: string,
    public readonly refs: readonly AssetRef[],
  ) {
    super(`Asset "${assetName}" is still referenced by ${refs.length} item(s)`)
  }

  override toResponseBody(): AssetErrorResponseBody {
    return {
      code: this.code,
      message: this.message,
      assetName: this.assetName,
      refs: this.refs,
    }
  }
}

/**
 * Manifest MIME has no known extension mapping, so path enumeration
 * can't be completed. Operations that need the full path set (delete,
 * rename, GC) can't proceed. Distinct from validation failure (the
 * manifest is fine — we just don't know how to lay out bytes for this
 * MIME) and from storage failure (nothing failed I/O).
 *
 * In practice, reaching this means a new kind was added without
 * extending `url.ts#extFromMime` — the type points at exactly what
 * needs a fix.
 */
export class AssetMimeUnsupportedError extends AssetError {
  readonly code = 'ASSET_MIME_UNSUPPORTED' as const
  readonly httpStatus = 500 as const
  constructor(
    public readonly mime: string,
    public readonly assetName: string,
  ) {
    super(`MIME "${mime}" has no extension mapping (asset "${assetName}")`)
  }
}
