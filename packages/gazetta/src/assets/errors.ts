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
  | 'ASSET_STORAGE_FAILURE'
  | 'ASSET_MANIFEST_CORRUPT'
  | 'ASSET_MANIFEST_NOT_FOUND'
  | 'ASSET_IN_USE'
  | 'ASSET_MIME_UNSUPPORTED'
  | 'ASSET_KIND_MISMATCH'
  | 'ASSET_NAME_COLLISION'
  | 'ASSET_VARIANT_GENERATION_FAILED'

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
export type AssetErrorHttpStatus = 400 | 404 | 409 | 500

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

/**
 * Upload-validation failure hierarchy.
 *
 * Each concrete reason a candidate can be rejected is its own class. No
 * god-class taking a polymorphic `code` argument — the class itself is
 * the reason. Benefits (SOLID):
 *
 *   - SRP: each class has one reason to change.
 *   - OCP: adding a new validation reason = new class, no edits to
 *     existing ones; the httpStatus (400) is inherited.
 *   - LSP: every subclass fully honors `AssetValidationError` — an
 *     `instanceof AssetValidationError` check still groups them.
 *   - ISP: callers that only care about "was this input-invalid?" match
 *     the base class; callers that branch on specific reasons use the
 *     concrete subclass.
 *
 * The `AssetValidationError` base stays as the umbrella for callers that
 * treat all input-validation failures uniformly (HTTP always maps to 400).
 */
export abstract class AssetValidationError extends AssetError {
  readonly httpStatus = 400 as const
}

/** Asset name failed character / length rules. */
export class AssetNameInvalidError extends AssetValidationError {
  readonly code = 'ASSET_NAME_INVALID' as const
  constructor(
    public readonly name: string,
    message: string,
  ) {
    super(message)
  }
}

/** Asset name attempted path traversal (`..`, leading `/`, backslash). */
export class AssetPathTraversalError extends AssetValidationError {
  readonly code = 'ASSET_PATH_TRAVERSAL' as const
  constructor(public readonly name: string) {
    super(`Asset name contains path traversal: ${name}`)
  }
}

/** Asset name collides with a reserved prefix or suffix. */
export class AssetNameReservedError extends AssetValidationError {
  readonly code = 'ASSET_NAME_RESERVED' as const
  constructor(
    public readonly name: string,
    public readonly reservedToken: string,
    public readonly position: 'prefix' | 'suffix',
  ) {
    super(`Asset name reserved (${position} "${reservedToken}"): ${name}`)
  }
}

/** Asset bytes exceed the configured size limit, or claimed size is zero. */
export class AssetSizeExceededError extends AssetValidationError {
  readonly code = 'ASSET_SIZE_EXCEEDED' as const
  constructor(
    public readonly claimedSize: number,
    public readonly maxBytes: number,
  ) {
    super(
      claimedSize <= 0
        ? 'Asset size must be greater than 0'
        : `Asset exceeds size limit (${claimedSize} bytes > ${maxBytes} bytes)`,
    )
  }
}

/**
 * Sniffed MIME is absent or not in the allowlist. The class owns its own
 * message construction — no caller passes a pre-baked string. Two distinct
 * failure reasons share the same `code` because they're the same error
 * semantically ("the MIME isn't usable"): distinguishable by inspecting
 * `sniffedMime === null` vs set.
 */
export class AssetMimeMismatchError extends AssetValidationError {
  readonly code = 'ASSET_MIME_MISMATCH' as const
  constructor(
    public readonly sniffedMime: string | null,
    public readonly allowedMimes: readonly string[],
  ) {
    super(buildMimeMismatchMessage(sniffedMime, allowedMimes))
  }
}

function buildMimeMismatchMessage(sniffedMime: string | null, allowedMimes: readonly string[]): string {
  const allowed = allowedMimes.length > 0 ? ` (allowed: ${allowedMimes.join(', ')})` : ''
  if (sniffedMime === null) return `Could not detect MIME type from bytes${allowed}`
  return `MIME "${sniffedMime}" not allowed${allowed}`
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
    // Spread the base `{ code, message }` so future base-class fields
    // (e.g. a request id) flow through automatically.
    return {
      ...super.toResponseBody(),
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

/**
 * Responsive-variant generation failed during upload ingest. The original
 * bytes passed MIME sniffing and dimension extraction but sharp could not
 * resize them — usually means truncation, corruption, or a decompression-
 * bomb that sharp declined to decode. The ingest pipeline rolls back the
 * main-bytes write on this error so the upload fails atomically. HTTP
 * 400 (client-correctable: re-upload a non-broken image).
 *
 * Distinct from `AssetMimeMismatchError` (MIME-sniff rejection) because
 * the file may be a legitimate JPEG/PNG on paper — we only discovered
 * the problem once sharp tried to do real work with the pixels.
 */
export class AssetVariantGenerationError extends AssetError {
  readonly code = 'ASSET_VARIANT_GENERATION_FAILED' as const
  readonly httpStatus = 400 as const
  constructor(
    public readonly assetName: string,
    cause: unknown,
  ) {
    super(`Could not generate responsive variants for "${assetName}": ${(cause as Error)?.message ?? cause}`)
  }
}

/**
 * Rename was attempted to a name that's already taken by another asset.
 * Per design-media.md → Rename: copying onto an existing asset would
 * silently merge two distinct assets into one — the operation refuses
 * instead. Authors who genuinely want to merge use replace-and-delete
 * (different verb, explicit kind-compat check). HTTP 409.
 */
export class AssetNameCollisionError extends AssetError {
  readonly code = 'ASSET_NAME_COLLISION' as const
  readonly httpStatus = 409 as const
  constructor(public readonly newName: string) {
    super(`Asset name already in use: ${newName}`)
  }

  override toResponseBody(): AssetErrorResponseBody {
    return {
      ...super.toResponseBody(),
      newName: this.newName,
    }
  }
}

/**
 * Replace was attempted between two assets whose kinds (or within
 * `embedded`, MIME categories) don't match. Per design-media.md →
 * Delete semantics: "same kind (embedded ↔ embedded, downloadable ↔
 * downloadable). Within embedded, cross-subtype is blocked
 * (image ≠ video)."
 *
 * Carries structured fields so the UI can render a specific message
 * ("image → video not allowed") without parsing the human message.
 */
export class AssetKindMismatchError extends AssetError {
  readonly code = 'ASSET_KIND_MISMATCH' as const
  readonly httpStatus = 409 as const
  constructor(
    public readonly oldKind: string,
    public readonly oldMimeCategory: string,
    public readonly newKind: string,
    public readonly newMimeCategory: string,
  ) {
    super(
      `Replacement asset kind/category mismatch: old=${oldKind}/${oldMimeCategory}, new=${newKind}/${newMimeCategory}`,
    )
  }

  override toResponseBody(): AssetErrorResponseBody {
    return {
      ...super.toResponseBody(),
      oldKind: this.oldKind,
      oldMimeCategory: this.oldMimeCategory,
      newKind: this.newKind,
      newMimeCategory: this.newMimeCategory,
    }
  }
}
